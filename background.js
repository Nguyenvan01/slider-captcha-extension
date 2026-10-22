/*
 * Service worker: đăng ký content script theo danh sách trang người dùng cho phép,
 * đổi badge, tải ảnh khác origin, và phát sự kiện chuột qua chrome.debugger (chế độ CDP).
 */
importScripts('config.js');

const CS_ID = 'scx-auto';
const CS_FILES = ['config.js', 'solver/core.js', 'drag/track.js', 'drag/drivers.js', 'content.js'];

async function getConfig() {
  const s = await chrome.storage.sync.get(null);
  return Object.assign(JSON.parse(JSON.stringify(self.SCX_DEFAULT_CONFIG)), s);
}

/** Đăng ký lại content script cho các host đã được cấp quyền */
async function syncContentScripts() {
  const { hosts = [] } = await getConfig();
  const allowed = [];
  for (const h of hosts) {
    try { if (await chrome.permissions.contains({ origins: [h] })) allowed.push(h); } catch (e) { /* pattern sai */ }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CS_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] });
  if (allowed.length) {
    await chrome.scripting.registerContentScripts([{
      id: CS_ID, matches: allowed, js: CS_FILES, allFrames: true, runAt: 'document_idle', persistAcrossSessions: true,
    }]);
  }
  return allowed;
}

chrome.runtime.onInstalled.addListener(syncContentScripts);
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.hosts) syncContentScripts(); });
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

function toBase64(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- CDP ----
const attached = new Set();
async function cdp(tabId, action, x, y) {
  if (!chrome.debugger) throw new Error('Chưa cấp quyền "debugger". Bật chế độ CDP trong trang Tuỳ chọn.');
  const target = { tabId };
  if (action === 'attach') {
    if (!attached.has(tabId)) { await chrome.debugger.attach(target, '1.3'); attached.add(tabId); }
    return;
  }
  if (action === 'detach') {
    if (attached.has(tabId)) { attached.delete(tabId); await chrome.debugger.detach(target).catch(() => {}); }
    return;
  }
  const params = { type: action, x, y, button: 'left', buttons: action === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' };
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params);
}
if (chrome.debugger) chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  (async () => {
    switch (msg && msg.type) {
      case 'badge':
        if (tab) {
          await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: msg.ok ? '#15803d' : '#b91c1c' });
          await chrome.action.setBadgeText({ tabId: tab.id, text: msg.ok ? '✓' : '!' });
        }
        return { ok: true };
      case 'fetchImage': {
        // credentials:'include' bị CORS chặn với server trả Access-Control-Allow-Origin: * -> thử lại không cookie
        const opt = () => ({ signal: AbortSignal.timeout(10000) });   // không để content script chờ mãi
        const r = await fetch(msg.url, { credentials: 'include', ...opt() }).catch(() => fetch(msg.url, { credentials: 'omit', ...opt() }));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const type = r.headers.get('content-type') || 'image/png';
        return { ok: true, dataUrl: `data:${type};base64,${toBase64(await r.arrayBuffer())}` };
      }
      case 'cdp':
        if (!tab) throw new Error('không rõ tab');
        await cdp(tab.id, msg.action, msg.x, msg.y);
        return { ok: true };
      case 'syncScripts': return { ok: true, allowed: await syncContentScripts() };
      case 'files': return { ok: true, files: CS_FILES };
      default: return null;
    }
  })().then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
