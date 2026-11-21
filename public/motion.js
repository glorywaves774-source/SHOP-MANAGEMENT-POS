/* ShopFlow motion: page-enter staggering, number count-up, cursor spotlight, aurora parallax,
 * theme cross-fade. Does nothing when the device asks for reduced motion. */
(function () {
  "use strict";
  var content = document.getElementById("content");
  if (!content || !window.matchMedia) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) return;

  /* 1. Mark page changes so enter animations play once per page, never on in-page updates */
  var timer;
  function keepEntering() {
    content.classList.add("entering");
    clearTimeout(timer);
    timer = setTimeout(function () { content.classList.remove("entering"); }, 1700);
  }
  var original = window.setPage;
  if (typeof original === "function") {
    window.setPage = function () { keepEntering(); return original.apply(this, arguments); };
  }

  /* 2. Stagger index + count-up once the page's HTML arrives */
  var GROUPS = [".stats-grid", ".dashboard-grid", ".report-grid", ".product-grid", ".activity-list", ".chart", ".pos-categories", "tbody"];
  function stagger() {
    GROUPS.forEach(function (sel) {
      content.querySelectorAll(sel).forEach(function (parent) {
        Array.prototype.forEach.call(parent.children, function (child, i) { child.style.setProperty("--i", Math.min(i, 14)); });
      });
    });
    Array.prototype.forEach.call(content.children, function (child, i) {
      if (child.classList.contains("panel")) child.style.setProperty("--i", Math.min(i, 8));
    });
  }
  function countUp() {
    content.querySelectorAll(".stat-value:not([data-counted])").forEach(function (el) {
      el.setAttribute("data-counted", "1");
      var text = el.textContent, m = text.match(/\d[\d,]*\.?\d*/);
      if (!m) return;
      var raw = m[0], end = parseFloat(raw.replace(/,/g, ""));
      if (!isFinite(end) || end === 0) return;
      var dec = (raw.split(".")[1] || "").length, pre = text.slice(0, m.index), suf = text.slice(m.index + raw.length);
      var t0 = performance.now(), dur = 1100;
      (function frame(now) {
        var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        if (p < 1) {
          el.textContent = pre + (end * e).toLocaleString("en-GH", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
          requestAnimationFrame(frame);
        } else { el.textContent = text; }   // always land on the exact original text
      })(t0);
    });
  }
  new MutationObserver(function () {
    if (!content.classList.contains("entering")) return;
    stagger(); countUp(); keepEntering();   // restart the window so slow networks still animate
  }).observe(content, { childList: true });

  /* 3. Cursor spotlight on cards + gentle aurora parallax */
  var raf = 0, px = 0, py = 0, root = document.documentElement;
  document.addEventListener("pointermove", function (e) {
    var t = e.target.closest && e.target.closest(".stat-card,.product-tile");
    if (t) { var r = t.getBoundingClientRect(); t.style.setProperty("--mx", (e.clientX - r.left) + "px"); t.style.setProperty("--my", (e.clientY - r.top) + "px"); }
    px = (e.clientX / window.innerWidth - 0.5) * 46; py = (e.clientY / window.innerHeight - 0.5) * 46;
    if (!raf) raf = requestAnimationFrame(function () { raf = 0; root.style.setProperty("--px", px.toFixed(1)); root.style.setProperty("--py", py.toFixed(1)); });
  }, { passive: true });

  /* 4. Smooth light/dark cross-fade */
  document.addEventListener("click", function (e) {
    if (!(e.target.closest && e.target.closest("[data-theme-toggle]"))) return;
    root.classList.add("theme-fade");
    setTimeout(function () { root.classList.remove("theme-fade"); }, 650);
  });
})();
