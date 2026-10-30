// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// WidgetJS GET /api/public/r/{code}/widget.js
//
// Returns a tiny self-contained JS snippet a tenant can embed on
// their marketing site. The snippet renders a "Refer a friend"
// button + share dialog on the host page, deriving the share URL
// from the embedded code. PR 4.
//
// Security properties and release boundary:
//   - The snippet only ever uses textContent + DOM construction.
//     No innerHTML or eval.
//   - shareURL is server-side-validated against an existing code
//     before injection and then JSON-encoded for the snippet's
//     string literal — defence-in-depth against odd characters.
//   - We don't use the URL anywhere as a template — it's read at
//     click time and passed to navigator.clipboard / window.open.
//   - The current implementation still relies on style.cssText and lacks the
//     complete dialog keyboard/focus contract. MountPublicRoutes therefore
//     keeps it unavailable until the public runtime is release-qualified.
func (d *Deps) WidgetJS(w http.ResponseWriter, r *http.Request) {
	code, valid := canonicalizeReferralLookupCode(chi.URLParam(r, "code"))
	if !valid {
		http.Error(w, "// referral code not found", http.StatusNotFound)
		return
	}
	if _, _, err := d.Repo.CodeOwnerByAny(r.Context(), code); err != nil {
		http.Error(w, "// referral code not found", http.StatusNotFound)
		return
	}
	base := d.publicShareBase(r)
	if base == "" {
		http.Error(w, "// referral share base URL is not configured", http.StatusServiceUnavailable)
		return
	}
	shareURL := strings.TrimRight(base, "/") + "/r/" + code

	js := renderWidgetJS(shareURL)
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(js))
}

// renderWidgetJS produces the embedded snippet. The shareURL is
// JSON-encoded into a string literal so there's no template
// interpolation surface; the snippet itself never does innerHTML
// or eval. Pure function — unit-testable without HTTP.
func renderWidgetJS(shareURL string) string {
	enc, _ := json.Marshal(shareURL)
	return `(function(){
  var URL = ` + string(enc) + `;
  var ENC = encodeURIComponent;
  function el(tag, props, parent) {
    var n = document.createElement(tag);
    if (props) {
      if (props.text != null) n.textContent = props.text;
      if (props.css)   n.style.cssText  = props.css;
      if (props.attrs) Object.keys(props.attrs).forEach(function(k){ n.setAttribute(k, props.attrs[k]); });
      if (props.on)    Object.keys(props.on).forEach(function(k){ n.addEventListener(k, props.on[k]); });
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function openModal() {
    var bg = el('div', { css: 'position:fixed;inset:0;background:rgba(15,23,30,.45);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px',
      on: { click: function(e){ if (e.target === bg) document.body.removeChild(bg); } } });
    var box = el('div', { css: 'background:#fff;color:#14171f;font:14px/1.4 system-ui,sans-serif;max-width:420px;width:100%;border-radius:12px;padding:20px;box-shadow:0 10px 32px rgba(0,0,0,.25)' }, bg);
    el('div', { text: 'Share with a friend', css: 'font-weight:600;font-size:16px;margin-bottom:8px' }, box);
    el('div', { text: URL, css: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#f3f4f6;padding:8px 10px;border-radius:6px;word-break:break-all;margin-bottom:12px' }, box);
    var grid = el('div', { css: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' }, box);
    var channels = [
      ['Copy',     function(){ navigator.clipboard && navigator.clipboard.writeText(URL); }],
      ['X',        function(){ window.open('https://twitter.com/intent/tweet?url=' + ENC(URL)); }],
      ['Email',    function(){ window.location.href = 'mailto:?body=' + ENC(URL); }],
      ['WhatsApp', function(){ window.open('https://wa.me/?text=' + ENC(URL)); }],
      ['SMS',      function(){ window.location.href = 'sms:&body=' + ENC(URL); }],
      ['Close',    function(){ document.body.removeChild(bg); }]
    ];
    channels.forEach(function(c){
      el('button', {
        text: c[0],
        css: 'padding:10px;background:#fff;border:1px solid #dde2e6;border-radius:6px;font:inherit;cursor:pointer',
        attrs: { type: 'button' },
        on: { click: c[1] }
      }, grid);
    });
    document.body.appendChild(bg);
  }
  function init() {
    var host = document.querySelector('[data-postwave-refer]');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    el('button', {
      text: 'Refer a friend',
      css: 'padding:8px 14px;border-radius:6px;border:1px solid #14b8a6;background:#14b8a6;color:#042f2e;font:inherit;font-weight:600;cursor:pointer',
      attrs: { type: 'button' },
      on: { click: openModal }
    }, host);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();`
}
