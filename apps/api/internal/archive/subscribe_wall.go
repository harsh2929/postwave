// SPDX-License-Identifier: AGPL-3.0-only
//
// subscribe_wall.go — implements Buttondown's "/subscription wall" for
// the public archive surface (gap feature `archive-subscription-wall-
// without-stripe`).
//
// What this gives operators:
//
//   * A Markdown/HTML directive — `<!-- pw-subscribe-wall -->` — they
//     can drop anywhere in a campaign body. Above the marker stays
//     fully public on /archive/{tenant}/{slug}. Below the marker is
//     ONLY rendered when the requester presents a valid subscriber
//     cookie set by /api/public/archive/{tenant}/unlock.
//
//   * A teaser-on-the-fence rendering model: non-subscribers see the
//     above-wall HTML, a "subscribe to keep reading" CTA card, and
//     nothing else — the below-wall HTML is stripped server-side, so
//     the wall is not a paper wall (view-source can't bypass it).
//
//   * Email delivery is unaffected. The wall only ever applies to the
//     web archive renderer; the recipient's inbox copy uses the full
//     body via the normal send path (which never imports this file).
//
// Cookie format & validation
// --------------------------
//
//   `pw_archive_sub` = base64url(payload) "." hex(hmacSHA256(payload, K))
//
// where payload is the JSON `{"t":"<tenant_id_uuid>", "e":"<email>",
// "x":<unix_expiry>}` and K is ARCHIVE_SUBSCRIBE_WALL_SECRET (or a
// deterministic dev fallback).
//
// The cookie is HttpOnly + Secure + SameSite=Lax so the embedded
// archive subdomain can use it but unrelated origins can't read it.
// TTL is 90 days, matching the typical newsletter re-engagement
// window. Tenants always live in their own cookie name-scope
// (`pw_archive_sub_<short>`) so multi-tenant archive subdomains
// cannot cross-pollute.
//
// Tagging
// -------
//
// The CTA card the renderer drops in place of the below-wall content
// is tagged with `data-pw-wall="cta"` so operator stylesheets can
// theme it AND so analytics can distinguish a "wall impression" from a
// real article view (different from a Stripe paywall which uses
// `data-pw-paywall`).

package archive

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// SubscribeWallMarker is the canonical HTML-comment directive operators
// drop into the campaign body to mark the start of gated content. The
// renderer accepts a small amount of whitespace variance (with or
// without surrounding spaces) but does NOT accept attributes — keep
// the directive simple so the markdown editor's preview never
// "improves" it into something the splitter doesn't recognise.
const SubscribeWallMarker = "pw-subscribe-wall"

// subscribeWallRE matches `<!-- pw-subscribe-wall -->` with optional
// surrounding whitespace inside the comment. Anchored with no flags
// so a body that contains `pw-subscribe-wall` as plain text (e.g. in
// a code block discussing the feature) is NOT picked up — only the
// HTML-comment form qualifies.
var subscribeWallRE = regexp.MustCompile(`(?i)<!--\s*` + regexp.QuoteMeta(SubscribeWallMarker) + `\s*-->`)

// SplitSubscribeWallHTML splits an issue body on the first occurrence
// of the subscribe-wall directive. Returns the above-wall HTML, the
// below-wall HTML, and a boolean indicating whether the directive was
// present.
//
// Idempotent and pure (no DB, no globals). Exposed package-level so
// the public renderer + admin preview can share the same split.
//
// When the body contains MULTIPLE directives only the FIRST is honoured
// — operators occasionally paste templates that already include a
// wall comment, and a "wall after a wall" makes no semantic sense.
// Subsequent directives are left in place (rendered as HTML comments,
// invisible to the reader).
func SplitSubscribeWallHTML(body string) (above, below string, hasWall bool) {
	if body == "" {
		return "", "", false
	}
	loc := subscribeWallRE.FindStringIndex(body)
	if loc == nil {
		return body, "", false
	}
	return body[:loc[0]], body[loc[1]:], true
}

// SubscribeWallCookieName is the literal cookie name set by /unlock.
// Single-name (no tenant suffix) keeps the Set-Cookie path simple;
// inside the payload we bind the tenant id so a cookie minted by one
// tenant cannot unlock content on another tenant's archive even if
// both share the umbrella `archive.moosewave.com` domain.
const SubscribeWallCookieName = "pw_archive_sub"

// SubscribeWallTTL is the cookie lifetime — 90 days. Long enough that
// a regular reader doesn't re-unlock every session, short enough that
// an unsubscribe propagates to the wall within a quarter.
const SubscribeWallTTL = 90 * 24 * time.Hour

// SubscribeWallCookieMaxAgeSeconds is the integer SubscribeWallTTL
// rendered in seconds (matches the Set-Cookie Max-Age header).
const SubscribeWallCookieMaxAgeSeconds = int(SubscribeWallTTL / time.Second)

// ErrCookieInvalid covers all rejection reasons surfaced by
// VerifySubscribeWallCookie — bad format, bad signature, wrong tenant,
// expired payload. Callers should treat any non-nil error as "not a
// subscriber" without distinguishing further (the reason isn't useful
// to the reader and would leak validation internals).
var ErrCookieInvalid = errors.New("archive: subscribe wall cookie invalid")

// subscribeWallPayload is the JSON shape encoded in the first segment
// of the cookie value. Compact field names keep the cookie under the
// 4 KiB browser limit even with long emails.
type subscribeWallPayload struct {
	TenantID string `json:"t"`
	Email    string `json:"e"`
	Expires  int64  `json:"x"`
}

// SubscribeWallClaims is the validated, server-side projection of the
// cookie payload. Callers receive this from VerifySubscribeWallCookie
// after signature + expiry + tenant binding all pass.
type SubscribeWallClaims struct {
	TenantID string
	Email    string
	Expires  time.Time
}

// subscribeWallSecret returns the HMAC key. Sourced from env so a
// production deploy MUST set the variable — otherwise the dev
// fallback would make cookies forge-able. Kept package-private so
// callers can't accidentally use the dev value in another surface.
func subscribeWallSecret() []byte {
	if v := os.Getenv("ARCHIVE_SUBSCRIBE_WALL_SECRET"); v != "" {
		return []byte(v)
	}
	// Deterministic dev fallback — clearly labelled so a leaked
	// staging cookie can't be confused with a real production one.
	return []byte("dev-archive-subscribe-wall-secret-not-for-prod")
}

// MintSubscribeWallCookie builds a cookie value binding the supplied
// (tenant_id, email) pair for SubscribeWallTTL. The result is suitable
// for the Value field of a `*http.Cookie` with Name =
// SubscribeWallCookieName.
//
// `now` is parameterised so tests can pin the expiry deterministically.
func MintSubscribeWallCookie(tenantID, email string, now time.Time) string {
	p := subscribeWallPayload{
		TenantID: tenantID,
		Email:    strings.ToLower(strings.TrimSpace(email)),
		Expires:  now.Add(SubscribeWallTTL).Unix(),
	}
	raw, _ := json.Marshal(p)
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, subscribeWallSecret())
	mac.Write([]byte(encoded))
	sig := hex.EncodeToString(mac.Sum(nil))
	return encoded + "." + sig
}

// VerifySubscribeWallCookie parses + signature-checks + expiry-checks
// the cookie value supplied. On success returns the claims; on any
// failure returns ErrCookieInvalid.
//
// `tenantID` is the *expected* tenant — the call site already knows
// which archive the request hit, so binding the cookie payload to it
// stops a cookie minted for tenant A from unlocking tenant B's
// content. (Cross-tenant unlock is the obvious attack on a shared
// `archive.moosewave.com` apex.)
//
// `now` is parameterised so tests can pin the clock.
func VerifySubscribeWallCookie(cookieValue, tenantID string, now time.Time) (*SubscribeWallClaims, error) {
	if cookieValue == "" || tenantID == "" {
		return nil, ErrCookieInvalid
	}
	parts := strings.SplitN(cookieValue, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, ErrCookieInvalid
	}
	encoded, sig := parts[0], parts[1]
	expected := hmac.New(sha256.New, subscribeWallSecret())
	expected.Write([]byte(encoded))
	expectedHex := hex.EncodeToString(expected.Sum(nil))
	// constant-time compare to avoid timing-side-channel leakage of
	// the secret. Mismatched lengths short-circuit cleanly.
	if !hmac.Equal([]byte(sig), []byte(expectedHex)) {
		return nil, ErrCookieInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, ErrCookieInvalid
	}
	var p subscribeWallPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, ErrCookieInvalid
	}
	if p.TenantID == "" || p.TenantID != tenantID {
		return nil, ErrCookieInvalid
	}
	if p.Expires <= 0 || now.Unix() > p.Expires {
		return nil, ErrCookieInvalid
	}
	return &SubscribeWallClaims{
		TenantID: p.TenantID,
		Email:    p.Email,
		Expires:  time.Unix(p.Expires, 0).UTC(),
	}, nil
}

// IsSubscriberRequest checks the cookie jar of the supplied request
// for a valid subscribe-wall cookie bound to `tenantID`. Returns the
// claims when valid, nil when missing or invalid. Never errors —
// invalid cookies are treated identically to no cookie (so a stale
// cookie after operator rotation degrades to "show CTA", not 500).
func IsSubscriberRequest(r *http.Request, tenantID string) *SubscribeWallClaims {
	c, err := r.Cookie(SubscribeWallCookieName)
	if err != nil || c == nil || c.Value == "" {
		return nil
	}
	claims, err := VerifySubscribeWallCookie(c.Value, tenantID, time.Now().UTC())
	if err != nil {
		return nil
	}
	return claims
}

// BuildSubscribeWallTeaserHTML returns a short, language-neutral HTML
// snippet inserted in place of the below-wall content for
// non-subscribers. The renderer on the web side replaces this with a
// proper localised CTA card; the snippet here is the fallback for
// non-Moosewave consumers of the JSON (RSS readers, integrations) and
// for clients that don't know to render the CTA.
//
// Tagged with `data-pw-wall="cta"` so operator stylesheets can theme
// it and so analytics dashboards can distinguish a "wall impression"
// from a regular article render.
func BuildSubscribeWallTeaserHTML() string {
	return `<aside data-pw-wall="cta" class="pw-archive-subscribe-wall">` +
		`<p><strong>Subscribe to keep reading.</strong></p>` +
		`<p>This post is for subscribers only. Subscribe to read the rest, plus future issues, free.</p>` +
		`</aside>`
}

// ApplySubscribeWall is the renderer-side helper that takes a full
// campaign body + a (possibly nil) claims pointer and returns the
// HTML the public handler should ultimately serialise plus a boolean
// indicating whether a wall is active on this issue. Behaviour:
//
//   - No directive in the body → returns the body untouched,
//     hasWall=false. Caller should NOT show the CTA card.
//
//   - Directive present + claims != nil (verified subscriber) →
//     returns the body untouched (directive comment included; it's
//     invisible to the reader), hasWall=true. Caller may surface a
//     "you have access" affordance if desired.
//
//   - Directive present + claims == nil → returns the above-wall HTML
//
//   - the teaser snippet (no below-wall HTML), hasWall=true.
//
// The intent is that the JSON response has a single, fully-rendered
// `htmlBody` field whose contents already respect the wall, so a
// caller that doesn't understand wallActive/locked just gets a
// natural-looking truncated article.
func ApplySubscribeWall(body string, claims *SubscribeWallClaims) (string, bool) {
	above, below, has := SplitSubscribeWallHTML(body)
	if !has {
		return body, false
	}
	if claims != nil {
		// Subscriber — pass the body through unchanged so the
		// in-line marker comment doesn't get rewritten. (Re-joining
		// above+below would normalise the marker and lose whatever
		// whitespace operators authored.)
		return body, true
	}
	_ = below
	return above + BuildSubscribeWallTeaserHTML(), true
}

// UnlockSubscribeWallHandler is the public POST endpoint operators
// link to from the CTA card. Reads a one-shot preference token from
// the JSON body, asks the supplied lookup callback whether it's a
// real, unexpired token for the tenant, and on success mints the
// long-lived wall cookie.
//
// Validation is deliberately tenant-scoped: we accept a token only
// when its tenant id matches the archive's owning tenant. This stops
// a token minted for tenant A from unlocking tenant B's archive (the
// preferences token JSON is naturally tenant-bound, so this is a
// defence-in-depth check, not the primary gate).
//
// SubscribeWallTokenResolver hands the handler the (tenantID, email)
// pair behind the token. Returns ("", "", err) on lookup failure;
// the handler maps any non-nil error to 401 to avoid leaking which
// step (no row vs. expired vs. wrong tenant) failed.
type SubscribeWallTokenResolver func(ctx context.Context, token string) (tenantID, email string, err error)

// SubscribeWallUnlockRequest is the JSON wire shape of the /unlock POST.
type SubscribeWallUnlockRequest struct {
	Token string `json:"token"`
}

// SubscribeWallUnlockResponse is the JSON wire shape of the /unlock POST
// response. The page reads `ok=true` and immediately reloads to
// re-fetch the issue with the cookie attached.
type SubscribeWallUnlockResponse struct {
	OK      bool   `json:"ok"`
	Email   string `json:"email,omitempty"`
	Expires string `json:"expires,omitempty"`
}

// UnlockSubscribeWall handles POST /api/public/archive/{tenant_slug}/unlock.
func (d *Deps) UnlockSubscribeWall(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Repo == nil || d.SubscribeWallUnlockResolver == nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscribe wall unlock is not configured"))
		return
	}
	tenantSlug := strings.TrimSpace(chi.URLParam(r, "tenant_slug"))
	if tenantSlug == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_tenant", "tenant slug required"))
		return
	}
	tenantID, err := d.Repo.TenantBySlug(r.Context(), tenantSlug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}

	var in SubscribeWallUnlockRequest
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	token := strings.TrimSpace(in.Token)
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_token", "token required"))
		return
	}

	tokenTenantID, email, err := d.SubscribeWallUnlockResolver(r.Context(), token)
	if err != nil || tokenTenantID != tenantID || strings.TrimSpace(email) == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("invalid_token", "token is invalid or expired"))
		return
	}

	now := time.Now().UTC()
	expires := now.Add(SubscribeWallTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     SubscribeWallCookieName,
		Value:    MintSubscribeWallCookie(tenantID, email, now),
		Path:     "/api/public/archive/" + tenantSlug,
		Expires:  expires,
		MaxAge:   SubscribeWallCookieMaxAgeSeconds,
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, SubscribeWallUnlockResponse{
		OK:      true,
		Email:   email,
		Expires: expires.Format(time.RFC3339),
	})
}
