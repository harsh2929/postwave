// SPDX-License-Identifier: AGPL-3.0-only

const POPUP_JS = String.raw`
(function () {
  "use strict";

  var script = document.currentScript || findScript();
  var origin = scriptOrigin(script);
  var cfg = scriptConfig(script);
  var loaded = false;
  var showing = false;
  var timers = [];
  var cleanups = [];
  var cleanedUp = false;
  var REQUEST_TIMEOUT_MS = 8000;
  var MAX_JSON_BYTES = 512 * 1024;
  var MAX_CONFIG_VALUE_LENGTH = 256;

  function findScript() {
    var scripts = document.querySelectorAll("script[data-postwave-popup],script[data-postwave-popup-key],script[data-postwave-popup-id]");
    return scripts[scripts.length - 1] || null;
  }

  function scriptOrigin(node) {
    try {
      if (node && node.src) {
        var url = new URL(node.src);
        if (url.username || url.password) return "https://forms.moosewave.com";
        if (url.protocol === "https:") return url.origin;
        if (url.protocol === "http:" && isLocalHost(url.hostname)) return url.origin;
      }
    } catch (_) {}
    return "https://forms.moosewave.com";
  }

  function scriptConfig(node) {
    var url = null;
    try {
      url = node && node.src ? new URL(node.src) : null;
    } catch (_) {}
    var get = function (name) {
      return node ? node.getAttribute(name) || "" : "";
    };
    var query = function (name) {
      return url ? url.searchParams.get(name) || "" : "";
    };
    return {
      key: cleanToken(
        get("data-postwave-popup") ||
        get("data-postwave-popup-key") ||
        get("data-postwave-popup-id") ||
        query("popup") ||
        query("key") ||
        query("id")
      ),
      tenant: cleanToken(get("data-postwave-tenant") || query("tenant")),
      trigger: cleanTrigger(
        get("data-postwave-trigger") ||
        get("data-postwave-popup-trigger") ||
        query("trigger")
      ),
      delay: cleanDelay(get("data-postwave-delay") || get("data-postwave-popup-delay") || query("delay") || "0")
    };
  }

  function cleanToken(value) {
    value = String(value || "").trim();
    if (!value || value.length > MAX_CONFIG_VALUE_LENGTH) return "";
    if (/[\u0000-\u001f\u007f\\/?#]/.test(value)) return "";
    return value;
  }

  function cleanTrigger(value) {
    value = String(value || "").trim().toLowerCase();
    if (!value || value.length > 64 || /[\u0000-\u001f\u007f\\/?#]/.test(value)) return "";
    return value;
  }

  function cleanDelay(value) {
    var parsed = parseInt(String(value || "0"), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(parsed, 3600);
  }

  function isLocalHost(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  }

  function endpoint(path) {
    var url = new URL(path, origin);
    if (cfg.tenant) url.searchParams.set("tenant", cfg.tenant);
    return url.toString();
  }

  function fetchWithTimeout(url, options) {
    options = options || {};
    if (!options.redirect) options.redirect = "error";
    if (!window.AbortController) return fetch(url, options);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    options.signal = ctrl.signal;
    return fetch(url, options).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }

  function readJsonLimited(res) {
    return readTextLimited(res, MAX_JSON_BYTES).then(function (text) {
      return text ? JSON.parse(text) : null;
    });
  }

  function readTextLimited(res, maxBytes) {
    var contentLength = Number((res.headers && res.headers.get("content-length")) || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return Promise.reject(new Error("response too large"));
    }
    if (!res.body || !res.body.getReader || !window.TextDecoder) {
      var read = res.text.bind(res);
      return read().then(function (text) {
        if (utf8ByteLength(text) > maxBytes) throw new Error("response too large");
        return text;
      });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var total = 0;
    var out = "";
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return out + decoder.decode();
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          return reader.cancel().catch(function () {}).then(function () {
            throw new Error("response too large");
          });
        }
        out += decoder.decode(chunk.value, { stream: true });
        return pump();
      });
    }
    return pump();
  }

  function loadPopup() {
    if (!cfg.key || loaded) return;
    loaded = true;
    fetchWithTimeout(endpoint("/api/public/popups/" + encodeURIComponent(cfg.key)), {
      credentials: "omit",
      headers: { "accept": "application/json" }
    })
      .then(function (res) {
        if (!res.ok) throw new Error("popup lookup failed");
        return readJsonLimited(res);
      })
      .then(function (popup) {
        if (!canShow(popup)) return;
        wireTrigger(popup);
      })
      .catch(function () {});
  }

  function canShow(popup) {
    if (!popup || popup.status !== "published") return false;
    var targeting = popup.targeting || {};
    var paths = Array.isArray(targeting.paths) ? targeting.paths : [];
    if (paths.length && !paths.some(pathMatches)) return false;
    var key = storageKey(popup);
    var frequencyDays = toNumber(targeting.frequency_days, 0);
    if (frequencyDays > 0) {
      try {
        var dismissedAt = parseInt(localStorage.getItem(key) || "0", 10);
        if (dismissedAt && Date.now() - dismissedAt < frequencyDays * 86400000) {
          return false;
        }
      } catch (_) {}
    }
    return true;
  }

  function pathMatches(path) {
    if (typeof path !== "string" || !path) return false;
    if (path === window.location.pathname) return true;
    if (path.charAt(path.length - 1) === "*") {
      return window.location.pathname.indexOf(path.slice(0, -1)) === 0;
    }
    return false;
  }

  function wireTrigger(popup) {
    var trigger = normalizeTrigger(cfg.trigger || (popup.trigger && popup.trigger.type) || "page-load");
    var delay = cfg.delay || toNumber(popup.trigger && popup.trigger.delay_seconds, 0);
    if (trigger === "page-load") {
      showPopup(popup);
    } else if (trigger === "time-delay") {
      setManagedTimeout(function () { showPopup(popup); }, Math.max(0, delay) * 1000);
    } else if (trigger === "scroll-50") {
      var fired = false;
      var onScroll = function () {
        if (fired) return;
        var doc = document.documentElement;
        var pct = (doc.scrollTop + window.innerHeight) / Math.max(doc.scrollHeight, 1);
        if (pct >= 0.5) {
          fired = true;
          window.removeEventListener("scroll", onScroll);
          showPopup(popup);
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      addCleanup(function () { window.removeEventListener("scroll", onScroll); });
    } else if (trigger === "exit-intent") {
      var fired2 = false;
      var onMouseLeave = function (e) {
        if (fired2) return;
        if (e.clientY <= 0) {
          fired2 = true;
          document.removeEventListener("mouseleave", onMouseLeave);
          showPopup(popup);
        }
      };
      document.addEventListener("mouseleave", onMouseLeave);
      addCleanup(function () { document.removeEventListener("mouseleave", onMouseLeave); });
    }
  }

  function showPopup(popup) {
    if (showing || document.getElementById("postwave-popup-root")) return;
    showing = true;
    var root = document.createElement("div");
    root.id = "postwave-popup-root";
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.56);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;";
    var box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.style.cssText =
      "width:100%;max-width:440px;background:#fff;color:#111827;border:1px solid rgba(17,24,39,.12);" +
      "border-radius:10px;box-shadow:0 24px 80px rgba(15,23,42,.28);position:relative;overflow:hidden;";
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "x";
    close.setAttribute("aria-label", "Close popup");
    close.style.cssText =
      "position:absolute;top:10px;right:10px;width:32px;height:32px;border:0;border-radius:999px;background:#f3f4f6;color:#374151;" +
      "font-size:18px;line-height:32px;cursor:pointer;";
    close.onclick = function () { dismiss(root, popup); };
    var content = document.createElement("div");
    content.style.cssText = "padding:28px;display:grid;gap:14px;";
    renderBlocks(content, popup);
    ensureForm(content, popup, root);
    box.appendChild(close);
    box.appendChild(content);
    root.appendChild(box);
    root.addEventListener("click", function (event) {
      if (event.target === root) dismiss(root, popup);
    });
    document.body.appendChild(root);
  }

  function renderBlocks(container, popup) {
    var blocks = Array.isArray(popup.blocks) ? popup.blocks : [];
    if (!blocks.length) {
      blocks = [{ type: "heading", content: popup.name || "Stay in the loop" }, { type: "text", content: "Get updates by email." }];
    }
    for (var i = 0; i < blocks.length; i++) {
      renderBlock(container, blocks[i]);
    }
  }

  function renderBlock(container, block) {
    var type = String(block.type || "text");
    if (type === "image" && (block.url || block.image_url)) {
      var imageUrl = safeExternalUrl(block.url || block.image_url, { image: true });
      if (!imageUrl) return;
      var img = document.createElement("img");
      img.src = imageUrl;
      img.alt = String(block.alt_text || block.name || "");
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.style.cssText = "display:block;width:100%;height:auto;border-radius:8px;";
      container.appendChild(img);
      return;
    }
    if (type === "button" && block.url) {
      var buttonUrl = safeExternalUrl(block.url, { image: false });
      if (!buttonUrl) return;
      var a = document.createElement("a");
      a.href = buttonUrl;
      a.rel = "noopener noreferrer";
      a.textContent = String(block.label || block.content || "Learn more");
      a.style.cssText = "display:inline-flex;justify-content:center;border-radius:7px;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;font-size:14px;font-weight:600;";
      container.appendChild(a);
      return;
    }
    if (type === "email_capture" || type === "signup_form") return;
    var el = document.createElement(type === "heading" || type === "hero" ? "h2" : "p");
    el.textContent = String(block.headline || block.heading || block.title || block.content || block.body || "");
    el.style.cssText =
      el.tagName === "H2"
        ? "margin:0;color:#111827;font-size:24px;line-height:1.18;font-weight:700;"
        : "margin:0;color:#4b5563;font-size:15px;line-height:1.55;";
    if (el.textContent) container.appendChild(el);
  }

  function ensureForm(container, popup, root) {
    var form = document.createElement("form");
    form.style.cssText = "display:grid;gap:10px;margin-top:2px;";
    var input = document.createElement("input");
    input.name = "email";
    input.type = "email";
    input.required = true;
    input.placeholder = "you@example.com";
    input.autocomplete = "email";
    input.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:7px;padding:11px 12px;font-size:14px;color:#111827;";
    var button = document.createElement("button");
    button.type = "submit";
    button.textContent = buttonLabel(popup);
    button.style.cssText = "border:0;border-radius:7px;background:#111827;color:#fff;padding:11px 14px;font-size:14px;font-weight:700;cursor:pointer;";
    var message = document.createElement("div");
    message.style.cssText = "min-height:18px;color:#4b5563;font-size:13px;";
    form.appendChild(input);
    form.appendChild(button);
    form.appendChild(message);
    form.onsubmit = function (event) {
      event.preventDefault();
      button.disabled = true;
      message.textContent = "";
      fetchWithTimeout(endpoint("/api/public/popups/" + encodeURIComponent(popup.public_key || cfg.key) + "/submit"), {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({
          email: input.value,
          metadata: {
            url: safePageUrl(window.location.href),
            referrer: safePageUrl(document.referrer || "")
          }
        })
      })
        .then(function (res) {
          if (!res.ok) throw new Error("submit failed");
          message.textContent = "Thanks, you are subscribed.";
          markDismissed(popup);
          setManagedTimeout(function () { dismiss(root, popup, true); }, 900);
        })
        .catch(function () {
          button.disabled = false;
          message.textContent = "Please check your email and try again.";
        });
    };
    container.appendChild(form);
  }

  function dismiss(root, popup, alreadyMarked) {
    if (!alreadyMarked) markDismissed(popup);
    showing = false;
    if (root && root.parentNode) root.parentNode.removeChild(root);
  }

  function markDismissed(popup) {
    try {
      localStorage.setItem(storageKey(popup), String(Date.now()));
    } catch (_) {}
  }

  function storageKey(popup) {
    return "postwave:popup:" + String((popup && (popup.public_key || popup.id)) || cfg.key).slice(0, 128) + ":dismissed";
  }

  function buttonLabel(popup) {
    var blocks = Array.isArray(popup.blocks) ? popup.blocks : [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].button) return String(blocks[i].button);
      if (blocks[i].label && (blocks[i].type === "email_capture" || blocks[i].type === "signup_form")) return String(blocks[i].label);
    }
    return "Subscribe";
  }

  function normalizeTrigger(trigger) {
    trigger = String(trigger || "page-load").replace(/_/g, "-");
    if (trigger === "load") return "page-load";
    if (trigger === "delay") return "time-delay";
    return trigger;
  }

  function toNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function safeExternalUrl(value, opts) {
    if (typeof value !== "string" || !value) return "";
    if (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return "";
    try {
      var url = new URL(value, window.location.href);
      if (url.username || url.password) return "";
      url.hash = "";
      if (url.protocol === "https:") return url.toString();
      if (url.protocol === "http:" && window.location.protocol === "http:") return url.toString();
      if (!opts.image && url.protocol === "mailto:") return url.toString();
    } catch (_) {}
    return "";
  }

  function safePageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      var url = new URL(value, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 2048);
    } catch (_) {
      return "";
    }
  }

  function setManagedTimeout(fn, delay) {
    var id = setTimeout(function () {
      clearManagedTimeout(id);
      fn();
    }, delay);
    timers.push(id);
    return id;
  }

  function clearManagedTimeout(id) {
    clearTimeout(id);
    var idx = timers.indexOf(id);
    if (idx >= 0) timers.splice(idx, 1);
  }

  function utf8ByteLength(value) {
    var bytes = 0;
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
        var next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function addCleanup(fn) {
    cleanups.push(fn);
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch (_) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadPopup, { once: true });
  } else {
    loadPopup();
  }
  window.addEventListener("pagehide", cleanup, { once: true });
})();
`;

export function GET() {
  return new Response(POPUP_JS, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "Content-Type": "application/javascript; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
