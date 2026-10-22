const $ = (id) => document.getElementById(id);
const FILES = ['config.js', 'solver/core.js', 'drag/track.js', 'drag/drivers.js', 'content.js'];

let tab, pattern;

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null; try { url = new URL(tab.url); } catch (e) { /* bỏ qua */ }
  if (!url || !/^https?:$/.test(url.protocol)) {
    $('host').textContent = 'Trang không hỗ trợ';
    $('toggleSite').textContent = 'Chỉ chạy trên trang http/https';
    $('toggleSite').disabled = true;
    return;
  }
  $('host').textContent = $('host').title = url.host;
  pattern = `${url.protocol}//${url.hostname}/*`;
  $('toggleSite').onclick = toggleSite;
  await renderSite();
}

async function siteOn() {
  const { hosts = [], enabled = true } = await chrome.storage.sync.get({ hosts: [], enabled: true });
  return enabled && hosts.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] });
}

async function renderSite() {
  const on = await siteOn();
  document.body.classList.toggle('on', on);
  $('toggleSite').textContent = on ? '■ Đang tự động chạy · bấm để tắt' : '▶ Tự động chạy trên trang này';
  $('toggleSite').setAttribute('aria-pressed', on);
}

async function toggleSite() {
  const { hosts = [] } = await chrome.storage.sync.get({ hosts: [] });
  if (await siteOn()) {
    await chrome.storage.sync.set({ hosts: hosts.filter((h) => h !== pattern) });
    await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
  } else {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) return;
    if (!hosts.includes(pattern)) hosts.push(pattern);
    // popup không còn công tắc toàn cục, nên bật trang thì bật luôn tiện ích
    await chrome.storage.sync.set({ hosts, enabled: true });
    await chrome.runtime.sendMessage({ type: 'syncScripts' });
    await inject();   // chạy ngay, khỏi tải lại trang
  }
  renderSite();
}

async function inject() {
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: FILES }); }
  catch (e) { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES }); }
}

init();
