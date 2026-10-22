/*
 * Sinh quỹ đạo kéo giống người.
 * Trả về hàm tiến độ thay vì toạ độ cố định, để content script co giãn theo
 * khoảng cách đích được cập nhật trong lúc kéo (điều khiển vòng kín).
 */
(function (root) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rint = (a, b) => Math.floor(rnd(a, b + 1));

  /**
   * @returns {{steps: Array<{p:number, jy:number, dt:number}>, holdMs:number}}
   *   p  : tỉ lệ quãng đường (0..~1.05, có đoạn vượt quá rồi lùi)
   *   jy : rung trục y (px)
   *   dt : nghỉ trước bước này (ms)
   */
  function makeTrack({ distance = 150 } = {}) {
    const n = Math.max(18, Math.min(45, Math.round(distance / 6) + rint(8, 16)));
    const overshoot = distance > 40 ? rnd(3, 8) / distance : 0;
    const steps = [];
    const ease = Math.random() < 0.5
      ? (t) => 1 - Math.pow(1 - t, 3)                                  // ease-out cubic
      : (t) => 1 - Math.pow(1 - t, 4);                                 // ease-out quart
    let y = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      y = Math.max(-2.5, Math.min(2.5, y + rnd(-0.8, 0.8)));
      // dt quyết định tốc độ kéo: tăng để kéo chậm hơn
      steps.push({ p: (1 + overshoot) * ease(t), jy: +y.toFixed(2), dt: rint(18, 40) + (i < 3 ? rint(20, 60) : 0) });
    }
    if (overshoot) {
      const back = rint(2, 5);
      for (let i = 1; i <= back; i++) {
        y = Math.max(-2.5, Math.min(2.5, y + rnd(-0.5, 0.5)));
        steps.push({ p: 1 + overshoot * (1 - i / back), jy: +y.toFixed(2), dt: rint(25, 60) });
      }
    }
    return { steps, holdMs: rint(80, 220) };
  }

  root.SCXTrack = { makeTrack, rnd, rint };
  if (typeof module === 'object' && module.exports) module.exports = root.SCXTrack;
})(typeof globalThis !== 'undefined' ? globalThis : this);
