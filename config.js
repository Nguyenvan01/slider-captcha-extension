/*
 * Cấu hình mặc định. Người dùng sửa trong trang Tuỳ chọn (lưu ở chrome.storage.sync),
 * giá trị ở đây chỉ là mặc định khi chưa cấu hình.
 */
(function (root) {
  const DEFAULT_CONFIG = {
    enabled: true,          // tự giải khi captcha xuất hiện
    hosts: [],              // match pattern các trang được phép chạy, vd "https://*.example.gov.vn/*"
    dragMode: 'auto',       // 'dom' | 'cdp' | 'auto' (thử DOM, mảnh ghép không nhúc nhích thì chuyển CDP)
    maxRetry: 3,
    debug: false,           // vẽ khung đỏ tại vị trí lỗ tìm được
    tolerancePx: 0.6,       // sai số chấp nhận khi căn chỉnh vòng kín (px hiển thị)
    resultTimeoutMs: 2500,
    startDelayMs: [350, 900],  // nghỉ ngẫu nhiên trước khi kéo (giống người nhìn ảnh)
    profiles: [
      {
        name: 'SliderCaptcha (canvas)',
        // plugin SliderCaptcha phổ biến: 2 canvas + .sliderContainer
        container: '.slidercaptcha, .slider-captcha, [data-captcha="slider"]',
        background: 'canvas:not(.block)',
        piece: 'canvas.block',
        handle: '.slider',
        refresh: '.refreshIcon, .refresh, [class*="refresh"]',
        success: '.sliderContainer_success, .success',
        fail: '.sliderContainer_fail, .fail',
        ratio: 0,           // 0 = tự đo trong lúc kéo
      },
    ],
    autoDetect: true,       // không khớp profile nào thì dò cấu trúc chung
  };
  root.SCX_DEFAULT_CONFIG = DEFAULT_CONFIG;
  if (typeof module === 'object' && module.exports) module.exports = DEFAULT_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
