// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// MountRoutes wires every hub-facing endpoint. Read endpoints take
// read:reports; the throttle-override mutation is admin-only.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireExactTenantAdmin

	// Canonical "/hub/..." prefix on every hub-scoped sub-route so the
	// desktop client can compose the URLs from a single base. The two
	// non-prefixed legacy paths (kept as aliases) preserve API-key
	// integrations that already wired to the old surface — they emit
	// the same JSON body.
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub", d.getHub)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub/history", d.getHubHistory)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub/dns-health", d.getDNSHealth)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub/blocklist-hits", d.getBlocklistHits)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub/webhook-errors", d.getWebhookErrors)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/hub/bounce-class-breakdown", d.getBounceClassBreakdown)
	r.With(ProtectResponses, admin).Post("/api/v1/deliverability/hub/repair-override", d.postRepairOverride)

	// Legacy aliases — same handlers, no /hub prefix.
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/dns-health", d.getDNSHealth)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/blocklist-hits", d.getBlocklistHits)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/webhook-errors", d.getWebhookErrors)
	r.With(ProtectResponses, read).Get("/api/v1/deliverability/bounce-class-breakdown", d.getBounceClassBreakdown)
	r.With(ProtectResponses, admin).Post("/api/v1/deliverability/repair/override", d.postRepairOverride)

	r.With(ProtectResponses, read).Get("/api/v1/campaigns/{id}/health", d.getCampaignHealth)
}

// ProtectResponses keeps tenant deliverability evidence private even when a
// request is rejected before a handler runs (authentication, authorization,
// routing, body limits, or client-version policy). It is mounted both on this
// package's routes and at the root gateway boundary in main.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isProtectedDeliverabilityPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &protectedDeliverabilityResponseWriter{ResponseWriter: w, request: r}
		protected.apply()
		next.ServeHTTP(protected, r)
	})
}

func isProtectedDeliverabilityPath(path string) bool {
	if path == "/api/v1/deliverability/hub" ||
		strings.HasPrefix(path, "/api/v1/deliverability/hub/") {
		return true
	}
	switch path {
	case "/api/v1/deliverability/dns-health",
		"/api/v1/deliverability/blocklist-hits",
		"/api/v1/deliverability/webhook-errors",
		"/api/v1/deliverability/bounce-class-breakdown",
		"/api/v1/deliverability/repair/override":
		return true
	}
	return strings.HasPrefix(path, "/api/v1/campaigns/") && strings.HasSuffix(path, "/health")
}

// RepairOverrideGlobalReplayBypass keeps both repair aliases completely out of
// the generalized Idempotency-Key ledger. A durable cap commit can return a
// conservatively-fenced 503; replaying that cached response (or retrying past
// it into no_override) would erase the live control outcome. The selector is
// body-independent so the global middleware bypasses old entries before body,
// tenant, or replay-store access. The handler then rejects every supplied key.
func RepairOverrideGlobalReplayBypass(r *http.Request, _ []byte) bool {
	if r == nil || r.URL == nil {
		return false
	}
	switch r.URL.EscapedPath() {
	case "/api/v1/deliverability/hub/repair-override",
		"/api/v1/deliverability/repair/override":
		return true
	default:
		return false
	}
}

type protectedDeliverabilityResponseWriter struct {
	http.ResponseWriter
	request *http.Request
}

func (w *protectedDeliverabilityResponseWriter) apply() {
	setSensitiveEvidenceNoStoreHeaders(w.ResponseWriter)
	if w.request != nil &&
		(w.request.URL.Path == "/api/v1/deliverability/hub/repair-override" ||
			w.request.URL.Path == "/api/v1/deliverability/repair/override") &&
		!validRepairCapOutcome(w.Header().Get("X-Postwave-Sending-Cap-Outcome")) {
		w.Header().Set("X-Postwave-Sending-Cap-Outcome", "not-committed")
	}
}

func validRepairCapOutcome(outcome string) bool {
	switch outcome {
	case "not-committed",
		"committed",
		"committed-conservatively-fenced",
		"commit-outcome-unknown-conservatively-fenced":
		return true
	default:
		return false
	}
}

func (w *protectedDeliverabilityResponseWriter) WriteHeader(status int) {
	w.apply()
	w.ResponseWriter.WriteHeader(status)
}

func (w *protectedDeliverabilityResponseWriter) Write(body []byte) (int, error) {
	w.apply()
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *protectedDeliverabilityResponseWriter) FlushError() error {
	w.apply()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *protectedDeliverabilityResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// getHub GET /api/v1/deliverability/hub.
func (d *Deps) getHub(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	hub, err := d.computeHub(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, hub)
}

// getHubHistory GET /api/v1/deliverability/hub/history.
//
// Returns the sampled score history from deliverability_hub_snapshots
// in chronological order (oldest→newest). The desktop sparkline reads
// this; the snapshot worker writes one row per HubInterval (default
// hourly), so a default window of 30 days covers the rendered chart.
func (d *Deps) getHubHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		parsed, parseErr := strconv.Atoi(v)
		if parseErr != nil || parsed < 1 || parsed > 365 {
			httperror.WriteValidation(w, "bad_days", "days must be an integer between 1 and 365")
			return
		}
		days = parsed
	}
	since := d.now().Add(-time.Duration(days) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	type Snapshot struct {
		SampledAt       time.Time `json:"sampled_at"`
		Score           int       `json:"score"`
		ModelVersion    string    `json:"model_version"`
		SampleQualified bool      `json:"sample_qualified"`
		SampleSize      int64     `json:"sample_size"`
	}
	out := []Snapshot{}
	rows, qerr := tx.Query(r.Context(), `
SELECT sampled_at, score, model_version, sample_qualified, sample_size
  FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND model_version = $2
   AND sampled_at >= $3
 ORDER BY sampled_at ASC`, t.ID, DeliverabilityScoreModelVersion, since)
	if qerr != nil {
		httperror.WriteInternal(w, d.Logger, qerr, r.Context())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var s Snapshot
		if scanErr := rows.Scan(
			&s.SampledAt,
			&s.Score,
			&s.ModelVersion,
			&s.SampleQualified,
			&s.SampleSize,
		); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		out = append(out, s)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"snapshots":     out,
		"window_days":   days,
		"count":         len(out),
		"model_version": DeliverabilityScoreModelVersion,
	})
}

// getCampaignHealth GET /api/v1/campaigns/{id}/health (GAP-LS-086).
func (d *Deps) getCampaignHealth(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, parseErr := uuid.Parse(id); parseErr != nil {
		httperror.WriteValidation(w, "bad_id", "campaign id must be a UUID")
		return
	}
	h, err := d.computeCampaignHealth(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, h)
}

// getWebhookErrors GET /api/v1/deliverability/webhook-errors (GAP-LS-136).
//
// Surfaces failed outbound webhook deliveries from the last 7 days +
// failed DNS verifications from sending_identities. Both feed the
// Deliverability action center.
func (d *Deps) getWebhookErrors(w http.ResponseWriter, r *http.Request) {
	setSensitiveEvidenceNoStoreHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	since := d.now().Add(-7 * 24 * time.Hour)
	// WebhookErr shape mirrors the desktop's WebhookErrorRow exactly so
	// the WebhookErrorsTable can render the row without an adapter.
	// status_code is best-effort: parsed from the last_error string when
	// it begins with "HTTP <NNN>" — see parseStatusCode.
	type WebhookErr struct {
		ID            string    `json:"id"`
		Event         string    `json:"event"`
		URL           string    `json:"url,omitempty"`
		Error         string    `json:"error,omitempty"`
		StatusCode    int       `json:"status_code,omitempty"`
		AttemptCount  int       `json:"attempt_count"`
		LastAttemptAt time.Time `json:"last_attempt_at"`
		Status        string    `json:"status"`
	}
	errs := []WebhookErr{}
	rows, queryErr := tx.Query(r.Context(), `
SELECT d.id::text, COALESCE(w.url,''), d.event_type, d.status,
       COALESCE(d.last_error,''), d.attempt_count, d.created_at
  FROM outbound_webhook_deliveries d
  LEFT JOIN outbound_webhooks w ON w.id = d.webhook_id
 WHERE d.tenant_id = $1::uuid
   AND d.created_at >= $2
   AND d.status IN ('failed','retrying')
 ORDER BY d.created_at DESC
 LIMIT 200`, t.ID, since)
	if queryErr != nil {
		httperror.WriteInternal(w, d.Logger, queryErr, r.Context())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var e WebhookErr
		if scanErr := rows.Scan(&e.ID, &e.URL, &e.Event, &e.Status,
			&e.Error, &e.AttemptCount, &e.LastAttemptAt); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		rawError := e.Error
		e.StatusCode = parseStatusCode(rawError)
		e.URL = projectWebhookOrigin(e.URL)
		e.Error = projectWebhookFailure(rawError, e.StatusCode)
		errs = append(errs, e)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}

	type FailedVerify struct {
		IdentityID  string    `json:"identity_id"`
		Domain      string    `json:"domain"`
		VerifyState string    `json:"verify_state"`
		LastError   string    `json:"last_error"`
		LastAttempt time.Time `json:"last_attempt_at"`
	}
	verifies := []FailedVerify{}
	vrows, verifyQueryErr := tx.Query(r.Context(), `
SELECT id::text, domain, verify_state,
       COALESCE(last_verify_error,''),
       COALESCE(last_verify_attempt_at, now())
  FROM sending_identities
 WHERE tenant_id = $1::uuid
   AND verify_state IN ('broken','partial','pending')
 ORDER BY last_verify_attempt_at DESC NULLS LAST
 LIMIT 100`, t.ID)
	if verifyQueryErr != nil {
		httperror.WriteInternal(w, d.Logger, verifyQueryErr, r.Context())
		return
	}
	defer vrows.Close()
	for vrows.Next() {
		var v FailedVerify
		if scanErr := vrows.Scan(&v.IdentityID, &v.Domain, &v.VerifyState, &v.LastError, &v.LastAttempt); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		v.LastError = projectVerificationFailure(v.LastError)
		verifies = append(verifies, v)
	}
	if rowsErr := vrows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items":                errs,
		"failed_verifications": verifies,
		"window":               "7d",
		"count":                len(errs),
	})
}

// parseStatusCode extracts an HTTP status code from an error string of
// the form "HTTP 502 Bad Gateway" / "HTTP 500: ...". Returns 0 when no
// recognisable pattern is found.
func parseStatusCode(s string) int {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(strings.ToUpper(s), "HTTP ") {
		return 0
	}
	rest := strings.TrimSpace(s[len("HTTP "):])
	// First whitespace / ':' / '-' terminates the code.
	for i, r := range rest {
		if r == ' ' || r == ':' || r == '-' {
			rest = rest[:i]
			break
		}
	}
	code, err := strconv.Atoi(strings.TrimSpace(rest))
	if err != nil || code < 100 || code > 599 {
		return 0
	}
	return code
}

// getDNSHealth GET /api/v1/deliverability/hub/dns-health (GAP-LS-139).
// Mirrors the dns_health.Status shape so the desktop DnsHealthTable
// can be fed from either endpoint without an adapter. Pass-through
// over sending_identities; IsStale flips when last_attempt_at is older
// than 48 hours (matches the dns_health package threshold).
func (d *Deps) getDNSHealth(w http.ResponseWriter, r *http.Request) {
	setSensitiveEvidenceNoStoreHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	type Identity struct {
		ID                  string     `json:"id"`
		Domain              string     `json:"domain"`
		VerifyState         string     `json:"verify_state"`
		SPFVerifiedAt       *time.Time `json:"spf_verified_at,omitempty"`
		DKIMVerifiedAt      *time.Time `json:"dkim_verified_at,omitempty"`
		DMARCVerifiedAt     *time.Time `json:"dmarc_verified_at,omitempty"`
		LastAttemptAt       *time.Time `json:"last_attempt_at,omitempty"`
		LastError           string     `json:"last_error,omitempty"`
		IsStale             bool       `json:"is_stale"`
		HoursSinceLastCheck int        `json:"hours_since_last_check"`
	}
	out := []Identity{}
	rows, qerr := tx.Query(r.Context(), `
SELECT id::text, domain, verify_state,
       spf_verified_at,
       dkim_verified_at,
       dmarc_verified_at,
       last_verify_attempt_at,
       COALESCE(last_verify_error,'')
  FROM sending_identities
 WHERE tenant_id = $1::uuid
 ORDER BY (verify_state = 'verified'), domain`, t.ID)
	if qerr != nil {
		httperror.WriteInternal(w, d.Logger, qerr, r.Context())
		return
	}
	defer rows.Close()
	now := d.now()
	for rows.Next() {
		var i Identity
		if scanErr := rows.Scan(&i.ID, &i.Domain, &i.VerifyState,
			&i.SPFVerifiedAt, &i.DKIMVerifiedAt, &i.DMARCVerifiedAt,
			&i.LastAttemptAt, &i.LastError); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		i.LastError = projectVerificationFailure(i.LastError)
		if i.LastAttemptAt != nil {
			i.HoursSinceLastCheck = int(now.Sub(*i.LastAttemptAt) / time.Hour)
			if i.HoursSinceLastCheck < 0 {
				i.HoursSinceLastCheck = 0
			}
		} else {
			i.HoursSinceLastCheck = -1
		}
		i.IsStale = i.HoursSinceLastCheck > 48 || i.HoursSinceLastCheck < 0
		out = append(out, i)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"identities": out, "count": len(out)})
}

// getBlocklistHits GET /api/v1/deliverability/hub/blocklist-hits (GAP-LS-137).
//
// Returns `{items: [...]}` with stable per-row identifiers so the
// desktop BlocklistHitsTable can `key` on `id`. The zone column is the
// `list_name`; the subject column is the `identifier`; subject_type
// (ip/domain/url) is the `identifier_type`. We derive a synthetic
// `id` from those three fields so the row is stable across reloads.
const blocklistLatestRowsSQL = `
WITH latest AS (
  SELECT DISTINCT ON (subject_type, subject, zone)
         subject_type, subject, zone, listed, confidence, checked_at
    FROM blocklist_observations
   WHERE tenant_id = $1::uuid AND checked_at >= $2
   ORDER BY subject_type, subject, zone, checked_at DESC
)
SELECT subject_type, subject, zone, confidence, checked_at
  FROM latest WHERE listed = true
 ORDER BY checked_at DESC
 LIMIT 200`

func (d *Deps) getBlocklistHits(w http.ResponseWriter, r *http.Request) {
	setSensitiveEvidenceNoStoreHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	since := d.now().Add(-30 * 24 * time.Hour)
	type Hit struct {
		ID              string    `json:"id"`
		ListName        string    `json:"list_name"`
		Identifier      string    `json:"identifier"`
		IdentifierType  string    `json:"identifier_type"`
		FirstSeenAt     time.Time `json:"first_seen_at"`
		Confidence      float64   `json:"confidence"`
		Tier1           bool      `json:"tier1"`
		DelistingStatus string    `json:"delisting_status,omitempty"`
		DelistURL       string    `json:"delist_url,omitempty"`
	}
	out := []Hit{}
	rows, qerr := tx.Query(r.Context(), blocklistLatestRowsSQL, t.ID, since)
	if qerr != nil {
		httperror.WriteInternal(w, d.Logger, qerr, r.Context())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var h Hit
		if scanErr := rows.Scan(&h.IdentifierType, &h.Identifier, &h.ListName, &h.Confidence, &h.FirstSeenAt); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		h.ID = h.IdentifierType + "|" + h.Identifier + "|" + h.ListName
		h.Tier1 = h.Confidence >= 0.95
		// D10#16: populate the public self-service delist URL for the
		// zone so the "Delist" button actually renders. DelistingStatus
		// stays empty, which accurately means the workflow has not started.
		h.DelistURL = delistURLForZone(h.ListName, h.Identifier)
		out = append(out, h)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  out,
		"count":  len(out),
		"window": "30d",
	})
}

// delistURLForZone returns the public self-service delist / removal page
// for a well-known blocklist zone, or "" when none is known (D10#16). The
// identifier (IP or domain) is substituted into the pre-filled lookup
// where the provider supports it.
func delistURLForZone(zone, identifier string) string {
	z := strings.ToLower(strings.TrimSpace(zone))
	id := url.QueryEscape(strings.TrimSpace(identifier))
	switch {
	case strings.Contains(z, "spamhaus"):
		return "https://check.spamhaus.org/results?query=" + id
	case strings.Contains(z, "spamcop"):
		return "https://www.spamcop.net/bl.shtml?" + id
	case strings.Contains(z, "barracuda"):
		return "https://www.barracudacentral.org/rbl/removal-request"
	case strings.Contains(z, "surbl"):
		return "https://www.surbl.org/surbl-analysis?d=" + id
	case strings.Contains(z, "uceprotect"):
		return "https://www.uceprotect.net/en/rblcheck.php?ipr=" + id
	case strings.Contains(z, "sorbs"):
		return "http://www.sorbs.net/lookup.shtml?" + id
	case strings.Contains(z, "invaluement") || strings.Contains(z, "ivm"):
		return "https://www.invaluement.com/lookup/"
	default:
		return ""
	}
}

// getBounceClassBreakdown GET /api/v1/deliverability/bounce-class-breakdown (GAP-LS-140).
//
// Returns the percentage of bounces in each canonical class over the
// requested window. The bounceclass library lives in apps/api/internal/
// bounceclass; here we read raw bounce_events and bucket them by
// stored class. Series shape is daily so the chart can render a stacked
// area without an additional round-trip.
func (d *Deps) getBounceClassBreakdown(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	window := strings.TrimSpace(r.URL.Query().Get("window"))
	var days int
	switch window {
	case "7d":
		days = 7
	case "14d":
		days = 14
	case "30d", "":
		days = 30
	case "90d":
		days = 90
	default:
		httperror.WriteValidation(w, "bad_window", "window must be one of 7d, 14d, 30d, or 90d")
		return
	}
	since := d.now().Add(-time.Duration(days) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// We read bounces from subscriber_events (the canonical event log).
	// The bounce_type column carries the legacy hard/soft/spam_trap
	// label; the more granular bounceclass classification is computed
	// in the bounceclass library and persisted into bounce_events
	// (services/deliverability) when available. We surface both.
	//
	// Response shape mirrors the desktop's BounceClassBreakdownResponse
	// exactly: class_code / label / count / share at the row level,
	// window_days + total_bounces at the top level.
	type ClassRow struct {
		ClassCode string  `json:"class_code"`
		Label     string  `json:"label"`
		Count     int64   `json:"count"`
		Share     float64 `json:"share"`
	}
	rows, qerr := tx.Query(r.Context(), `
SELECT COALESCE(bounce_type,'unknown') AS class, count(*) AS n
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND event_type = 'bounced'
   AND at >= $2
 GROUP BY 1
 ORDER BY n DESC`, t.ID, since)
	if qerr != nil {
		httperror.WriteInternal(w, d.Logger, qerr, r.Context())
		return
	}
	defer rows.Close()
	totals := []ClassRow{}
	var total int64
	for rows.Next() {
		var c ClassRow
		if scanErr := rows.Scan(&c.ClassCode, &c.Count); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		c.Label = bounceClassLabel(c.ClassCode)
		totals = append(totals, c)
		total += c.Count
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}
	for i := range totals {
		if total > 0 {
			totals[i].Share = float64(totals[i].Count) / float64(total)
		}
	}

	// Daily series for the stacked-area chart. Same window, bucketed.
	type Bucket struct {
		Day    string           `json:"day"`
		Counts map[string]int64 `json:"counts"`
	}
	buckets := []Bucket{}
	srows, seriesErr := tx.Query(r.Context(), `
SELECT (at AT TIME ZONE 'UTC')::date AS day,
       COALESCE(bounce_type,'unknown') AS class,
       count(*)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND event_type = 'bounced'
   AND at >= $2
 GROUP BY 1, 2
 ORDER BY 1`, t.ID, since)
	if seriesErr != nil {
		httperror.WriteInternal(w, d.Logger, seriesErr, r.Context())
		return
	}
	defer srows.Close()
	dayMap := map[string]map[string]int64{}
	for srows.Next() {
		var day time.Time
		var class string
		var n int64
		if scanErr := srows.Scan(&day, &class, &n); scanErr != nil {
			httperror.WriteInternal(w, d.Logger, scanErr, r.Context())
			return
		}
		key := day.Format("2006-01-02")
		if _, exists := dayMap[key]; !exists {
			dayMap[key] = map[string]int64{}
		}
		dayMap[key][class] = n
	}
	if rowsErr := srows.Err(); rowsErr != nil {
		httperror.WriteInternal(w, d.Logger, rowsErr, r.Context())
		return
	}
	// Materialise daily buckets in chronological order.
	for cursor := since.Truncate(24 * time.Hour); !cursor.After(d.now()); cursor = cursor.Add(24 * time.Hour) {
		key := cursor.Format("2006-01-02")
		// A missing key yields the zero value for map[string]int64 -- nil -- and
		// a nil map marshals to JSON null. These buckets are materialised for
		// EVERY day in the window precisely so the series has no holes, so the
		// days with no bounces are the common case and the whole point; handing
		// the chart `"counts": null` for them defeats the materialisation.
		counts := dayMap[key]
		if counts == nil {
			counts = map[string]int64{}
		}
		buckets = append(buckets, Bucket{Day: key, Counts: counts})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"window_days":   days,
		"total_bounces": total,
		"classes":       totals,
		"series":        buckets,
	})
}

// bounceClassLabel renders a human label for a class code so the
// desktop legend doesn't have to maintain its own dictionary.
func bounceClassLabel(code string) string {
	switch code {
	case "hard":
		return "Hard"
	case "soft":
		return "Soft"
	case "block":
		return "Blocked"
	case "mailbox_full":
		return "Mailbox full"
	case "dns":
		return "DNS"
	case "content":
		return "Content"
	case "spam_trap":
		return "Spam trap"
	case "unknown", "":
		return "Unknown"
	default:
		return code
	}
}

// postRepairOverride POST /api/v1/deliverability/repair/override.
// Admin-only — clears an active auto-throttle so the operator can
// resume normal send rate after they fix the underlying issue.
func (d *Deps) postRepairOverride(w http.ResponseWriter, r *http.Request) {
	setSensitiveEvidenceNoStoreHeaders(w)
	w.Header().Set("X-Postwave-Sending-Cap-Outcome", "not-committed")
	if len(r.Header.Values("Idempotency-Key")) != 0 {
		httperror.Write(
			w,
			http.StatusBadRequest,
			"idempotency_forbidden",
			"Idempotency-Key is forbidden for this cap-control operation; inspect the live outcome before retrying",
		)
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	by := "admin"
	if u, ok := middleware.UserFromContext(r.Context()); ok && u.ID != "" {
		by = u.ID
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	if auditMeta.UserID == nil && auditMeta.ActorLabel != "" {
		by = auditMeta.ActorLabel
	}
	result, err := d.clearOverride(r.Context(), t.ID, by, auditMeta)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "no_override", "no active throttle to clear")
			return
		}
		if errors.Is(err, ErrThrottleCapDrift) {
			httperror.Write(
				w,
				http.StatusConflict,
				"override_cap_changed",
				"the sending cap changed after auto-throttle; review the current cap before clearing",
			)
			return
		}
		if errors.Is(err, sending.ErrCapChangeInProgress) {
			w.Header().Set("Retry-After", "1")
			httperror.Write(w, http.StatusConflict, "sending_cap_change_in_progress",
				"another sending-cap change is in progress; retry after it completes")
			return
		}
		if errors.Is(err, sending.ErrCapCoordinationUnavailable) {
			w.Header().Set("Retry-After", "1")
			writeRepairOverrideControlError(w,
				"sending_cap_coordination_unavailable",
				"sending-cap coordination is unavailable; the override was not cleared",
				"not-committed", false, false)
			return
		}
		if errors.Is(err, ErrThrottleCommitOutcomeUnknown) {
			w.Header().Set("Retry-After", "1")
			w.Header().Set("X-Postwave-Sending-Cap-Outcome", "commit-outcome-unknown-conservatively-fenced")
			writeRepairOverrideControlError(w,
				"sending_cap_commit_outcome_unknown",
				"the database commit outcome could not be proven; sends remain conservatively fenced",
				"commit-outcome-unknown-conservatively-fenced", false, false)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if result.CapConvergencePending {
		w.Header().Set("Retry-After", "1")
		w.Header().Set("X-Postwave-Sending-Cap-Outcome", "committed-conservatively-fenced")
		writeRepairOverrideControlError(w,
			"sending_cap_convergence_pending",
			"the override was cleared, but sending-cap convergence is still pending",
			"committed-conservatively-fenced", true, true)
		return
	}
	w.Header().Set("X-Postwave-Sending-Cap-Outcome", "committed")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                       true,
		"cleared":                  result.Cleared,
		"cap_coordination_outcome": "committed",
	})
}

func writeRepairOverrideControlError(
	w http.ResponseWriter,
	code, message, outcome string,
	ok, cleared bool,
) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
		"ok":                       ok,
		"cleared":                  cleared,
		"cap_coordination_outcome": outcome,
	})
}

// --- helpers --------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
