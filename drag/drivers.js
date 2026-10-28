/*
 * Hai cách phát sự kiện kéo:
 *  - DomDriver: tự tạo PointerEvent/MouseEvent/TouchEvent trong trang (isTrusted = false).
 *  - CdpDriver: nhờ service worker gửi Input.dispatchMouseEvent qua chrome.debugger
 *    (isTrusted = true; Chrome hiện thanh "đang gỡ lỗi" trong lúc kéo).
 * Cả hai nhận toạ độ client (viewport của frame hiện tại).
 */
(function (root) {
  // Cửa sổ thu nhỏ/bị che => trang "ẩn", Chrome bóp setTimeout xuống ≥1s (ẩn lâu: ~1 lần/phút).
  // Lúc đó nhờ service worker đếm giờ (không bị bóp); trang hiện bình thường thì dùng setTimeout.
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleep = (ms) => (document.hidden
    ? chrome.runtime.sendMessage({ type: 'sleep', ms }).catch(() => timeout(ms))
    : timeout(ms));

  class DomDriver {
    constructor(handle, { touch = 'auto' } = {}) {
      this.el = handle;
      this.touch = touch === 'auto' ? ('ontouchstart' in window && navigator.maxTouchPoints > 0) : !!touch;
      this.name = 'dom';
    }
    _mouse(type, x, y, buttons) {
      const base = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY + (window.outerHeight - window.innerHeight),
        pageX: x + window.scrollX, pageY: y + window.scrollY, button: 0, buttons,
      };
      const ptype = { mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup' }[type];
      const target = this._target(x, y);
      target.dispatchEvent(new PointerEvent(ptype, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: buttons ? 0.5 : 0 }, base)));
      target.dispatchEvent(new MouseEvent(type, base));
      if (this.touch) {
        const t = new Touch({ identifier: 1, target: this.el, clientX: x, clientY: y, pageX: base.pageX, pageY: base.pageY, screenX: base.screenX, screenY: base.screenY });
        const tt = { mousedown: 'touchstart', mousemove: 'touchmove', mouseup: 'touchend' }[type];
        const list = type === 'mouseup' ? [] : [t];
        this.el.dispatchEvent(new TouchEvent(tt, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] }));
      }
    }
    // khi đang giữ chuột, trình duyệt thật vẫn gửi sự kiện về phần tử bị bấm (implicit capture),
    // nên luôn phát trên handle; sự kiện nổi bọt lên document/window cho thư viện lắng nghe ở đó.
    _target() { return this.el; }
    async down(x, y) { this._mouse('mousedown', x, y, 1); }
    async move(x, y) { this._mouse('mousemove', x, y, 1); }
    async up(x, y) { this._mouse('mouseup', x, y, 0); }
    async close() {}
  }

  /** toạ độ góc frame hiện tại trong viewport của tab (chỉ tính được với frame cùng origin) */
  function frameOffset() {
    let x = 0, y = 0, w = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement; if (!fe) return null;
        const r = fe.getBoundingClientRect();
        const cs = w.parent.getComputedStyle(fe);
        x += r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        y += r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
        w = w.parent;
      }
    } catch (e) { return null; }
    return { x, y };
  }

  class CdpDriver {
    constructor() { this.name = 'cdp'; this.off = frameOffset(); }
    async _send(action, x, y) {
      if (!this.off) throw new Error('CDP: captcha nằm trong iframe khác origin, không tính được toạ độ');
      const res = await chrome.runtime.sendMessage({ type: 'cdp', action, x: x + this.off.x, y: y + this.off.y });
      if (!res || !res.ok) throw new Error('CDP: ' + (res && res.error || 'không phản hồi'));
    }
    async down(x, y) { await this._send('attach'); await this._send('mousePressed', x, y); }
    async move(x, y) { await this._send('mouseMoved', x, y); }
    async up(x, y) { await this._send('mouseReleased', x, y); }
    async close() { try { await this._send('detach'); } catch (e) { /* bỏ qua */ } }
  }

  root.SCXDrivers = { DomDriver, CdpDriver, sleep };
})(typeof globalThis !== 'undefined' ? globalThis : this);
