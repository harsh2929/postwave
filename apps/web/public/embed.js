/*!
 * Moosewave embed.js
 * © Moosewave. Proprietary — but distributed publicly because it has to run in
 * other people's pages. Closed source: do not redistribute.
 *
 * Two modes:
 *   1. INLINE — finds <div data-postwave-form="<slug>"> and injects an iframe
 *      pointing at https://forms.moosewave.com/forms/<slug>.
 *   2. POPUP  — host page includes <script ... data-postwave-mode="popup"
 *      data-postwave-form="<slug>" data-postwave-popup-trigger="..."
 *      data-postwave-popup-delay="<seconds>"> and we show a modal on the
 *      configured trigger.
 *
 * Triggers: page-load | scroll-50 | exit-intent | time-delay
 *
 * Self-contained vanilla JS; no deps; ~100 LoC.
 */
(function () {
  "use strict";

  var ORIGIN = scriptOrigin();

  function scriptOrigin() {
    try {
      var s = document.currentScript;
      if (s && s.src) return new URL(s.src).origin;
    } catch (_) {}
    return "https://forms.moosewave.com";
  }

  function buildIframe(slug, opts) {
    var f = document.createElement("iframe");
    f.src = ORIGIN + "/forms/" + encodeURIComponent(slug);
    f.title = "Subscribe form";
    f.loading = "lazy";
    f.style.border = "0";
    f.style.width = (opts && opts.width) || "100%";
    f.style.height = (opts && opts.height) || "520px";
    f.style.maxWidth = "100%";
    f.setAttribute("frameborder", "0");
    return f;
  }

  function injectInline() {
    var nodes = document.querySelectorAll("[data-postwave-form]");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.tagName === "SCRIPT") continue;
      if (n.getAttribute("data-pw-injected") === "1") continue;
      var slug = n.getAttribute("data-postwave-form");
      if (!slug) continue;
      n.appendChild(buildIframe(slug));
      n.setAttribute("data-pw-injected", "1");
    }
  }

  function getScriptConfig() {
    // Look for a script tag declaring popup mode.
    var scripts = document.querySelectorAll('script[data-postwave-mode="popup"]');
    if (scripts.length === 0) return null;
    var s = scripts[scripts.length - 1];
    return {
      slug: s.getAttribute("data-postwave-form") || "",
      trigger: s.getAttribute("data-postwave-popup-trigger") || "page-load",
      delay: parseInt(s.getAttribute("data-postwave-popup-delay") || "0", 10) || 0
    };
  }

  function showPopup(slug) {
    if (document.getElementById("postwave-popup-root")) return;
    var root = document.createElement("div");
    root.id = "postwave-popup-root";
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,0.55);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;";
    var box = document.createElement("div");
    box.style.cssText =
      "background:#fff;border-radius:12px;width:100%;max-width:480px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.25);position:relative;overflow:hidden;";
    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.style.cssText =
      "position:absolute;top:6px;right:10px;background:transparent;border:0;" +
      "font-size:22px;cursor:pointer;line-height:1;color:#475569;";
    close.onclick = function () { root.remove(); };
    box.appendChild(close);
    box.appendChild(buildIframe(slug, { height: "560px" }));
    root.appendChild(box);
    root.addEventListener("click", function (e) {
      if (e.target === root) root.remove();
    });
    document.body.appendChild(root);
  }

  function wireTrigger(cfg) {
    if (!cfg.slug) return;
    if (cfg.trigger === "page-load") {
      showPopup(cfg.slug);
    } else if (cfg.trigger === "time-delay") {
      setTimeout(function () { showPopup(cfg.slug); }, Math.max(0, cfg.delay) * 1000);
    } else if (cfg.trigger === "scroll-50") {
      var fired = false;
      var onScroll = function () {
        if (fired) return;
        var doc = document.documentElement;
        var pct = (doc.scrollTop + window.innerHeight) / doc.scrollHeight;
        if (pct >= 0.5) {
          fired = true;
          window.removeEventListener("scroll", onScroll);
          showPopup(cfg.slug);
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
    } else if (cfg.trigger === "exit-intent") {
      var fired2 = false;
      var onMouseLeave = function (e) {
        if (fired2) return;
        if (e.clientY <= 0) {
          fired2 = true;
          document.removeEventListener("mouseleave", onMouseLeave);
          showPopup(cfg.slug);
        }
      };
      document.addEventListener("mouseleave", onMouseLeave);
    }
  }

  function boot() {
    injectInline();
    var cfg = getScriptConfig();
    if (cfg) wireTrigger(cfg);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
