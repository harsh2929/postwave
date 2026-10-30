// SPDX-License-Identifier: AGPL-3.0-only
//
// one_click.go — RFC 8058 (One-Click List-Unsubscribe) endpoint.
//
// Gmail and Yahoo enforce one-click unsubscribe for any sender hitting
// >= 5000 messages/day to their domains. The wire contract is:
//
//   1. The outbound email carries a List-Unsubscribe header with two
//      values: a mailto: target AND an https: target.
//   2. It ALSO carries List-Unsubscribe-Post: List-Unsubscribe=One-Click.
//   3. The mailbox provider POSTs to the https URL with body
//      `List-Unsubscribe=One-Click` and Content-Type
//      application/x-www-form-urlencoded.
//   4. The server MUST honour the request without further user
//      interaction — no JSON, no captcha, no second click.
//
// This handler is the receive side of that contract. It:
//
//   - Validates the preference token (binds to one (tenant, email)).
//   - Verifies the request body contains the canonical
//     `List-Unsubscribe=One-Click` indicator (accepted variants:
//     form-urlencoded or the same bytes as raw body).
//   - Inserts a suppression with reason='one_click' so the send loop
//     refuses subsequent commercial sends to that address.
//   - Writes a consent_events row with action='revoked', source=
//     'one_click', so the consent ledger captures the opt-out.
//   - Marks every topic for that subscriber as opted-out (best-effort)
//     so dashboards reflect the state.
//   - Returns 200 with an empty body. RFC 8058 is silent on response
//     content; mailbox providers only check status.

package preferences

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// oneClickMaxBodyBytes caps the inbound body. RFC 8058 bodies are
// tiny (literally `List-Unsubscribe=One-Click`); 1 KiB is generous.
const oneClickMaxBodyBytes int64 = 1 << 10

// oneClickIndicator is the canonical RFC 8058 body marker. We match
// case-insensitively because Gmail historically lowercases keys in
// form-encoded posts.
const oneClickIndicator = "list-unsubscribe=one-click"

// PublicOneClickUnsubscribe handles RFC 8058 one-click unsubscribe:
// POST /api/public/preferences/{token}/one-click
//
// The endpoint MUST be reachable with no auth header (Gmail/Yahoo POST
// from their own infrastructure) and MUST honour the request without
// any further interaction. Idempotent — repeated calls are no-ops.
func (d *Deps) PublicOneClickUnsubscribe(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_token", ""))
		return
	}
	pt, err := d.Repo.LookupToken(r.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenExpired):
			// 410 Gone preserves the "this link was once valid"
			// signal Gmail relies on for retry suppression.
			writeJSON(w, http.StatusGone, errEnv("token_expired", "preference link expired"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such token"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}

	// RFC 8058: body MUST contain `List-Unsubscribe=One-Click`. We
	// accept it as raw bytes OR as a form-encoded field with that
	// key. Gmail sends the latter; some smaller providers send the
	// former. Both are honoured here.
	isOneClick, parseErr := parseOneClickRequest(r)
	if parseErr != nil {
		if errors.Is(parseErr, httpbody.ErrTooLarge) {
			httpbody.WriteError(w, parseErr)
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv("not_one_click", "could not read one-click request"))
		return
	}
	if !isOneClick {
		writeJSON(w, http.StatusBadRequest, errEnv("not_one_click", "body must contain List-Unsubscribe=One-Click"))
		return
	}

	// Honour the request: suppress + consent-revoke + opt-out topics.
	if err := d.honorOneClick(r, pt.TenantID, pt.SubscriberEmail); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Gmail/Yahoo only check status; body can be empty. We emit a
	// tiny JSON envelope so developers hitting the endpoint by hand
	// see confirmation.
	writeJSON(w, http.StatusOK, map[string]any{"unsubscribed": true})
}

// requestIsOneClick parses the inbound body and returns true when the
// canonical `List-Unsubscribe=One-Click` indicator is present.
// Accepted variants:
//
//   - application/x-www-form-urlencoded with field
//     `List-Unsubscribe=One-Click` (Gmail/Yahoo standard).
//   - Any Content-Type with the literal bytes
//     `List-Unsubscribe=One-Click` somewhere in the body (some
//     mailbox providers don't set the Content-Type header).
//
// Empty body or any other payload returns false.
func requestIsOneClick(r *http.Request) bool {
	ok, _ := parseOneClickRequest(r)
	return ok
}

func parseOneClickRequest(r *http.Request) (bool, error) {
	if r.Body == nil {
		return false, nil
	}
	defer func() { _ = r.Body.Close() }()
	raw, err := httpbody.ReadAtMost(r.Body, oneClickMaxBodyBytes)
	if err != nil {
		return false, err
	}
	lower := strings.ToLower(strings.TrimSpace(string(raw)))
	if lower == "" {
		return false, nil
	}
	// Direct match on the literal indicator.
	if strings.Contains(lower, oneClickIndicator) {
		return true, nil
	}
	// Form-decoded match — some clients percent-encode the equals
	// sign. Parse defensively.
	values, err := url.ParseQuery(lower)
	if err == nil {
		if v := values.Get("list-unsubscribe"); strings.EqualFold(v, "one-click") {
			return true, nil
		}
	}
	return false, nil
}

// honorOneClick performs the three persistent writes that materialise
// the unsubscribe request:
//
//  1. Suppression list entry (the send loop's hard gate).
//  2. consent_events row with action='revoked' in the same transaction.
//  3. Best-effort: opt every topic out so the preference page reflects
//     the state if the subscriber later visits it.
//
// Errors in the suppression/evidence transaction are terminal (mailbox
// providers retry on non-2xx). Topic projection remains a non-authoritative
// best-effort mirror.
func (d *Deps) honorOneClick(r *http.Request, tenantID, email string) error {
	ctx := r.Context()
	evidence := OneClickEvidence{
		// RemoteAddr is the immediately connected API load-balancer/proxy in
		// production, not the mailbox provider or recipient. Until this endpoint
		// has an authenticated client-address handoff, omit IP rather than persist
		// infrastructure as false actor provenance.
		UserAgent: sanitizeOneClickUserAgent(r.UserAgent()),
	}
	// Suppression + canonical consent evidence are one atomic core mutation.
	// Reuse the production adapter when wired; the fallback keeps the same
	// transaction boundary for tests and development composition.
	if d.OneClickSuppressor != nil {
		if err := d.OneClickSuppressor.Add(ctx, tenantID, email, "one_click", evidence); err != nil {
			return err
		}
	} else {
		if err := d.fallbackOneClickMutation(ctx, tenantID, email, evidence); err != nil {
			return err
		}
	}
	// Topic projection is not the send-time hard gate or canonical evidence.
	_ = d.optOutAllTopics(ctx, tenantID, email)
	// 3. Webhook fanout — best-effort real-time mirror so partner
	// integrations see the opt-out without polling the consent
	// ledger. Nil-safe: tests pass no fanout adapter and skip.
	if d.UnsubscribeFanout != nil {
		d.UnsubscribeFanout.PublishUnsubscribe(tenantID, email, "one_click")
	}
	return nil
}

// fallbackOneClickMutation is the in-package atomic core used when the
// production adapter is not wired.
func (d *Deps) fallbackOneClickMutation(ctx context.Context, tenantID, email string, evidence OneClickEvidence) error {
	if d.Repo == nil || d.Repo.Pool == nil {
		return errors.New("preferences: no pool wired for one-click suppression")
	}
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, reason)
VALUES ($1::uuid, $2, 'one_click')
ON CONFLICT (tenant_id, email) DO UPDATE
    SET reason = COALESCE(EXCLUDED.reason, suppressions.reason)`,
		tenantID, strings.ToLower(strings.TrimSpace(email))); err != nil {
		return err
	}
	if _, err := EnsureOneClickConsentRevocation(ctx, tx, tenantID, email, evidence); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AppendOneClickConsentRevocation appends the canonical evidence row to the
// caller-owned transaction. Exported only for the composition adapter that
// also owns the canonical suppression and transactional webhook outbox.
func AppendOneClickConsentRevocation(ctx context.Context, tx pgx.Tx, tenantID, email string, evidence OneClickEvidence) error {
	var ipParam any
	if evidence.IP != "" {
		ipParam = evidence.IP
	}
	var userAgentParam any
	if evidence.UserAgent != "" {
		userAgentParam = evidence.UserAgent
	}
	_, err := tx.Exec(ctx, `
INSERT INTO consent_events
    (tenant_id, subject_type, subject_email, channel, category, action,
     source, policy_version, preferences, proof_text, ip, user_agent)
VALUES
    ($1::uuid, 'subscriber', $2::citext, 'email', 'email_marketing', 'revoked',
     'one_click', 'v1', '{}'::jsonb, 'RFC 8058 one-click unsubscribe', $3, $4)`,
		tenantID, strings.ToLower(strings.TrimSpace(email)), ipParam, userAgentParam)
	if err != nil {
		return err
	}
	return nil
}

// EnsureOneClickConsentRevocation heals an active legacy suppression that has
// no canonical RFC 8058 event, while keeping ordinary mailbox retries
// idempotent. The caller must already hold the matching suppression-row lock;
// both production and fallback mutations obtain it before calling this helper.
func EnsureOneClickConsentRevocation(ctx context.Context, tx pgx.Tx, tenantID, email string, evidence OneClickEvidence) (bool, error) {
	var ipParam any
	if evidence.IP != "" {
		ipParam = evidence.IP
	}
	var userAgentParam any
	if evidence.UserAgent != "" {
		userAgentParam = evidence.UserAgent
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO consent_events
    (tenant_id, subject_type, subject_email, channel, category, action,
     source, policy_version, preferences, proof_text, ip, user_agent)
SELECT
    $1::uuid, 'subscriber', $2::citext, 'email', 'email_marketing', 'revoked',
    'one_click', 'v1', '{}'::jsonb, 'RFC 8058 one-click unsubscribe', $3, $4
WHERE NOT EXISTS (
    SELECT 1
      FROM consent_events
     WHERE tenant_id = $1::uuid
       AND subject_email = $2::citext
       AND channel = 'email'
       AND category = 'email_marketing'
       AND action = 'revoked'
       AND source = 'one_click'
)`, tenantID, strings.ToLower(strings.TrimSpace(email)), ipParam, userAgentParam)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func sanitizeOneClickUserAgent(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !utf8.ValidString(value) || len(value) > 2048 || utf8.RuneCountInString(value) > 2048 {
		return ""
	}
	for _, char := range value {
		if unicode.IsControl(char) || unicode.In(char, unicode.Cf) {
			return ""
		}
	}
	return value
}

// optOutAllTopics flips every subscriber_topics row for this
// (tenant, email) pair to opted_in=false. Topics the subscriber
// never touched stay implicit (no row); the preference-page read
// path falls back to the topic default, so we explicitly insert
// opted_in=false rows for every tenant topic to make the opt-out
// stick across visits.
//
// Best-effort: any error is swallowed by the caller. We use the
// repo's tenant-scoped tx since this path runs inside the
// token-validated handler.
func (d *Deps) optOutAllTopics(ctx context.Context, tenantID, email string) error {
	if d.Repo == nil || d.Repo.Pool == nil {
		return errors.New("preferences: no pool wired for topic opt-out")
	}
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Discover every topic for this tenant. Empty list is fine —
	// not every tenant uses topics.
	rows, err := tx.Query(ctx, `
SELECT id::text FROM topics WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_topics (tenant_id, subscriber_email, topic_id, opted_in, at)
VALUES ($1::uuid, $2::citext, $3::uuid, false, now())
ON CONFLICT (tenant_id, subscriber_email, topic_id)
DO UPDATE SET opted_in = false, at = now()`,
			tenantID, email, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Compile-time guard — pgx import is used inside one of the helpers
// transitively (via db.WithTenant). Keep the symbol referenced so
// goimports doesn't strip it on future edits.
var _ = pgx.ErrNoRows
