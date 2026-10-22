/*
 * SliderSolver – tìm vị trí lỗ trên ảnh nền của captcha kéo mảnh ghép.
 *
 * Thuật toán chính "maskNcc" (viết mới cho dự án này):
 *   - Lấy hình dạng mảnh ghép từ kênh alpha.
 *   - Tại mỗi vị trí ứng viên, tính 2 tín hiệu:
 *       ncc      : tương quan chuẩn hoá giữa nội dung mảnh ghép và ảnh nền bên trong hình
 *                  (lỗ thường là ảnh gốc phủ một lớp màu bán trong suốt => biến đổi affine
 *                   => NCC ~ 1, kể cả khi lỗ tối hay sáng, kể cả mảnh ghép được làm sáng).
 *       contrast : chênh lệch độ sáng giữa dải ngay ngoài viền và dải ngay trong viền
 *                  (bắt được cả lỗ đặc màu, nơi NCC không dùng được).
 *   - Chuẩn hoá z-score theo median/MAD rồi cộng lại, chọn điểm cao nhất.
 *
 * Kèm bản port của ddddocr (MIT, © sml2h3): slideMatch (Canny + TM_CCOEFF_NORMED)
 * và slideComparison (absdiff + contour lớn nhất) để dự phòng / đối chiếu.
 *
 * Chạy được cả trong trình duyệt (globalThis.SliderSolver) lẫn Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SliderSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- tiện ích ảnh ----------

  /** RGBA (Uint8ClampedArray) -> độ sáng Float32Array */
  function toGray(img) {
    const { data, width, height } = img;
    const out = new Float32Array(width * height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    return out;
  }

  /** Kênh alpha -> mask + bbox */
  function alphaMask(img, thr = 128) {
    const { data, width, height } = img;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const m = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] >= thr) {
          m[y * width + x] = 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { m, minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Khoảng cách chamfer (3-4)/3 tới pixel có giá trị khác `inside` */
  function chamfer(mask, w, h, inside) {
    const INF = 1e9;
    const d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] === inside ? INF : 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? (inside ? 0 : INF) : d[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
  }

  /**
   * Chuẩn bị các tập điểm (offset so với góc bbox) từ mảnh ghép.
   * core    : bên trong, cách viền >= coreDist (bỏ qua nét viền vẽ trên mảnh/lỗ)
   * bandIn  : dải trong viền; bandOut: dải ngoài viền
   */
  function buildTemplate(pieceImg, opt) {
    const am = alphaMask(pieceImg, opt.alphaThreshold);
    if (!am) throw new Error('Mảnh ghép không có pixel nào (alpha rỗng)');
    const P = 6, W = am.w + 2 * P, H = am.h + 2 * P;
    const m = new Uint8Array(W * H);
    for (let y = 0; y < am.h; y++) for (let x = 0; x < am.w; x++) {
      m[(y + P) * W + x + P] = am.m[(y + am.minY) * pieceImg.width + x + am.minX];
    }
    const dIn = chamfer(m, W, H, 1);   // với pixel trong hình: khoảng cách ra ngoài
    const dOut = chamfer(m, W, H, 0);  // với pixel ngoài hình: khoảng cách vào trong
    const pieceGray = toGray(pieceImg);
    const core = [], coreVal = [], bandIn = [], bandOut = [], contour = [];
    const pick = (lo) => {
      core.length = 0; coreVal.length = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (m[i] && dIn[i] >= lo) {
          core.push(x - P, y - P);
          coreVal.push(pieceGray[(y - P + am.minY) * pieceImg.width + x - P + am.minX]);
        }
      }
    };
    pick(opt.coreDist);
    if (core.length / 2 < 50) pick(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (m[i]) {
        if (dIn[i] >= opt.bandIn[0] && dIn[i] <= opt.bandIn[1]) bandIn.push(x - P, y - P);
        if (dIn[i] <= 1.5) contour.push(x - P, y - P);
      }
      else if (dOut[i] >= opt.bandOut[0] && dOut[i] <= opt.bandOut[1]) bandOut.push(x - P, y - P);
    }
    // chuẩn hoá giá trị core của mảnh ghép một lần
    let s = 0; for (const v of coreVal) s += v;
    const mean = s / coreVal.length;
    let ss = 0; const cz = new Float32Array(coreVal.length);
    for (let i = 0; i < coreVal.length; i++) { cz[i] = coreVal[i] - mean; ss += cz[i] * cz[i]; }
    return {
      bbox: { x: am.minX, y: am.minY, w: am.w, h: am.h },
      core: Int16Array.from(core), coreZ: cz, coreNorm: Math.sqrt(ss),
      bandIn: Int16Array.from(bandIn), bandOut: Int16Array.from(bandOut),
      contour: Int16Array.from(contour), pad: P,
    };
  }

  /** trung bình/phương sai trên tập điểm, bỏ qua điểm nằm ngoài ảnh */
  function meanVar(g, W, H, pts, ox, oy) {
    let s = 0, ss = 0, n = 0;
    for (let k = 0; k < pts.length; k += 2) {
      const x = ox + pts[k], y = oy + pts[k + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const v = g[y * W + x]; s += v; ss += v * v; n++;
    }
    if (!n) return [0, 0, 0];
    const m = s / n; return [m, Math.max(0, ss / n - m * m), n];
  }

  function median(a) { const b = Float64Array.from(a).sort(); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; }
  function robustZ(arr) {
    const med = median(arr);
    const mad = median(arr.map((v) => Math.abs(v - med))) * 1.4826 + 1e-6;
    return arr.map((v) => (v - med) / mad);
  }

  const DEFAULTS = {
    alphaThreshold: 128,
    coreDist: 3,           // px tính từ viền vào trong cho vùng so khớp nội dung
    bandIn: [2.5, 5.5],    // dải trong viền (bỏ nét viền ~1-2px)
    bandOut: [1.5, 4],     // dải ngoài viền
    ySearch: 2,            // dò thêm ± px theo trục y quanh y của mảnh ghép
    yFree: false,          // true: không biết y => dò toàn bộ chiều cao
    excludeStart: true,    // bỏ vùng quanh vị trí hiện tại của mảnh ghép
    edgeCap: 4,            // px – trần khoảng cách khi đo khớp viền (chamfer)
    wNcc: 1.0, wContrast: 0.5, wEdge: 1.0, // trọng số dò trên 300 mẫu kiểm định
  };

  /**
   * Giải captcha.
   * @param {ImageData-like} bg     ảnh nền có lỗ {data,width,height}
   * @param {ImageData-like} piece  ảnh mảnh ghép RGBA, cùng tỉ lệ pixel với bg
   * @param {{x:number,y:number}} pieceOffset  toạ độ góc trái-trên của ảnh mảnh ghép trên ảnh nền
   * @returns {{x,y,currentX,currentY,dx,confidence,ncc,contrast,score,method}}
   *   x,y: góc bbox hình mảnh ghép tại lỗ (toạ độ ảnh nền); dx = x - currentX (số px ảnh nền cần dịch)
   */
  function solve(bg, piece, pieceOffset = { x: 0, y: 0 }, options = {}) {
    const opt = Object.assign({}, DEFAULTS, options);
    const t = buildTemplate(piece, opt);
    const g = toGray(bg), W = bg.width, H = bg.height;
    const curX = Math.round(pieceOffset.x + t.bbox.x), curY = Math.round(pieceOffset.y + t.bbox.y);
    const xMin = 0, xMax = W - t.bbox.w, yMax = H - t.bbox.h;
    let yLo = 0, yHi = yMax;
    if (!opt.yFree) { yLo = Math.max(0, curY - opt.ySearch); yHi = Math.min(yMax, curY + opt.ySearch); }
    if (yHi < yLo) { yLo = yHi = Math.max(0, Math.min(curY, yMax)); }
    // bản đồ khoảng cách tới cạnh Canny của ảnh nền (cho chamfer matching)
    let edgeDist = null;
    if (opt.wEdge) {
      const E = canny(gaussian5(g, W, H), W, H, 40, 120);
      for (let i = 0; i < E.length; i++) E[i] = E[i] ? 1 : 0;
      edgeDist = chamfer(E, W, H, 0);
    }
    const ex = opt.excludeStart ? Math.max(6, t.bbox.w * 0.6) : -1;

    const cand = [];
    for (let y = yLo; y <= yHi; y++) {
      for (let x = Math.max(0, xMin); x <= xMax; x++) {
        if (Math.abs(x - curX) < ex) continue;
        // NCC nội dung
        let s = 0; const n = t.coreZ.length;
        for (let k = 0, q = 0; q < n; k += 2, q++) s += g[(y + t.core[k + 1]) * W + x + t.core[k]];
        const mb = s / n; let num = 0, den = 0;
        for (let k = 0, q = 0; q < n; k += 2, q++) {
          const v = g[(y + t.core[k + 1]) * W + x + t.core[k]] - mb;
          num += v * t.coreZ[q]; den += v * v;
        }
        const ncc = den > n * 4 ? num / (Math.sqrt(den) * t.coreNorm + 1e-9) : 0; // nền phẳng => 0
        // tương phản viền
        const [mi, vi] = meanVar(g, W, H, t.bandIn, x, y);
        const [mo, vo, no] = meanVar(g, W, H, t.bandOut, x, y);
        const contrast = no ? Math.abs(mo - mi) / Math.sqrt((vi + vo) / 2 + 36) : 0;
        // khớp viền: khoảng cách trung bình từ đường viền mảnh ghép tới cạnh gần nhất (âm => càng gần càng tốt)
        let edge = 0;
        if (edgeDist) {
          let ds = 0; const c = t.contour;
          for (let k = 0; k < c.length; k += 2) ds += Math.min(opt.edgeCap, edgeDist[(y + c[k + 1]) * W + x + c[k]]);
          edge = -ds / (c.length / 2);
        }
        cand.push({ x, y, ncc, contrast, edge });
      }
    }
    if (!cand.length) throw new Error('Không có vị trí ứng viên (ảnh nền quá nhỏ?)');
    const zN = robustZ(cand.map((c) => c.ncc));
    const zC = robustZ(cand.map((c) => c.contrast));
    const zE = robustZ(cand.map((c) => c.edge));
    let best = null, bi = -1;
    const cap = (v) => Math.max(-5, Math.min(30, v));
    for (let i = 0; i < cand.length; i++) {
      cand[i].score = opt.wNcc * cap(zN[i]) + opt.wContrast * cap(zC[i]) + opt.wEdge * cap(zE[i]);
      if (!best || cand[i].score > best.score) { best = cand[i]; bi = i; }
    }
    // điểm cao nhì ở xa vị trí tốt nhất => độ tin cậy
    let second = -Infinity;
    for (const c of cand) if (Math.abs(c.x - best.x) > t.bbox.w / 3 && c.score > second) second = c.score;
    const confidence = second === -Infinity ? 1 : Math.max(0, (best.score - second) / (Math.abs(best.score) + 1e-6));
    return {
      method: 'maskNcc', x: best.x, y: best.y, currentX: curX, currentY: curY, dx: best.x - curX,
      confidence: +confidence.toFixed(3), ncc: +best.ncc.toFixed(3), contrast: +best.contrast.toFixed(2), edge: +best.edge.toFixed(2),
      score: +best.score.toFixed(2), bbox: t.bbox,
    };
  }

  // ---------- port ddddocr: slide_match (Canny + TM_CCOEFF_NORMED) ----------

  function gaussian5(g, W, H) {
    const k = [1, 4, 6, 4, 1], tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    const cl = (v, m) => (v < 0 ? 0 : v >= m ? m - 1 : v);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let i = -2; i <= 2; i++) s += k[i + 2] * g[y * W + cl(x + i, W)]; tmp[y * W + x] = s / 16;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let i = -2; i <= 2; i++) s += k[i + 2] * tmp[cl(y + i, H) * W + x]; out[y * W + x] = s / 16;
    }
    return out;
  }

  /** Canny đơn giản (Sobel L1 + NMS + trễ ngưỡng), trả về Uint8Array 0/255 */
  function canny(g, W, H, lo = 50, hi = 150) {
    const mag = new Float32Array(W * H), dir = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = (dx, dy) => g[(y + dy) * W + x + dx];
      const gx = -p(-1, -1) - 2 * p(-1, 0) - p(-1, 1) + p(1, -1) + 2 * p(1, 0) + p(1, 1);
      const gy = -p(-1, -1) - 2 * p(0, -1) - p(1, -1) + p(-1, 1) + 2 * p(0, 1) + p(1, 1);
      const i = y * W + x; mag[i] = Math.abs(gx) + Math.abs(gy);
      const a = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
      dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
    }
    const nms = new Float32Array(W * H);
    const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, [dx, dy] = off[dir[i]];
      const m = mag[i];
      if (m >= mag[(y + dy) * W + x + dx] && m >= mag[(y - dy) * W + x - dx]) nms[i] = m;
    }
    const out = new Uint8Array(W * H), stack = [];
    for (let i = 0; i < nms.length; i++) if (nms[i] >= hi) { out[i] = 255; stack.push(i); }
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (!out[j] && nms[j] >= lo) { out[j] = 255; stack.push(j); }
      }
    }
    return out;
  }

  /** TM_CCOEFF_NORMED của template T (tw x th) trên ảnh I (W x H) */
  function matchTemplate(I, W, H, T, tw, th, xRange, yRange) {
    const n = tw * th; let tm = 0; for (let i = 0; i < n; i++) tm += T[i]; tm /= n;
    const Tz = new Float32Array(n); let tss = 0;
    for (let i = 0; i < n; i++) { Tz[i] = T[i] - tm; tss += Tz[i] * Tz[i]; }
    let best = { x: 0, y: 0, v: -Infinity };
    const [x0, x1] = xRange || [0, W - tw], [y0, y1] = yRange || [0, H - th];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let s = 0;
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) s += I[(y + j) * W + x + i];
      const im = s / n; let num = 0, iss = 0;
      for (let j = 0, q = 0; j < th; j++) for (let i = 0; i < tw; i++, q++) {
        const v = I[(y + j) * W + x + i] - im; num += v * Tz[q]; iss += v * v;
      }
      const v = num / (Math.sqrt(iss * tss) + 1e-9);
      if (v > best.v) best = { x, y, v };
    }
    return best;
  }

  /**
   * Port slide_match của ddddocr. Mảnh ghép được cắt theo bbox alpha (phần trong suốt thành đen,
   * giống khi ddddocr đọc PNG sang RGB). Trả về góc trái-trên (x,y) trên ảnh nền.
   * restrictY: chỉ dò quanh hàng y của mảnh ghép (nhanh và chính xác hơn bản gốc).
   */
  function slideMatch(bg, piece, pieceOffset = { x: 0, y: 0 }, { simpleTarget = false, restrictY = true, ySearch = 2 } = {}) {
    const am = alphaMask(piece);
    const tw = am.w, th = am.h, crop = new Float32Array(tw * th);
    const pg = toGray(piece);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = (y + am.minY) * piece.width + x + am.minX;
      crop[y * tw + x] = piece.data[i * 4 + 3] >= 128 ? pg[i] : 0;
    }
    let bgG = toGray(bg), tG = crop;
    if (!simpleTarget) {
      bgG = canny(gaussian5(bgG, bg.width, bg.height), bg.width, bg.height);
      tG = canny(gaussian5(crop, tw, th), tw, th);
    }
    const cy = Math.round(pieceOffset.y + am.minY);
    const yr = restrictY ? [Math.max(0, cy - ySearch), Math.min(bg.height - th, cy + ySearch)] : null;
    const r = matchTemplate(bgG, bg.width, bg.height, tG, tw, th, null, yr);
    const curX = Math.round(pieceOffset.x + am.minX);
    return { method: simpleTarget ? 'slideMatchSimple' : 'slideMatch', x: r.x, y: r.y, currentX: curX, dx: r.x - curX, confidence: +r.v.toFixed(3) };
  }

  /** Port slide_comparison của ddddocr: so ảnh có lỗ với ảnh gốc, trả bbox vùng khác lớn nhất */
  function slideComparison(withHole, original, threshold = 30) {
    const W = withHole.width, H = withHole.height, a = withHole.data, b = original.data;
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const d = 0.299 * Math.abs(a[i * 4] - b[i * 4]) + 0.587 * Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + 0.114 * Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
      bin[i] = d > threshold ? 1 : 0;
    }
    // thành phần liên thông lớn nhất
    const seen = new Uint8Array(W * H); let best = null;
    for (let s = 0; s < W * H; s++) {
      if (!bin[s] || seen[s]) continue;
      const st = [s]; seen[s] = 1; let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
      while (st.length) {
        const i = st.pop(), x = i % W, y = (i / W) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j < 0 || j >= W * H || seen[j] || !bin[j]) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
          seen[j] = 1; st.push(j);
        }
      }
      if (!best || n > best.n) best = { n, x0, y0, x1, y1 };
    }
    if (!best) return { method: 'slideComparison', x: 0, y: 0, w: 0, h: 0 };
    return { method: 'slideComparison', x: best.x0, y: best.y0, w: best.x1 - best.x0 + 1, h: best.y1 - best.y0 + 1 };
  }

  return { solve, slideMatch, slideComparison, toGray, alphaMask, canny, DEFAULTS };
});
