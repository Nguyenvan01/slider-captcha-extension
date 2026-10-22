/*
 * Content script: phát hiện captcha kéo mảnh ghép, đọc ảnh, tìm lỗ, kéo nút trượt (vòng kín),
 * kiểm tra kết quả và thử lại khi thất bại.
 * Phụ thuộc (nạp trước): config.js, solver/core.js, drag/track.js, drag/drivers.js
 */
(() => {
  if (window.__scxLoaded) return;
  window.__scxLoaded = true;

  const S = globalThis.SliderSolver, T = globalThis.SCXTrack, D = globalThis.SCXDrivers;
  const { sleep } = D, { rnd, rint } = T;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let cfg = clone(globalThis.SCX_DEFAULT_CONFIG);
  let busy = false;
  let preferCdp = false;               // DOM event bị bỏ qua => lần sau dùng CDP
  const handled = new Map();           // fingerprint ảnh nền -> lúc xử lý; hết hạn sau HANDLED_TTL
  // không nhớ vĩnh viễn: trang có thể dùng lại ảnh cũ hoặc cùng một URL ảnh => tự động sẽ im lặng dừng hẳn
  const HANDLED_TTL = 30000;
  const FETCH_TIMEOUT = 10000;         // tải ảnh treo thì cờ busy kẹt mãi
  const dbg = (...a) => cfg.debug && console.log('[SCX]', ...a);
  const log = (...a) => console.log('%c[SCX]', 'color:#2563eb;font-weight:bold', ...a);   // luôn bật, xem trong DevTools > Console

  async function loadConfig() {
    try {
      const s = await chrome.storage.sync.get(null);
      cfg = Object.assign(clone(globalThis.SCX_DEFAULT_CONFIG), s);
      if (!Array.isArray(cfg.profiles) || !cfg.profiles.length) cfg.profiles = clone(globalThis.SCX_DEFAULT_CONFIG.profiles);
    } catch (e) { /* trang không có quyền storage (hiếm) */ }
  }
  chrome.storage.onChanged.addListener(loadConfig);

  // ---------------- tìm captcha ----------------

  const isVisible = (el) => !!el && el.isConnected &&
    (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.offsetParent !== null) &&
    el.getBoundingClientRect().width > 1;

  const qs = (root, sel) => { if (!sel) return null; try { return root.querySelector(sel); } catch (e) { return null; } };
  const qsa = (root, sel) => { if (!sel) return []; try { return [...root.querySelectorAll(sel)]; } catch (e) { return []; } };

  function fromProfile(p) {
    for (const container of qsa(document, p.container)) {
      if (!isVisible(container)) continue;
      const bg = qsa(container, p.background).find(isVisible);
      const piece = qsa(container, p.piece).find((e) => e !== bg && isVisible(e));
      const handle = qsa(container, p.handle).find(isVisible);
      if (bg && piece && handle) return { profile: p, container, bg, piece, handle, refresh: qs(container, p.refresh) };
    }
    return null;
  }

  const GENERIC = {
    name: 'tự dò', ratio: 0,
    refresh: '[class*="refresh" i], [class*="reload" i], [title*="làm mới" i]',
    success: '[class*="success" i]', fail: '[class*="fail" i], [class*="error" i]',
  };

  /** Dò cấu trúc chung: ảnh nền lớn + mảnh ghép hẹp chồng lên + nút kéo bên dưới */
  // ponytail: ảnh nền dạng CSS chỉ bắt khi đặt inline (style=...), không hỗ trợ sprite background-position
  const IMG_SEL = 'canvas, img, [style*="background"]';
  const isImgLike = (e) => isMedia(e) || !!bgUrl(e);

  function autoDetect() {
    const imgs = qsa(document, IMG_SEL).filter((e) => isVisible(e) && isImgLike(e));
    const bgs = imgs.map((e) => [e, e.getBoundingClientRect()])
      .filter(([, r]) => r.width >= 120 && r.height >= 60 && r.width <= 900)
      .sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height);
    for (const [bg, br] of bgs) {
      let anc = bg.parentElement;
      for (let lvl = 0; anc && lvl < 8; lvl++, anc = anc.parentElement) {
        const piece = qsa(anc, IMG_SEL).find((e) => {
          if (e === bg || e.contains(bg) || !isVisible(e) || !isImgLike(e)) return false;
          const r = e.getBoundingClientRect();
          return r.width <= br.width * 0.45 && r.width >= 15 && r.left >= br.left - 4 && r.left <= br.left + br.width * 0.5 &&
            r.top >= br.top - 4 && r.bottom <= br.bottom + 4;
        });
        if (!piece) continue;
        const handle = qsa(anc, '*').filter((e) => {
          if (!isVisible(e) || e === bg || e === piece) return false;
          const r = e.getBoundingClientRect();
          if (!(r.top >= br.bottom - 12 && r.top <= br.bottom + 120 && r.width >= 20 && r.width <= 100 &&
            r.height >= 16 && r.height <= 100 && r.left <= br.left + 60)) return false;
          // nhận diện nút kéo qua tên class/id, không có thì qua con trỏ chuột
          return /slid|drag|handle|btn|button|arrow|move|knob|thumb/i.test((e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className) + ' ' + e.id) ||
            /pointer|move|grab/.test(getComputedStyle(e).cursor);
        }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left ||
          b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
        if (handle) return { profile: GENERIC, container: anc, bg, piece, handle, refresh: qs(anc, GENERIC.refresh) };
      }
    }
    return null;
  }

  function findCaptcha() {
    for (const p of cfg.profiles) { const c = fromProfile(p); if (c) return c; }
    return cfg.autoDetect ? autoDetect() : null;
  }

  // ---------------- đọc ảnh ----------------

  const isMedia = (el) => el instanceof HTMLCanvasElement || el instanceof HTMLImageElement;
  const bgUrl = (el) => { const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage); return m && m[1]; };

  function naturalSize(el) {
    if (el instanceof HTMLCanvasElement) return [el.width, el.height];
    if (el instanceof HTMLImageElement) return [el.naturalWidth, el.naturalHeight];
    const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];
  }

  /** Tải ảnh thành ImageBitmap (không bị CSP img-src chặn, không làm canvas tainted) */
  async function fetchAsImage(url) {
    let blob;
    try {
      // tải ngay trong trang trước: được với blob:, data:, cùng origin hoặc server cho CORS
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }); if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
    } catch (e) {
      log('tải ảnh trong trang lỗi, nhờ service worker:', url.slice(0, 120), e.message);
      const res = await chrome.runtime.sendMessage({ type: 'fetchImage', url });
      if (!res || !res.ok) {
        const origin = /^https?:/.test(url) ? new URL(url).origin : url.slice(0, 30);
        throw new Error(`Không tải được ảnh từ ${origin} (${res && res.error}). Nếu ảnh ở tên miền khác, thêm "${origin}/*" vào danh sách trang trong Tuỳ chọn.`);
      }
      const [head, b64] = res.dataUrl.split(',');
      blob = new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: head.slice(5).split(';')[0] });
    }
    try { return await createImageBitmap(blob); }
    catch (e) { throw new Error(`Ảnh tải về không giải mã được (${blob.type || '?'}, ${blob.size} byte) từ ${url.slice(0, 100)}`); }
  }

  /**
   * Vị trí/kích thước ảnh nền CSS bên trong phần tử (px hiển thị), theo background-size/position.
   * ponytail: bỏ qua border/padding (background-origin) và calc(); đủ cho các captcha thường gặp
   */
  function bgLayout(el, r, iw, ih) {
    const cs = getComputedStyle(el), first = (v) => v.split(',')[0].trim();
    const size = first(cs.backgroundSize).split(/\s+/);
    const len = (v, ref) => (!v || v === 'auto' ? null : v.endsWith('%') ? ref * parseFloat(v) / 100 : parseFloat(v));
    let w, h;
    if (size[0] === 'cover' || size[0] === 'contain') {
      const k = (size[0] === 'cover' ? Math.max : Math.min)(r.width / iw, r.height / ih); w = iw * k; h = ih * k;
    } else {
      w = len(size[0], r.width); h = len(size[1], r.height);
      if (w == null && h == null) { w = iw; h = ih; } else if (w == null) w = iw * h / ih; else if (h == null) h = ih * w / iw;
    }
    const off = (v, free) => (v.endsWith('%') ? free * parseFloat(v) / 100 : parseFloat(v) || 0);
    return [off(first(cs.backgroundPositionX), r.width - w), off(first(cs.backgroundPositionY), r.height - h), w, h];
  }

  async function toImageData(el, w, h) {
    const cv = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let dst = [0, 0, cv.width, cv.height];
    if (!isMedia(el)) {                          // ảnh nền CSS: vẽ đúng như trình duyệt hiển thị, không kéo giãn
      const url = bgUrl(el);
      if (!url) throw new Error(`${desc(el)} không có background-image`);
      const im = await fetchAsImage(url);
      const r = el.getBoundingClientRect(), k = cv.width / r.width;
      dst = bgLayout(el, r, im.width, im.height).map((v) => v * k);
      log('ảnh CSS', desc(el), `${im.width}x${im.height} -> vẽ tại`, dst.map((v) => +v.toFixed(1)));
      el = im;
    }
    try {
      ctx.drawImage(el, ...dst);
      return ctx.getImageData(0, 0, cv.width, cv.height);
    } catch (e) {
      // canvas bị "tainted" do ảnh khác origin: tải lại ảnh qua service worker
      if (el instanceof HTMLImageElement && (el.currentSrc || el.src)) {
        // canvas đã tainted thì không gỡ được, phải vẽ lên canvas mới
        const cv2 = new OffscreenCanvas(cv.width, cv.height), ctx2 = cv2.getContext('2d', { willReadFrequently: true });
        ctx2.drawImage(await fetchAsImage(el.currentSrc || el.src), ...dst);
        return ctx2.getImageData(0, 0, cv2.width, cv2.height);
      }
      throw new Error('Không đọc được pixel ảnh (canvas tainted): ' + e.message);
    }
  }

  function fingerprint(el) {
    if (!isMedia(el)) return bgUrl(el) || null;
    try {
      const cv = new OffscreenCanvas(16, 8), ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(el, 0, 0, 16, 8);
      const d = ctx.getImageData(0, 0, 16, 8).data; let h = 0, sum = 0;
      for (let i = 0; i < d.length; i++) { h = (h * 31 + (d[i] >> 3)) >>> 0; sum += d[i]; }
      return sum === 0 ? null : 'p' + h;          // null = chưa vẽ
    } catch (e) { return el.currentSrc || el.src || null; }
  }

  async function waitReady(c, timeout = 4000) {
    const t0 = Date.now(); let last = null, stable = 0;
    while (Date.now() - t0 < timeout) {
      // captcha dựng lại khung sau mỗi lần sai (phần tử cũ bị gỡ) -> tìm lại
      if (![c.bg, c.piece, c.handle].every((e) => e.isConnected)) {
        const n = findCaptcha(); if (n) { Object.assign(c, n); log('captcha được dựng lại, đã tìm lại phần tử'); }
        await sleep(150); continue;
      }
      if (c.bg instanceof HTMLImageElement && !(c.bg.complete && c.bg.naturalWidth)) { await sleep(100); continue; }
      if (c.piece instanceof HTMLImageElement && !(c.piece.complete && c.piece.naturalWidth)) { await sleep(100); continue; }
      const fp = fingerprint(c.bg) + '|' + fingerprint(c.piece);
      if (!fp.includes('null')) { if (fp === last) { if (++stable >= 2) return true; } else stable = 0; }
      last = fp; await sleep(120);
    }
    return false;
  }

  async function capture(c) {
    const br = c.bg.getBoundingClientRect(), pr = c.piece.getBoundingClientRect();
    const [nw, nh] = naturalSize(c.bg);
    const k = nw / br.width;                     // px ảnh nền / px hiển thị
    const bg = await toImageData(c.bg, nw, nh);
    const piece = await toImageData(c.piece, Math.round(pr.width * k), Math.round(pr.height * k));
    return { bg, piece, k, offset: { x: (pr.left - br.left) * k, y: (pr.top - br.top) * k }, bgRect: br };
  }

  // ---------------- kéo ----------------

  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  /**
   * Kéo vòng kín: theo dõi vị trí thật của mảnh ghép để tự hiệu chỉnh tỉ lệ nút/mảnh và căn chính xác.
   * @param dxDisp số px hiển thị mảnh ghép cần dịch sang phải
   */
  async function drag(c, dxDisp, mode) {
    const driver = mode === 'cdp' ? new D.CdpDriver() : new D.DomDriver(c.handle);
    const [cx, cy] = center(c.handle);
    const sx = cx + rnd(-4, 4), sy = cy + rnd(-4, 4);
    const pieceX = () => c.piece.getBoundingClientRect().left;
    const handleX = () => c.handle.getBoundingClientRect().left;
    const p0 = pieceX(), h0 = handleX(), target = p0 + dxDisp;
    const fixedRatio = c.profile.ratio > 0 ? c.profile.ratio : 0;   // px mảnh ghép / px chuột
    // chưa biết tỉ lệ thì chỉ kéo tới ~90% quãng đường, phần còn lại căn tinh khi mảnh ghép đã đứng yên:
    // kéo thiếu thì chỉnh tiếp được, kéo vượt thì mảnh ghép có thể kẹt ở mép
    const approach = fixedRatio ? 1 : 0.9;
    let ratio = fixedRatio || 1, total = approach * dxDisp / ratio, cur = 0, y = 0, moved = false;
    const track = T.makeTrack({ distance: total });
    const pts = [];                                          // [px chuột, px mảnh ghép] để ước lượng tỉ lệ
    // độ dốc bình phương tối thiểu: không bị lệch bởi cú nhảy/trễ lúc mảnh ghép bắt đầu chạy
    const slope = (ps) => {
      let n = 0, sx_ = 0, sy_ = 0, sxx = 0, sxy = 0;
      for (const [a, b] of ps) { n++; sx_ += a; sy_ += b; sxx += a * a; sxy += a * b; }
      const d = n * sxx - sx_ * sx_; return n >= 4 && d > 0 ? (n * sxy - sx_ * sy_) / d : 0;
    };
    // chờ mảnh ghép đứng yên (có trang dùng CSS transition nên vị trí cập nhật trễ)
    const settle = async () => {
      let a = pieceX();
      for (let i = 0; i < 12; i++) { await sleep(40); const b = pieceX(); if (Math.abs(b - a) < 0.2) return b; a = b; }
      return a;
    };
    try {
      await driver.down(sx, sy);
      await sleep(rint(40, 120));
      for (const st of track.steps) {
        await sleep(st.dt);
        cur = total * st.p; y = st.jy;
        await driver.move(sx + cur, sy + y);
        const dp = pieceX() - p0;
        if (Math.abs(dp) > 0.5) moved = true;
        if (cur > 8) pts.push([cur, dp]);
        // mảnh ghép thường chạy trễ sau chuột => tỉ lệ đo lúc đang kéo bị thấp hơn thật; chỉ dùng để tăng tỉ lệ
        if (!fixedRatio && cur > 20) {
          const r = slope(pts.slice(-12));
          if (r > ratio && r < 3) { ratio = r; total = Math.max(cur, cur + (approach * dxDisp - dp) / ratio); }
        }
        if (!moved && cur > 30) {
          const handleMoved = Math.abs(handleX() - h0) > 0.5;
          return { moved: false, handleMoved, err: dxDisp };
        }
      }
      // căn chỉnh tinh: đo sau khi mảnh ghép đứng yên, cập nhật tỉ lệ theo từng bước chỉnh
      let px = await settle();
      for (let i = 0; i < 12; i++) {
        const err = target - px;
        if (Math.abs(err) <= cfg.tolerancePx) break;
        const step = err / ratio;
        cur += step; y += rnd(-0.4, 0.4);
        await driver.move(sx + cur, sy + y);
        const nx = await settle();
        if (!fixedRatio && Math.abs(step) > 2 && Math.abs(nx - px) > 1) {
          const r = (nx - px) / step; if (r > 0.3 && r < 3) ratio = r;
        }
        log(`căn chỉnh ${i + 1}: lệch ${err.toFixed(1)}px -> ${(target - nx).toFixed(1)}px, tỉ lệ ${ratio.toFixed(3)}`);
        px = nx;
      }
      await sleep(track.holdMs);
      const err = target - pieceX();
      await driver.up(sx + cur, sy + y);
      log('mẫu [chuột, mảnh ghép]:', pts.map(([a, b]) => `${a.toFixed(0)},${b.toFixed(0)}`).join(' '));
      return { moved: true, err: +err.toFixed(2), ratio: +ratio.toFixed(3) };
    } finally {
      await driver.close();
    }
  }

  // ---------------- kết quả ----------------

  const anyVisible = (c, sel) => {
    if (!sel) return false;
    try { if (c.container.matches(sel)) return true; } catch (e) { return false; }
    return qsa(c.container, sel).some(isVisible);
  };

  async function waitResult(c, fp0) {
    const t0 = Date.now();
    while (Date.now() - t0 < cfg.resultTimeoutMs) {
      await sleep(100);
      if (!isVisible(c.container) || !isVisible(c.bg)) return 'success';
      if (anyVisible(c, c.profile.success)) return 'success';
      if (anyVisible(c, c.profile.fail)) return 'fail';
      const fp = fingerprint(c.bg);
      if (fp && fp !== fp0) return 'refreshed';
    }
    return 'unknown';
  }

  // ---------------- giao diện phụ ----------------

  function toast(msg, ok) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = `position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:8px 12px;border-radius:8px;
      font:13px/1.4 system-ui,sans-serif;color:#fff;background:${ok ? '#15803d' : '#b91c1c'};box-shadow:0 4px 14px rgba(0,0,0,.25)`;
    document.documentElement.appendChild(d); setTimeout(() => d.remove(), 2600);
  }

  function markHole(cap, r) {
    const b = cap.bgRect, k = cap.k, box = document.createElement('div');
    box.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ef4444;
      left:${b.left + r.x / k - 2}px;top:${b.top + r.y / k - 2}px;width:${r.bbox.w / k}px;height:${r.bbox.h / k}px`;
    document.documentElement.appendChild(box); setTimeout(() => box.remove(), 1500);
  }

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  // ---------------- điều phối ----------------

  const desc = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '') : '-';

  async function attempt(c, mode) {
    let step = 'chờ ảnh tải';
    try {
      log(`[${mode}] tìm thấy captcha (${c.profile.name}): nền=${desc(c.bg)} mảnh=${desc(c.piece)} nút=${desc(c.handle)}`, c);
      if (!(await waitReady(c))) { log('ảnh chưa tải xong / chưa vẽ sau 4s'); return { status: 'notReady', mode }; }
      await sleep(rint(cfg.startDelayMs[0], cfg.startDelayMs[1]));
      // captcha có thể đang thay ảnh trong lúc chờ
      if (!fingerprint(c.bg) || !fingerprint(c.piece)) { log('ảnh bị gỡ/thay trong lúc chờ'); return { status: 'notReady', mode }; }
      const els = `nền=${desc(c.bg)} mảnh=${desc(c.piece)} nút=${desc(c.handle)}`;
      const t0 = performance.now();
      step = 'đọc pixel ảnh';
      const cap = await capture(c);
      log(`ảnh nền ${cap.bg.width}x${cap.bg.height}, mảnh ${cap.piece.width}x${cap.piece.height}, k=${cap.k.toFixed(3)}, offset`, cap.offset);
      step = 'tìm lỗ';
      const r = S.solve(cap.bg, cap.piece, cap.offset);
      const solveMs = Math.round(performance.now() - t0);
      if (cfg.debug) markHole(cap, r);
      const dxDisp = r.dx / cap.k;
      log(`lỗ x=${r.x}, cần kéo ${dxDisp.toFixed(1)}px, tin cậy=${r.confidence}, ${solveMs}ms`, r);
      const fp0 = fingerprint(c.bg);
      step = 'kéo';
      const d = await drag(c, dxDisp, mode);
      log('kéo xong', d);
      step = 'chờ kết quả';
      const status = d.moved ? await waitResult(c, fp0) : (d.handleMoved ? 'pieceStuck' : 'ignored');
      log('kết quả:', status);
      return { status, els, holeX: r.x, dx: r.dx, dxDisp: +dxDisp.toFixed(1), confidence: r.confidence, ncc: r.ncc,
        finalErr: d.err, ratio: d.ratio, solveMs, mode };
    } catch (e) {
      console.error('[SCX] lỗi ở bước', step, e);
      throw new Error(`${step}: ${e.message}`);
    }
  }

  async function run(c, manual = false) {
    if (busy) return { ok: false, error: 'đang giải' };
    busy = true;
    const results = [];
    let domRejected = 0;                 // kéo đúng chỗ bằng DOM mà vẫn bị từ chối
    try {
      for (let i = 0; i <= cfg.maxRetry; i++) {
        let mode = cfg.dragMode === 'cdp' || (cfg.dragMode === 'auto' && preferCdp) ? 'cdp' : 'dom';
        let res;
        try { res = await attempt(c, mode); } catch (e) { res = { status: 'error', error: e.message, mode }; }
        if (res.status === 'ignored' && cfg.dragMode === 'auto' && mode === 'dom') {
          preferCdp = true;                              // sự kiện giả bị bỏ qua (isTrusted) -> thử CDP ngay
          try { res = await attempt(c, 'cdp'); } catch (e) { res = { status: 'error', error: e.message, mode: 'cdp' }; }
        }
        res.try = i + 1; res.profile = c.profile.name; res.host = location.host; res.time = Date.now();
        results.push(res);
        send({ type: 'log', entry: res });
        dbg('kết quả', res);
        if (res.status === 'success' || res.status === 'unknown' || res.status === 'error' || res.status === 'ignored') break;
        if (res.mode === 'dom' && res.finalErr != null && Math.abs(res.finalErr) < 2 && ++domRejected >= 2 && cfg.dragMode === 'auto') preferCdp = true;
        // thất bại: chờ captcha tự làm mới, nếu không thì bấm nút làm mới
        const fpOld = fingerprint(c.bg);
        await sleep(rint(500, 1500));
        let fresh = findCaptcha() || c;
        if (fingerprint(fresh.bg) === fpOld && fresh.refresh) {
          await sleep(rint(600, 1200));
          if (fingerprint(fresh.bg) === fpOld) fresh.refresh.click();
          await sleep(400);
          fresh = findCaptcha() || fresh;
        }
        c = fresh;
        if (!isVisible(c.container)) { results[results.length - 1].status = 'success'; break; }
      }
    } finally { busy = false; }
    const last = results[results.length - 1] || {};
    const ok = last.status === 'success';
    if (manual || cfg.debug || !ok) {
      toast(ok ? `Đã giải captcha (${results.length} lần thử)` :
        `Chưa giải được captcha: ${last.status}${last.error ? ' – ' + last.error : ''}`, ok);
    }
    send({ type: 'badge', ok });
    return { ok, status: last.status, tries: results.length, results };
  }

  // ---------------- tự động ----------------

  let scheduled = false, lastSkip = '';
  // ghi lý do bỏ qua vào console, chỉ khi lý do thay đổi (hàm này chạy mỗi 1.5s)
  const skip = (why) => { if (why !== lastSkip) { lastSkip = why; if (why) log('tự động bỏ qua:', why); } };
  function schedule() {
    if (scheduled) return; scheduled = true;
    setTimeout(async () => {
      scheduled = false;
      if (!cfg.enabled) return skip('tiện ích đang tắt');
      if (busy) return skip('đang giải');
      const c = findCaptcha(); if (!c) return skip('');
      const fp = fingerprint(c.bg); if (!fp) return skip('ảnh captcha chưa vẽ xong');
      const now = Date.now();
      for (const [k, t] of handled) if (now - t > HANDLED_TTL) handled.delete(k);
      if (handled.has(fp)) return skip('captcha này vừa giải, chờ ảnh mới hoặc 30s');
      skip('');
      handled.set(fp, now);
      try { await run(c); } catch (e) { console.error('[SCX] tự động lỗi', e); }
      const fp2 = c.bg.isConnected ? fingerprint(c.bg) : null; if (fp2) handled.set(fp2, Date.now());
    }, 300);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'scxPing') {
      if (!findCaptcha()) return false;
      sendResponse({ ok: true, found: true, host: location.host }); return false;
    }
    if (msg && msg.type === 'scxSolveNow') {
      const c = findCaptcha();
      if (!c) return false;                       // để frame khác (nếu có captcha) trả lời
      run(c, true).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });

  loadConfig().then(() => {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src'] });
    setInterval(() => { if (cfg.enabled && !busy) schedule(); }, 1500);   // canvas vẽ lại không sinh mutation
    schedule();
  });

  // dùng cho kiểm thử
  globalThis.__scx = { findCaptcha, run, capture, get cfg() { return cfg; } };
})();
