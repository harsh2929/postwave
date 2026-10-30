// Package sending — list-unsubscribe header builder for the drain
// loop.
//
// This file owns the per-recipient minting of preference tokens and
// the resulting RFC 2369 / RFC 8058 header values that ride on each
// Listmonk /api/tx call.
//
// Wire shape:
//
//	List-Unsubscribe: <https://app.example.com/api/public/preferences/<token>/one-click>,
//	                  <mailto:unsubscribe@example.com?subject=unsubscribe>
//	List-Unsubscribe-Post: List-Unsubscribe=One-Click
//
// The https URL points at the RFC 8058 POST handler in
// apps/api/internal/preferences (through the web API proxy). Human-facing
// body links still point at /preferences/<token>. The mailto target is read from
// per-tenant email_compliance_profiles.list_unsubscribe_mailto
// (migration 0234). When the mailto column is empty we omit the
// mailto value — the https-only single-value form is still
// RFC-compliant.
//
// Token minting:
//
//   - One token per recipient per send. We do NOT reuse an existing
//     token because the 30-day TTL would otherwise stretch indefinitely
//     across resends.
//   - Failure to mint is logged and the headers are dropped for that
//     recipient (the send proceeds without List-Unsubscribe). This is
//     a soft degradation: the compliance gate at /send time already
//     refused commercial sends without a verified profile, so we
//     should rarely take this branch in production.

package sending

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/unsubscribetoken"
)

// ListUnsubscribeBuilder mints per-recipient preference tokens and
// builds the RFC 2369 + RFC 8058 header values.
//
// Construction is cheap; one instance is shared by the entire send
// loop. The PublicBaseURL is read once at boot from the
// POSTWAVE_PUBLIC_BASE_URL environment variable (or its config
// equivalent) and prepended to /preferences/<token>.
type ListUnsubscribeBuilder struct {
	// Pool is the database pool used to mint preference_tokens
	// rows and look up per-tenant list_unsubscribe_mailto. Must
	// not be nil at the call site.
	Pool *db.Pool
	// PublicBaseURL is the scheme+host the hosted preference page
	// is served from (e.g. https://app.postwave.io). The builder
	// appends `/api/public/preferences/<token>/one-click` to it. Empty disables the
	// builder — the loop will see nil-equivalent output and fall
	// back to the no-headers send path.
	PublicBaseURL string
	// TokenTTL is how long the minted preference_tokens row is
	// valid for. Defaults to 30 days when zero — the same default
	// the preferences package uses for human-facing links.
	TokenTTL time.Duration
}

// Headers returns the wire-header map for one recipient. Best-effort:
// any error during token minting or mailto lookup is reported back
// and the caller may proceed with no headers (degrading from
// one-click to "compose an email" only).
//
// Returns (nil, nil) when the builder is misconfigured (empty
// PublicBaseURL) so the loop can pass nil through to SendWithHeaders
// without an extra layer of nil-checking.
func (b *ListUnsubscribeBuilder) Headers(ctx context.Context, tenantID, subscriberEmail string) (map[string]string, error) {
	if b == nil || strings.TrimSpace(b.PublicBaseURL) == "" {
		return nil, nil
	}
	if b.Pool == nil {
		return nil, fmt.Errorf("list_unsubscribe: pool is nil")
	}
	// 1. Mint the preference token. Each send gets a fresh token
	// so leaked links from earlier campaigns don't accumulate.
	ttl := b.TokenTTL
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	token, err := b.mintToken(ctx, tenantID, subscriberEmail, ttl)
	if err != nil {
		return nil, fmt.Errorf("list_unsubscribe: mint token: %w", err)
	}
	// 2. Resolve the mailto fallback. Optional.
	mailto, _ := b.loadMailto(ctx, tenantID)

	// 3. Build the header values.
	base := strings.TrimRight(b.PublicBaseURL, "/")
	httpsURL := oneClickEndpointURL(base, token)
	httpsURL = strings.ReplaceAll(httpsURL, " ", "%20")

	var listUnsub string
	if mailto != "" {
		listUnsub = fmt.Sprintf("<%s>, <mailto:%s?subject=unsubscribe>", httpsURL, mailto)
	} else {
		listUnsub = fmt.Sprintf("<%s>", httpsURL)
	}
	return map[string]string{
		"List-Unsubscribe":      listUnsub,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	}, nil
}

// OneClickURL exposes just the https form of the unsubscribe URL,
// useful for the body-render path that replaces the {{
// unsubscribe_url }} token with a real per-recipient URL. Mints a
// fresh token (same lifecycle as Headers).
func (b *ListUnsubscribeBuilder) OneClickURL(ctx context.Context, tenantID, subscriberEmail string) (string, error) {
	if b == nil || strings.TrimSpace(b.PublicBaseURL) == "" {
		return "", nil
	}
	if b.Pool == nil {
		return "", fmt.Errorf("list_unsubscribe: pool is nil")
	}
	ttl := b.TokenTTL
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	token, err := b.mintToken(ctx, tenantID, subscriberEmail, ttl)
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(b.PublicBaseURL, "/")
	return fmt.Sprintf("%s/preferences/%s", base, token), nil
}

// HeadersBatch mints per-recipient preference tokens for a batch in a
// single tenant-scoped tx and looks up the (per-tenant) mailto value
// once. Returns a map keyed by lower-cased email, each value being the
// fully-formed header map for that recipient.
//
// Why batch: the prior call site invoked Headers() once per recipient,
// which each opened a 2s-budget context, then a fresh db.WithTenant
// tenant tx for the mint INSERT plus a SECOND tx for the mailto SELECT.
// A 50-row batch therefore burned 100 tenant-tx setups before the
// first Listmonk POST. Folding the mailto lookup into one query and
// the N mint INSERTs into one tx amortises both costs across the
// batch (one set_config, one commit).
//
// On any fatal error (tx open / commit) returns (nil, err) and the
// caller falls back to per-row Headers calls so individual recipients
// can still be served.
func (b *ListUnsubscribeBuilder) HeadersBatch(ctx context.Context, tenantID string, emails []string) (map[string]map[string]string, error) {
	out := make(map[string]map[string]string, len(emails))
	if b == nil || strings.TrimSpace(b.PublicBaseURL) == "" {
		return out, nil
	}
	if b.Pool == nil {
		return out, fmt.Errorf("list_unsubscribe: pool is nil")
	}
	if len(emails) == 0 {
		return out, nil
	}

	// Resolve the per-tenant mailto fallback ONCE. The single-recipient
	// path swallows this error so we do the same here — the worst case
	// is the headers omit the mailto target.
	mailto, _ := b.loadMailto(ctx, tenantID)

	ttl := b.TokenTTL
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	expiresAt := time.Now().UTC().Add(ttl)

	// One tx for all mint INSERTs in the batch. The set_config / RLS
	// GUC bind happens once; each INSERT is a one-row write so the
	// commit is cheap. Failure of any single INSERT errors the entire
	// batch — the caller falls back to per-row Headers() so individual
	// recipients can still be served.
	tx, err := db.WithTenant(ctx, b.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	base := strings.TrimRight(b.PublicBaseURL, "/")
	seen := make(map[string]struct{}, len(emails))
	for _, e := range emails {
		em := strings.ToLower(strings.TrimSpace(e))
		if em == "" {
			continue
		}
		if _, dup := seen[em]; dup {
			continue
		}
		seen[em] = struct{}{}

		token, terr := newRandomToken()
		if terr != nil {
			return nil, terr
		}
		if _, ierr := tx.Exec(ctx, `
INSERT INTO preference_tokens (token, tenant_id, subscriber_email, expires_at)
VALUES ($1, $2::uuid, $3::citext, $4)`,
			token, tenantID, em, expiresAt); ierr != nil {
			return nil, ierr
		}
		httpsURL := oneClickEndpointURL(base, token)
		httpsURL = strings.ReplaceAll(httpsURL, " ", "%20")
		var listUnsub string
		if mailto != "" {
			listUnsub = fmt.Sprintf("<%s>, <mailto:%s?subject=unsubscribe>", httpsURL, mailto)
		} else {
			listUnsub = fmt.Sprintf("<%s>", httpsURL)
		}
		out[em] = map[string]string{
			"List-Unsubscribe":      listUnsub,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// mintToken inserts a single-use preference_tokens row. Schema
// matches preferences.Repo.CreateToken — kept in-package so this
// file doesn't depend on preferences (which would close an import
// cycle if preferences ever wanted to talk to sending).
func (b *ListUnsubscribeBuilder) mintToken(ctx context.Context, tenantID, email string, ttl time.Duration) (string, error) {
	token, err := newRandomToken()
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().UTC().Add(ttl)
	tx, err := db.WithTenant(ctx, b.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO preference_tokens (token, tenant_id, subscriber_email, expires_at)
VALUES ($1, $2::uuid, $3::citext, $4)`,
		token, tenantID, strings.ToLower(strings.TrimSpace(email)), expiresAt); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return token, nil
}

// loadMailto reads the per-tenant mailto fallback from migration 0234.
// Missing column (older schemas) and missing row are both reported as
// empty string — the caller degrades to https-only.
func (b *ListUnsubscribeBuilder) loadMailto(ctx context.Context, tenantID string) (string, error) {
	tx, err := db.WithTenant(ctx, b.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var mailto string
	row := tx.QueryRow(ctx, `
SELECT COALESCE(list_unsubscribe_mailto, '')
  FROM email_compliance_profiles
 WHERE tenant_id = $1::uuid`, tenantID)
	if err := row.Scan(&mailto); err != nil {
		// Column-missing / no-row → empty (no mailto), not an error.
		return "", nil //nolint:nilerr
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return strings.TrimSpace(mailto), nil
}

// RenderUnsubscribePlaceholder substitutes every `{{ unsubscribe_url }}`
// placeholder in a campaign body with the supplied URL. The accepted
// spellings live in package unsubscribetoken, which the compliance gate
// reads too, so a body that passes the gate is exactly a body this renders.
// Empty url => no substitution (the placeholder remains in-body which the
// compliance gate already rejects).
func RenderUnsubscribePlaceholder(html, url string) string {
	return unsubscribetoken.Render(html, url)
}

// oneClickEndpointURL is the exact URL advertised to mailbox providers. They
// POST the RFC 8058 form body to this route; advertising the human preference
// page would return 405 because that page intentionally has no POST handler.
func oneClickEndpointURL(base, token string) string {
	return fmt.Sprintf(
		"%s/api/public/preferences/%s/one-click",
		strings.TrimRight(base, "/"),
		token,
	)
}

// preferenceCenterURL converts the RFC 8058 endpoint back to the human page
// used for the in-message unsubscribe link. Both URLs use the same token.
func preferenceCenterURL(oneClickURL string) string {
	const marker = "/api/public/preferences/"
	i := strings.Index(oneClickURL, marker)
	if i < 0 || !strings.HasSuffix(oneClickURL, "/one-click") {
		return oneClickURL
	}
	token := strings.TrimSuffix(oneClickURL[i+len(marker):], "/one-click")
	if token == "" || strings.Contains(token, "/") {
		return oneClickURL
	}
	return oneClickURL[:i] + "/preferences/" + token
}

// newRandomToken yields a 64-hex-char token (32 random bytes). Kept
// inline rather than importing preferences.NewToken to avoid the
// import cycle that would create.
func newRandomToken() (string, error) {
	return randomHex(32)
}

// randomHex returns n random bytes encoded as a 2n-character hex
// string. Used to mint preference tokens.
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("list_unsubscribe: rand: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// extractFirstURL pulls the https URL out of a List-Unsubscribe
// header value like `<https://app.example.com/x>, <mailto:u@e.com>`.
// Returns (url, true) on success. Conservative — returns ("", false)
// on any parse anomaly so callers can fall back to the original body.
func extractFirstURL(headerValue string) (string, bool) {
	if headerValue == "" {
		return "", false
	}
	// Find the first `<...>` segment.
	start := strings.Index(headerValue, "<")
	if start < 0 {
		return "", false
	}
	end := strings.Index(headerValue[start+1:], ">")
	if end < 0 {
		return "", false
	}
	candidate := strings.TrimSpace(headerValue[start+1 : start+1+end])
	if !strings.HasPrefix(strings.ToLower(candidate), "http://") &&
		!strings.HasPrefix(strings.ToLower(candidate), "https://") {
		return "", false
	}
	return candidate, true
}
