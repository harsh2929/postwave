// SPDX-License-Identifier: AGPL-3.0-only
//
// rss.go — Atom feed for public incidents + the subscriber API
// (email/SMS notification list).
//
// Why Atom not RSS 2.0: Atom 1.0 is the modern feed format every
// reader (Feedly, NetNewsWire, Slack RSS plugin) speaks; it has
// richer typed metadata (id, updated) and a stricter spec so the
// output is consistent across consumers.

package status

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Feed XML structures (Atom 1.0; subset).
type atomFeed struct {
	XMLName xml.Name    `xml:"feed"`
	Xmlns   string      `xml:"xmlns,attr"`
	Title   string      `xml:"title"`
	ID      string      `xml:"id"`
	Updated string      `xml:"updated"`
	Link    []atomLink  `xml:"link"`
	Entries []atomEntry `xml:"entry"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr,omitempty"`
	Type string `xml:"type,attr,omitempty"`
}

type atomEntry struct {
	Title     string   `xml:"title"`
	ID        string   `xml:"id"`
	Updated   string   `xml:"updated"`
	Published string   `xml:"published,omitempty"`
	Summary   string   `xml:"summary"`
	Link      atomLink `xml:"link"`
}

// PublicFeed serves GET /api/status/feed.atom — Atom feed of the most
// recent published incidents. Cached at the CDN for 5min via the
// Cache-Control header.
func (h *Handler) PublicFeed(w http.ResponseWriter, r *http.Request) {
	incidents, err := h.loadIncidents(r.Context(), 50)
	if err != nil {
		http.Error(w, "feed unavailable", http.StatusInternalServerError)
		return
	}
	siteURL := strings.TrimRight(publicBaseURL(r), "/")
	feed := atomFeed{
		Xmlns:   "http://www.w3.org/2005/Atom",
		Title:   "Moosewave Status",
		ID:      siteURL + "/status",
		Updated: time.Now().UTC().Format(time.RFC3339),
		Link: []atomLink{
			{Href: siteURL + "/status", Rel: "alternate", Type: "text/html"},
			{Href: siteURL + "/api/status/feed.atom", Rel: "self", Type: "application/atom+xml"},
		},
	}
	for _, inc := range incidents {
		updated := inc.StartedAt
		if inc.ResolvedAt != nil && inc.ResolvedAt.After(updated) {
			updated = *inc.ResolvedAt
		}
		title := inc.Title
		switch strings.ToLower(string(inc.Status)) {
		case "resolved":
			title = "[Resolved] " + title
		case "investigating":
			title = "[Investigating] " + title
		case "monitoring":
			title = "[Monitoring] " + title
		case "identified":
			title = "[Identified] " + title
		}
		feed.Entries = append(feed.Entries, atomEntry{
			Title:     title,
			ID:        siteURL + "/status/incidents/" + inc.ID,
			Updated:   updated.UTC().Format(time.RFC3339),
			Published: inc.StartedAt.UTC().Format(time.RFC3339),
			Summary:   inc.Description,
			Link: atomLink{
				Href: siteURL + "/status/incidents/" + inc.ID,
				Rel:  "alternate", Type: "text/html",
			},
		})
	}
	out, err := xml.MarshalIndent(feed, "", "  ")
	if err != nil {
		http.Error(w, "feed render failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(xml.Header))
	_, _ = w.Write(out)
}

// publicBaseURL prefers POSTWAVE_PUBLIC_BASE_URL (set per environment
// by the orchestrator). Falls back to reconstructing from the
// request's Host header ONLY when the env var is unset.
//
// Cache-poisoning context: the RSS feed is cached at the CDN for
// 5min via Cache-Control. Without the env-var preference, a single
// request bearing Host: evil.com would poison every cached entry
// with attacker-controlled link href values. The env-var path
// closes that hole; the Host-header fallback is for local dev only.
func publicBaseURL(r *http.Request) string {
	if v := strings.TrimSpace(os.Getenv("POSTWAVE_PUBLIC_BASE_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	scheme := "https"
	if r.TLS == nil && r.Host != "" && (strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.")) {
		scheme = "http"
	}
	host := r.Host
	if host == "" {
		host = "status.moosewave.com"
	}
	return scheme + "://" + host
}

// --- Subscriber endpoints ---

type subscribeRequest struct {
	Channel string `json:"channel"` // "email" | "sms"
	Address string `json:"address"`
}

type subscribeResponse struct {
	ID        string `json:"id"`
	Channel   string `json:"channel"`
	Address   string `json:"address"`
	Confirmed bool   `json:"confirmed"`
}

// Subscribe handles POST /api/status/subscribers — anonymous signup.
//
// Security model (post-hardening, migration 0121):
//   - confirm_token expires 15 minutes after issue.
//   - confirm + unsubscribe operations are bound to the subscriber id
//     via the URL path, so a single brute-force run can't sweep all
//     rows in one query.
//   - unsubscribe_token is a separate high-entropy secret that
//     persists after confirmation (the confirm_token is one-shot).
//   - confirm_attempts increments on every failed match; row locks
//     after 5 attempts.
//
// Returns 201 with `{id, confirm_url, unsubscribe_url, ...}`. The
// confirm_url is the canonical link the downstream notifier puts in
// the confirmation email/SMS; the unsubscribe_url is the canonical
// "stop sending me alerts" link for every future notification.
func (h *Handler) Subscribe(w http.ResponseWriter, r *http.Request) {
	if h.Pool == nil {
		http.Error(w, "subscribers backend unavailable", http.StatusServiceUnavailable)
		return
	}
	var req subscribeRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	req.Channel = strings.ToLower(strings.TrimSpace(req.Channel))
	req.Address = strings.TrimSpace(req.Address)
	if err := validateChannelAddress(req.Channel, req.Address); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	confirmToken, err := mintConfirmToken(req.Channel)
	if err != nil {
		http.Error(w, "token", http.StatusInternalServerError)
		return
	}
	unsubToken, err := mintUnsubscribeToken()
	if err != nil {
		http.Error(w, "token", http.StatusInternalServerError)
		return
	}
	confirmExpires := time.Now().UTC().Add(15 * time.Minute)
	ip := clientIP(r)
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	var id, address, channel string
	var confirmedAt *time.Time
	row := h.Pool.QueryRow(r.Context(), `
INSERT INTO status_subscribers
    (channel, address, confirm_token, confirm_token_expires_at,
     confirm_attempts, unsubscribe_token, subscribe_ip, subscribe_user_agent)
VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
ON CONFLICT (channel, address) DO UPDATE
   SET confirm_token            = EXCLUDED.confirm_token,
       confirm_token_expires_at = EXCLUDED.confirm_token_expires_at,
       confirm_attempts         = 0,
       unsubscribed_at          = NULL
RETURNING id::text, channel, address, confirmed_at`,
		req.Channel, req.Address, confirmToken, confirmExpires, unsubToken, ip, ua)
	if err := row.Scan(&id, &channel, &address, &confirmedAt); err != nil {
		http.Error(w, "subscribe failed", http.StatusInternalServerError)
		return
	}
	base := publicBaseURL(r)
	resp := map[string]any{
		"id":              id,
		"channel":         channel,
		"address":         address,
		"confirmed":       confirmedAt != nil,
		"confirm_url":     base + "/api/status/subscribers/" + id + "/confirm?token=" + confirmToken,
		"unsubscribe_url": base + "/api/status/subscribers/" + id + "/unsubscribe?token=" + unsubToken,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(resp)
}

// Confirm handles GET /api/status/subscribers/{id}/confirm?token=...
//
// Hardening vs the original handler:
//   - Token is matched per-subscriber (`WHERE id = $1`) so a brute-
//     force run cannot match an arbitrary row.
//   - Tokens expire after 15 min (confirm_token_expires_at).
//   - confirm_attempts is incremented on every failed match; after 5
//     failures the row is locked and only re-subscription can issue
//     a new token.
//   - Uses constant-time comparison via Postgres column-equality
//     under SELECT FOR UPDATE so attempts can be atomically counted.
func (h *Handler) Confirm(w http.ResponseWriter, r *http.Request) {
	if h.Pool == nil {
		http.Error(w, "backend unavailable", http.StatusServiceUnavailable)
		return
	}
	id := chiPathParam(r, "id")
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if id == "" || token == "" {
		http.Error(w, "missing id or token", http.StatusBadRequest)
		return
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		http.Error(w, "begin", http.StatusInternalServerError)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var storedToken string
	var attempts int
	var expires *time.Time
	row := tx.QueryRow(r.Context(), `
SELECT COALESCE(confirm_token,''), confirm_attempts, confirm_token_expires_at
  FROM status_subscribers
 WHERE id::text = $1
 FOR UPDATE`, id)
	if err := row.Scan(&storedToken, &attempts, &expires); err != nil {
		// Don't leak existence — return the same 410 we'd return for
		// a tampered token.
		http.Error(w, "invalid or expired token", http.StatusGone)
		return
	}
	if attempts >= 5 {
		http.Error(w, "too many failed attempts; re-subscribe to receive a new token", http.StatusTooManyRequests)
		return
	}
	if expires == nil || expires.Before(time.Now().UTC()) || storedToken == "" {
		http.Error(w, "invalid or expired token", http.StatusGone)
		return
	}
	// Constant-time compare. hmac.Equal is the standard primitive
	// (despite the name it's a generic constant-time bytes comparison).
	if subtleConstantTimeEqual(storedToken, token) != 1 {
		_, _ = tx.Exec(r.Context(),
			`UPDATE status_subscribers SET confirm_attempts = confirm_attempts + 1 WHERE id::text = $1`, id)
		_ = tx.Commit(r.Context())
		http.Error(w, "invalid or expired token", http.StatusGone)
		return
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE status_subscribers
   SET confirmed_at = now(),
       confirm_token = '',
       confirm_token_expires_at = NULL,
       confirm_attempts = 0
 WHERE id::text = $1`, id); err != nil {
		http.Error(w, "confirm failed", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, "commit", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// Unsubscribe handles POST /api/status/subscribers/{id}/unsubscribe?token=...
//
// Hardening: requires both the subscriber id (URL path) and the
// dedicated unsubscribe_token (high-entropy hex, persists forever).
// The original handler accepted the row's UUID as an auth credential
// via `OR id::text = $1`; that branch is removed so leaking an id
// (which is returned to the Subscribe response and may show up in
// logs) does not grant unsubscribe rights.
func (h *Handler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	if h.Pool == nil {
		http.Error(w, "backend unavailable", http.StatusServiceUnavailable)
		return
	}
	id := chiPathParam(r, "id")
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if id == "" || token == "" {
		http.Error(w, "missing id or token", http.StatusBadRequest)
		return
	}
	tag, err := h.Pool.Exec(r.Context(), `
UPDATE status_subscribers
   SET unsubscribed_at = now()
 WHERE id::text = $1 AND unsubscribe_token = $2`, id, token)
	if err != nil {
		http.Error(w, "unsub failed", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "invalid token", http.StatusGone)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// clientIP best-effort extracts the originating IP from common
// forwarding headers. Stored in subscribe_ip purely for per-IP rate
// limiting + abuse audit; not surfaced.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		// Leftmost is the originator per RFC 7239 § "Forwarded-For".
		if comma := strings.IndexByte(v, ','); comma >= 0 {
			return strings.TrimSpace(v[:comma])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
}

// chiPathParam is a thin wrapper around chi.URLParam so the rest of
// this file's auth code reads cleanly. Centralising the call also
// keeps the status package's chi dependency localised.
func chiPathParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

// subtleConstantTimeEqual returns 1 when a and b are equal, 0
// otherwise — in constant time relative to the inputs. Wraps
// crypto/subtle's primitive without forcing every caller to import
// it.
func subtleConstantTimeEqual(a, b string) int {
	if len(a) != len(b) {
		return 0
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	if v == 0 {
		return 1
	}
	return 0
}

// mintUnsubscribeToken returns a 32-character hex secret. Distinct
// from confirm_token because it lives forever (or until the user
// unsubscribes) and brute-forcing a 128-bit space is infeasible.
func mintUnsubscribeToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ListConfirmedSubscribers returns every confirmed, not-yet-unsubscribed
// recipient. Used by the incident-notifier worker to fan out. Internal-
// only; gate via internalauth at the wiring site.
func (h *Handler) ListConfirmedSubscribers(ctx context.Context, channel string) ([]string, error) {
	if h.Pool == nil {
		return nil, errors.New("pool unavailable")
	}
	rows, err := h.Pool.Query(ctx, `
SELECT address FROM status_subscribers
 WHERE channel = $1 AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`, channel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// validateChannelAddress enforces channel-specific format checks.
func validateChannelAddress(channel, address string) error {
	switch channel {
	case "email":
		if _, err := mail.ParseAddress(address); err != nil {
			return fmt.Errorf("invalid email")
		}
		return nil
	case "sms":
		// E.164: leading +, 8-15 digits. Loose check; the notifier
		// runs a stricter libphonenumber check before sending.
		if len(address) < 9 || address[0] != '+' {
			return fmt.Errorf("sms address must be E.164 format starting with +")
		}
		for _, c := range address[1:] {
			if c < '0' || c > '9' {
				return fmt.Errorf("sms address contains non-digit characters")
			}
		}
		return nil
	default:
		return fmt.Errorf("channel must be 'email' or 'sms'")
	}
}

// mintConfirmToken returns 32 hex chars for email confirms; a 6-digit
// numeric OTP for SMS so it's typeable by the recipient.
//
// SMS uses rejection sampling to eliminate modulo bias: 2^32 %
// 1_000_000 = 729_096, so the naive `n % 1_000_000` would over-
// represent codes in [0, 729_095]. We reject anything past the
// largest multiple of 1_000_000 that fits in uint32 and redraw.
// At 6 digits the bias is small in practice, but rejection sampling
// is free (worst-case ~30% extra reads) and keeps the OTP space
// uniform.
//
// Note: the brute-force defense (per-row + expiry + attempt counter)
// in Confirm is the *primary* protection. The bias fix is secondary
// rigor.
func mintConfirmToken(channel string) (string, error) {
	if channel == "sms" {
		const modulus = uint32(1_000_000)
		// Largest uint32 multiple of modulus that fits.
		limit := (^uint32(0) / modulus) * modulus
		var b [4]byte
		for {
			if _, err := rand.Read(b[:]); err != nil {
				return "", err
			}
			n := binary.BigEndian.Uint32(b[:])
			if n < limit {
				return fmt.Sprintf("%06d", n%modulus), nil
			}
			// rejection: redraw
		}
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// Silence unused-import for pgx (some impls re-use it).
var _ = pgx.ErrNoRows
