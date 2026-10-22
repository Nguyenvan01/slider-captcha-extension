const $ = (id) => document.getElementById(id);
const DEF = globalThis.SCX_DEFAULT_CONFIG;
const status = (t, bad) => { $('status').textContent = t; $('status').style.color = bad ? 'var(--bad)' : ''; };

async function load() {
  const c = Object.assign(JSON.parse(JSON.stringify(DEF)), await chrome.storage.sync.get(null));
  $('hosts').value = (c.hosts || []).join('\n');
  $('dragMode').value = c.dragMode;
  $('enabled').checked = c.enabled;
  $('autoDetect').checked = c.autoDetect;
  $('debug').checked = c.debug;
  $('maxRetry').value = c.maxRetry;
  $('profiles').value = JSON.stringify(c.profiles, null, 2);
}

const PATTERN = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;

async function save() {
  const hosts = $('hosts').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const badHost = hosts.find((h) => !PATTERN.test(h));
  if (badHost) return status(`Pattern không hợp lệ: ${badHost}`, true);
  let profiles;
  try { profiles = JSON.parse($('profiles').value); if (!Array.isArray(profiles)) throw new Error('phải là mảng'); }
  catch (e) { return status('JSON cấu hình captcha lỗi: ' + e.message, true); }
  const dragMode = $('dragMode').value;

  // xin quyền ngay trong thao tác bấm nút (yêu cầu của Chrome); "debugger" không được phép là quyền tuỳ chọn nên khai báo sẵn trong manifest
  let granted = true;
  try { if (hosts.length) granted = await chrome.permissions.request({ origins: hosts }); }
  catch (e) { return status('Không xin được quyền: ' + e.message, true); }

  await chrome.storage.sync.set({
    hosts, dragMode, profiles,
    enabled: $('enabled').checked, autoDetect: $('autoDetect').checked, debug: $('debug').checked,
    maxRetry: Math.max(0, Math.min(10, +$('maxRetry').value || 0)),
  });
  const r = await chrome.runtime.sendMessage({ type: 'syncScripts' });
  status(granted ? `Đã lưu. Đang chạy trên ${r && r.allowed ? r.allowed.length : 0} mẫu trang.` : 'Đã lưu, nhưng một số quyền chưa được cấp.');
}

$('save').onclick = save;
$('reset').onclick = async () => {
  const { hosts } = await chrome.storage.sync.get({ hosts: [] });
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set({ hosts });
  await load(); status('Đã khôi phục mặc định (giữ danh sách trang).');
};
load();
