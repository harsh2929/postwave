// SPDX-License-Identifier: AGPL-3.0-only
//
// embed.go — embeddable signup-form snippets. Tenants paste the
// snippet into their Webflow/Framer/WordPress site and it renders
// the form using the existing /api/public/forms/{slug} endpoint.
//
// Five snippet flavors, generated server-side so the right host +
// public URL is baked in (no client-side configuration needed):
//
//   - script:   <script async src="…"></script> — universal, drop into
//               any HTML site (raw HTML, Webflow Embed, Framer Code).
//   - iframe:   <iframe src="…/forms/<slug>/embed"></iframe> — strict
//               sandbox; useful when the host CSP forbids inline JS.
//   - react:    JSX snippet that fetches /forms/<slug> + posts to
//               /submit. Plain hooks, no provider wrapper required.
//   - wordpress: shortcode `[postwave-form slug="…"]` for the WP
//                plugin (the plugin reads the slug + renders the
//                iframe variant).
//   - inline:   raw <form> HTML pre-populated with the form's fields,
//               action attribute set to the public submit URL. Used
//               by static-site generators (Jekyll, Hugo) where JS is
//               undesirable.
//
// Exit-intent: the script + react flavors accept a `data-exit-intent`
// attribute / prop. When true, the form opens as a modal on
// mouse-leave (script) or window-blur (react).

package forms

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// EmbedDeps wires the public-base-URL into the snippet generator.
// Mounted by main.go alongside the existing form admin handlers.
type EmbedDeps struct {
	*Deps
	// PublicBaseURL is the absolute URL the snippet should point at
	// (e.g. "https://api.moosewave.com"). The submit endpoint is
	// derived by appending /api/public/forms/<slug>/submit.
	PublicBaseURL string
	// FormsPublicHost is the origin that serves the static embed.js loader
	// (apps/web/public/embed.js), e.g. "https://forms.moosewave.com". The
	// script snippet must point at THIS host's /embed.js — the loader reads
	// its own currentScript.src origin to build the iframe URL (D08#13).
	FormsPublicHost string
}

// MountAdminRoutes adds the operator-facing snippet endpoint. It is mounted
// inside the authenticated route group and stays admin-scoped because it
// reveals integration instructions for the workspace.
func (d *EmbedDeps) MountAdminRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/forms/{id}/embed/{flavor}", d.GenerateSnippet)
}

// GenerateSnippet returns the requested snippet flavor for the form
// identified by {id}. The response also carries the canonical hosted URL and
// host so native/dashboard clients never have to infer FORMS_PUBLIC_HOST from
// the API origin.
func (d *EmbedDeps) GenerateSnippet(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	flavor := strings.ToLower(chi.URLParam(r, "flavor"))
	form, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "form not found"))
		return
	}
	base := strings.TrimRight(d.PublicBaseURL, "/")
	if base == "" {
		base = strings.TrimRight(publicBaseGuess(r), "/")
	}
	// The static embed.js loader and hosted renderer live on the forms public
	// host, not the API host (D08#13). An API-origin fallback looks plausible
	// but produces broken links, so this operator-facing contract fails closed
	// when the deployment has not supplied its canonical host.
	formsHost := strings.TrimRight(d.FormsPublicHost, "/")
	if formsHost == "" {
		writeJSON(w, http.StatusServiceUnavailable,
			errEnv("forms_public_host_unconfigured", "canonical forms public host is not configured"))
		return
	}
	payload, ok := buildEmbedSnippetResponse(flavor, base, formsHost, form.Slug)
	if !ok {
		writeJSON(w, http.StatusBadRequest,
			errEnv("bad_flavor", "flavor must be script | iframe | react | wordpress | inline"))
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

type embedSnippetResponse struct {
	Flavor       string `json:"flavor"`
	Snippet      string `json:"snippet"`
	Language     string `json:"language"`
	Instructions string `json:"instructions"`
	PublicHost   string `json:"public_host"`
	PublicURL    string `json:"public_url"`
}

func buildEmbedSnippetResponse(flavor, base, formsHost, slug string) (embedSnippetResponse, bool) {
	publicHost, ok := canonicalPublicFormOrigin(formsHost)
	if !ok {
		return embedSnippetResponse{}, false
	}
	publicURL := publicHost + "/forms/" + url.PathEscape(slug)
	snippet, language, instructions := renderSnippet(flavor, base, publicHost, slug)
	if snippet == "" {
		return embedSnippetResponse{}, false
	}
	return embedSnippetResponse{
		Flavor:       flavor,
		Snippet:      snippet,
		Language:     language,
		Instructions: instructions,
		PublicHost:   publicHost,
		PublicURL:    publicURL,
	}, true
}

func canonicalPublicFormURL(formsHost, slug string) (string, bool) {
	host, ok := canonicalPublicFormOrigin(formsHost)
	if !ok {
		return "", false
	}
	return host + "/forms/" + url.PathEscape(slug), true
}

func canonicalPublicFormOrigin(formsHost string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(formsHost))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return "", false
	}
	// Accept only an origin, never a configured path/query/fragment. This
	// keeps generated snippets and redirects on the intended public host.
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	u.Path = ""
	return strings.TrimRight(u.String(), "/"), true
}

// PublicEmbed keeps the legacy API-host iframe URL working, but hands off to
// the canonical hosted renderer. That renderer owns the real form structure,
// survey/file-upload behavior, captcha, locale, and success states.
func (d *EmbedDeps) PublicEmbed(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	_, err := d.Repo.ByPublicSlug(r.Context(), slug)
	if err != nil {
		http.Error(w, "form not found", http.StatusNotFound)
		return
	}
	// The redirected hosted page records the visit through PublicGet; do not
	// count here as well or legacy iframe URLs would double the denominator.
	publicURL, ok := canonicalPublicFormURL(d.FormsPublicHost, slug)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable,
			errEnv("forms_public_host_unconfigured", "canonical forms public host is not configured"))
		return
	}
	// #nosec G710 -- destination is an operator-configured absolute http(s)
	// origin validated above; the request-derived slug is one escaped segment.
	http.Redirect(w, r, publicURL, http.StatusTemporaryRedirect)
}

// --- snippet renderers ---

func renderSnippet(flavor, base, formsHost, slug string) (snippet, language, instructions string) {
	switch flavor {
	case "script":
		// D08#13: point at the forms host's static /embed.js loader (which
		// reads its own currentScript.src origin to build the iframe URL) —
		// NOT {base}/api/public/forms/{slug}/embed.js, which is never mounted.
		snippet = fmt.Sprintf(
			`<script async src="%s/embed.js" data-postwave-form="%s"></script>`,
			formsHost, slug,
		)
		language = "html"
		instructions = "Paste anywhere inside <body>. Add data-postwave-mode='popup' to open the form as a modal."

	case "iframe":
		snippet = fmt.Sprintf(
			`<iframe src="%s/forms/%s" title="Subscribe form" loading="lazy" style="width:100%%;border:0;min-height:520px;"></iframe>`,
			formsHost, slug,
		)
		language = "html"
		instructions = "Paste anywhere inside <body>. CSP-safe; no external JS executes on the host page."

	case "react":
		snippet = fmt.Sprintf(`export function PostwaveForm() {
  return <iframe src="%s/forms/%s" title="Subscribe form" loading="lazy" style={{ width: "100%%", minHeight: 520, border: 0 }} />;
}`, formsHost, slug)
		language = "tsx"
		instructions = "Drop this component into any React/Next.js page. The hosted renderer stays synchronized with the form builder."

	case "wordpress":
		snippet = fmt.Sprintf(`[postwave-form slug="%s"]`, slug)
		language = "shortcode"
		instructions = "Install the Moosewave WordPress plugin, then paste this shortcode anywhere in a page or post."

	case "inline":
		snippet = fmt.Sprintf(`<iframe src="%s/forms/%s" title="Subscribe form" loading="lazy" style="width:100%%;border:0;min-height:520px;"></iframe>`, formsHost, slug)
		language = "html"
		instructions = "Pure HTML iframe; the hosted renderer preserves every configured field and anti-spam control."
	}
	return
}

func publicBaseGuess(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil && (strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.")) {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func htmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}

// writeJSON + errEnv come from handlers.go in the same package.
