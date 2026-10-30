// SPDX-License-Identifier: AGPL-3.0-only
//
// Package frequency implements tenant-level frequency caps applied at
// campaign queue-fill time. Closes parity with Customer.io's global
// frequency caps (G16 of the campaigns 2026 pack).
//
// Surface:
//
//	GET    /api/v1/sending/frequency-caps          (scope admin)
//	POST   /api/v1/sending/frequency-caps          (scope admin)
//	PATCH  /api/v1/sending/frequency-caps/{id}     (scope admin)
//	DELETE /api/v1/sending/frequency-caps/{id}     (scope admin)
//
// Filter wiring lives in apps/api/internal/campaigns/handlers_queue.go
// via the FilterAudience helper exposed here.
package frequency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Rule is one operator-configured frequency cap.
type Rule struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	MaxSends    int    `json:"max_sends"`
	WindowHours int    `json:"window_hours"`
	Active      bool   `json:"active"`
	// Channels is the SUB-133 per-channel scope (migration 1400). A rule
	// applies to a send on channel C when Channels contains C, OR Channels is
	// empty (which the filter treats as "applies to all channels"). The
	// migration default is ['email'] so existing rules keep their historic
	// email-only semantics. Surfaced in the CRUD response.
	Channels  []string  `json:"channels"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ruleAppliesToChannel reports whether rule r should be evaluated for a send on
// the given channel. An empty Channels set means "all channels" (a tenant that
// explicitly cleared the scope wants a global cap). An empty channel argument
// is normalised to "email" by the caller before this is reached.
func ruleAppliesToChannel(r Rule, channel string) bool {
	if len(r.Channels) == 0 {
		return true
	}
	for _, c := range r.Channels {
		if c == channel {
			return true
		}
	}
	return false
}

// defaultChannel is the channel assumed when a caller does not specify one,
// preserving the historic channel-agnostic behaviour (everything was email).
const defaultChannel = "email"

func normalizeChannel(channel string) string {
	channel = strings.TrimSpace(strings.ToLower(channel))
	if channel == "" {
		return defaultChannel
	}
	return channel
}

// SkipBreakdown describes one rule's contribution to a campaign's
// queue-time skip count. Surfaced in queueResponse so the operator can
// see which rule blocked the most recipients.
type SkipBreakdown struct {
	RuleID    string `json:"rule_id"`
	RuleLabel string `json:"rule_label"`
	Skipped   int    `json:"skipped"`
}

// FilterResult is what queueCampaignCore reads back from the filter.
type FilterResult struct {
	Kept      []string        `json:"kept,omitempty"`
	Skipped   int             `json:"skipped"`
	Breakdown []SkipBreakdown `json:"breakdown,omitempty"`
}

// Deps bundles the pgx pool + the mount handles.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error with tenant_id+request_id context while the
	// client only sees a generic envelope.
	Logger *slog.Logger

	// beginTenant and auditMutation are narrow test seams. Production leaves
	// both nil and uses db.WithTenant/db.Audit. Keeping them on Deps lets the
	// HTTP/CAS contract be exercised without a live Postgres instance while
	// retaining one real transaction for the rule write and its audit row.
	beginTenant   func(context.Context, string) (pgx.Tx, error)
	auditMutation func(context.Context, pgx.Tx, db.AuditMeta, string, string, string, map[string]any) error
}

func (d *Deps) tenantTx(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if d.beginTenant != nil {
		return d.beginTenant(ctx, tenantID)
	}
	return db.WithTenant(ctx, d.Pool, tenantID)
}

func (d *Deps) auditRuleMutation(ctx context.Context, tx pgx.Tx, meta db.AuditMeta, action, resourceID string, details map[string]any) error {
	if d.auditMutation != nil {
		return d.auditMutation(ctx, tx, meta, action, "frequency_cap_rules", resourceID, details)
	}
	return db.Audit(ctx, tx, meta, action, "frequency_cap_rules", resourceID, details)
}

// MountRoutes wires the frequency-cap settings surface. Reading a rule can
// disclose tenant policy and is part of the admin-only settings page, so all
// four routes require an exact tenant owner/admin session or admin-scoped API
// key. Stored custom-role grants cannot delegate this control plane.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || (d.Pool == nil && d.beginTenant == nil) {
		return
	}
	admin := apikeys.RequireExactTenantAdmin
	r.With(ProtectResponses, admin).Get("/api/v1/sending/frequency-caps", d.list)
	r.With(ProtectResponses, admin).Post("/api/v1/sending/frequency-caps", d.create)
	r.With(ProtectResponses, admin).Patch("/api/v1/sending/frequency-caps/{id}", d.patch)
	r.With(ProtectResponses, admin).Delete("/api/v1/sending/frequency-caps/{id}", d.delete)
}

// ProtectResponses stamps the frequency-cap path family before authorization,
// route matching, or handler execution. It is exported so the root router can
// mount it ahead of authentication as well as the package-local scope gate;
// unrelated routes are left untouched.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const base = "/api/v1/sending/frequency-caps"
		if r.URL.Path == base || strings.HasPrefix(r.URL.Path, base+"/") {
			protected := &frequencyProtectedResponseWriter{ResponseWriter: w}
			protected.apply()
			next.ServeHTTP(protected, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// frequencyProtectedResponseWriter reapplies the private cache boundary at
// the actual write point. Authentication middleware also sets Cache-Control
// on denials; without this wrapper that later header write could weaken
// "private, no-store" to merely "no-store".
type frequencyProtectedResponseWriter struct {
	http.ResponseWriter
}

func (w *frequencyProtectedResponseWriter) apply() {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (w *frequencyProtectedResponseWriter) WriteHeader(status int) {
	w.apply()
	w.ResponseWriter.WriteHeader(status)
}

func (w *frequencyProtectedResponseWriter) Write(body []byte) (int, error) {
	w.apply()
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private boundary is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *frequencyProtectedResponseWriter) FlushError() error {
	w.apply()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *frequencyProtectedResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// FilterAudience evaluates every active rule for tenantID against the
// candidate email list and returns the kept subset + a per-rule breakdown of
// who got skipped. A non-empty audience requires a configured store; missing
// policy authority is an error, never an allow-all result.
//
// Implementation: for each rule, runs a single SELECT against
// subscriber_send_log filtered by (tenant, sent_at >= now() - window,
// subscriber_email = ANY(candidates)) GROUP BY subscriber_email, then
// drops emails whose count >= max_sends. Multiple rules apply
// independently — an email skipped by rule A is removed from the
// candidate set before rule B's count query runs.
func FilterAudience(ctx context.Context, pool *db.Pool, tenantID string, candidates []string) (FilterResult, error) {
	return FilterAudienceForChannel(ctx, pool, tenantID, defaultChannel, candidates)
}

// FilterAudienceForChannel is the SUB-133 channel-aware variant of
// FilterAudience. It evaluates only rules that apply to the requested channel
// (see ruleAppliesToChannel). Each applicable rule counts the shared send
// history for every channel in that rule's Channels set; an empty set counts
// all channels. An empty requested channel is normalised to "email".
func FilterAudienceForChannel(ctx context.Context, pool *db.Pool, tenantID, channel string, candidates []string) (FilterResult, error) {
	if len(candidates) == 0 {
		return FilterResult{Kept: append([]string(nil), candidates...)}, nil
	}
	if pool == nil {
		return FilterResult{}, errors.New("frequency: frequency-cap store is not configured")
	}
	channel = normalizeChannel(channel)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return FilterResult{}, fmt.Errorf("open frequency-cap tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	all, err := listActiveRules(ctx, tx, tenantID)
	if err != nil {
		return FilterResult{}, err
	}
	if len(all) == 0 {
		return FilterResult{Kept: candidates}, nil
	}
	rules := make([]Rule, 0, len(all))
	for _, rule := range all {
		if ruleAppliesToChannel(rule, channel) {
			rules = append(rules, rule)
		}
	}
	if len(rules) == 0 {
		return FilterResult{Kept: candidates}, nil
	}

	kept := candidates
	skippedSet := map[string]struct{}{}
	breakdown := []SkipBreakdown{}

	for _, rule := range rules {
		if len(kept) == 0 {
			break
		}
		over, err := overCapEmails(ctx, tx, tenantID, kept, rule)
		if err != nil {
			return FilterResult{}, fmt.Errorf("evaluate frequency cap %s: %w", rule.ID, err)
		}
		if len(over) == 0 {
			continue
		}
		bd := SkipBreakdown{RuleID: rule.ID, RuleLabel: rule.Label, Skipped: len(over)}
		breakdown = append(breakdown, bd)
		overSet := make(map[string]struct{}, len(over))
		for _, e := range over {
			overSet[e] = struct{}{}
			skippedSet[e] = struct{}{}
		}
		// A NEW slice, never `kept[:0]`.
		//
		// `kept` starts as the caller's `candidates`, so filtering in place
		// rewrites the caller's own array: one call turns
		// [mixed, oneEmail, oneSMS] into [oneEmail, oneSMS, oneSMS] — the
		// over-cap recipient destroyed and another DUPLICATED. A caller that
		// filters the same candidate list for two channels, which is precisely
		// what a cross-channel cap invites, silently evaluates the second
		// channel against corrupted input and finds nobody over cap.
		//
		// It also means the returned Kept aliases the caller's argument, so
		// either one mutating afterwards corrupts the other.
		next := make([]string, 0, len(kept))
		for _, e := range kept {
			if _, hit := overSet[e]; !hit {
				next = append(next, e)
			}
		}
		kept = next
	}

	return FilterResult{
		Kept:      kept,
		Skipped:   len(skippedSet),
		Breakdown: breakdown,
	}, nil
}

// SubscriberPreferenceSkipRule is the synthetic SkipBreakdown rule_id/label
// emitted by FilterBySubscriberPreference so the queue response can attribute
// per-subscriber preference skips separately from tenant-level cap-rule skips.
const (
	SubscriberPreferenceSkipRule  = "subscriber_preference"
	SubscriberPreferenceSkipLabel = "Subscriber Frequency Preference"
)

// FilterBySubscriberPreference enforces the SUB-132 subscriber-level frequency
// preference at campaign queue admission. It removes from the candidate set every subscriber
// whose frequency_preference='paused' AND whose pause is still in effect — that
// is, paused_until IS NULL (paused indefinitely) OR paused_until is in the
// future. Subscribers with a 'weekly'/'monthly'/'default' preference, or whose
// paused_until has already elapsed (auto-reactivation), are kept.
//
// It is wired into the campaign queue-fill path AFTER the tenant-level
// frequency.FilterAudience pass, with its own SkipBreakdown entry
// (SubscriberPreferenceSkipRule) so the operator sees the per-subscriber skip
// count distinctly from the tenant cap-rule skips.
//
// This is an activation-time policy gate. Once there are candidates, missing
// storage or an unknown tenant/query/row state is an error: callers must not
// reinterpret an unreadable pause preference as permission to send.
func FilterBySubscriberPreference(ctx context.Context, pool *db.Pool, tenantID string, candidates []string) (FilterResult, error) {
	if len(candidates) == 0 {
		return FilterResult{Kept: append([]string(nil), candidates...)}, nil
	}
	if pool == nil {
		return FilterResult{}, errors.New("frequency: subscriber-preference store is not configured")
	}
	return filterBySubscriberPreferenceWithTenant(ctx, tenantID, candidates, func(ctx context.Context, tenantID string) (pgx.Tx, error) {
		return db.WithTenant(ctx, pool, tenantID)
	})
}

func filterBySubscriberPreferenceWithTenant(
	ctx context.Context,
	tenantID string,
	candidates []string,
	beginTenant func(context.Context, string) (pgx.Tx, error),
) (FilterResult, error) {
	if len(candidates) == 0 {
		return FilterResult{Kept: append([]string(nil), candidates...)}, nil
	}
	if beginTenant == nil {
		return FilterResult{}, errors.New("frequency: subscriber-preference tenant scope is not configured")
	}
	tx, err := beginTenant(ctx, tenantID)
	if err != nil {
		return FilterResult{}, fmt.Errorf("frequency: begin subscriber-preference tenant scope: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND frequency_preference = 'paused'
   AND (paused_until IS NULL OR paused_until > now())
   AND email::text = ANY($2::citext[])`,
		tenantID, candidates)
	if err != nil {
		return FilterResult{}, fmt.Errorf("frequency: query subscriber preferences: %w", err)
	}
	defer rows.Close()
	pausedSet := map[string]struct{}{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return FilterResult{}, fmt.Errorf("frequency: scan subscriber preference: %w", err)
		}
		pausedSet[strings.ToLower(strings.TrimSpace(email))] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return FilterResult{}, fmt.Errorf("frequency: iterate subscriber preferences: %w", err)
	}

	kept := make([]string, 0, len(candidates))
	skipped := 0
	for _, email := range candidates {
		if _, paused := pausedSet[strings.ToLower(strings.TrimSpace(email))]; !paused {
			kept = append(kept, email)
		} else {
			skipped++
		}
	}
	if skipped == 0 {
		return FilterResult{Kept: kept}, nil
	}
	breakdown := []SkipBreakdown{{
		RuleID:    SubscriberPreferenceSkipRule,
		RuleLabel: SubscriberPreferenceSkipLabel,
		Skipped:   skipped,
	}}
	return FilterResult{
		Kept:      kept,
		Skipped:   skipped,
		Breakdown: breakdown,
	}, nil
}

// RecordSend appends one explicit subscriber_send_log row. Production campaign
// queueing does not use this compatibility helper: QueueAndStartCampaign owns
// recipient admission and ledger insertion in one transaction.
func RecordSend(ctx context.Context, pool *db.Pool, tenantID, campaignID, email string) error {
	return RecordSendForChannel(ctx, pool, tenantID, campaignID, email, defaultChannel)
}

// RecordSendForChannel is the SUB-133 channel-aware variant of RecordSend. It
// stamps the channel the message left on (migration 1400 column) so the
// per-channel cap evaluation counts it under the right channel. An empty
// channel is normalised to "email".
func RecordSendForChannel(ctx context.Context, pool *db.Pool, tenantID, campaignID, email, channel string) error {
	if pool == nil {
		return errors.New("record frequency send: database pool is required")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return fmt.Errorf("record frequency send: open tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel) VALUES ($1::uuid, $2, $3::uuid, $4)`,
		tenantID, email, campaignID, normalizeChannel(channel)); err != nil {
		return fmt.Errorf("record frequency send: insert counter row: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("record frequency send: commit counter row: %w", err)
	}
	return nil
}

// RecordSendsBatch is the explicit bulk compatibility helper. Production
// campaign queueing inserts the same rows transactionally inside
// QueueAndStartCampaign; callers outside that workflow must handle the error.
func RecordSendsBatch(ctx context.Context, pool *db.Pool, tenantID, campaignID string, emails []string) error {
	return RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, emails, defaultChannel)
}

// RecordSendsBatchForChannel is the SUB-133 channel-aware bulk variant. It
// stamps every logged row with the channel the campaign dispatched on
// (migration 1400 column). An empty channel is normalised to "email" so the
// historic channel-agnostic queue-fill recording keeps counting under email.
func RecordSendsBatchForChannel(ctx context.Context, pool *db.Pool, tenantID, campaignID string, emails []string, channel string) error {
	if len(emails) == 0 {
		return nil
	}
	if pool == nil {
		return errors.New("record frequency sends: database pool is required")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return fmt.Errorf("record frequency sends: open tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel)
SELECT $1::uuid, unnest($2::citext[]), $3::uuid, $4`,
		tenantID, emails, campaignID, normalizeChannel(channel)); err != nil {
		return fmt.Errorf("record frequency sends: insert counter rows: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("record frequency sends: commit counter rows: %w", err)
	}
	return nil
}

func listActiveRules(ctx context.Context, tx pgx.Tx, tenantID string) ([]Rule, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, label, max_sends, window_hours, active,
	   COALESCE(channels, ARRAY[]::text[]), created_at, updated_at
  FROM frequency_cap_rules
 WHERE tenant_id = $1::uuid AND active`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out, err := scanRuleRows(rows)
	if err != nil {
		return nil, fmt.Errorf("list active frequency cap rules: %w", err)
	}
	return out, nil
}

// overCapEmails returns the subset of candidates that have already hit
// the rule's max_sends within the rule's window. Uses ANY($) array
// binding so the query plan is a single index scan over
// subscriber_send_log_lookup_idx.
func overCapEmails(ctx context.Context, tx pgx.Tx, tenantID string, candidates []string, rule Rule) ([]string, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(rule.WindowHours) * time.Hour)
	// SUB-133: a send on ANY channel in the rule's set counts toward the rule's
	// shared cap. For a cross-channel rule (channels=['email','sms']) a prior
	// email send AND a prior sms send both consume the same budget, so a
	// subscriber who got one of each hits a max_sends=2 cap regardless of which
	// channel this dispatch is on. countChannels is the rule's set when scoped,
	// or all channels (empty set => global cap) when the operator cleared the
	// scope. The requested `channel` only decides whether the rule APPLIES at
	// all (ruleAppliesToChannel, upstream); it does not narrow the count.
	// Channel matching uses the migration 1400 channel column (backfilled to
	// 'email' for legacy rows).
	countChannels := rule.Channels
	var (
		rows pgx.Rows
		err  error
	)
	if len(countChannels) == 0 {
		// Empty rule scope = global cap across all channels.
		rows, err = tx.Query(ctx, `
SELECT subscriber_email
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND sent_at >= $2
   AND subscriber_email = ANY($3::citext[])
 GROUP BY subscriber_email
HAVING count(*) >= $4`,
			tenantID, cutoff, candidates, rule.MaxSends)
	} else {
		rows, err = tx.Query(ctx, `
SELECT subscriber_email
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND channel = ANY($2::text[])
   AND sent_at >= $3
   AND subscriber_email = ANY($4::citext[])
 GROUP BY subscriber_email
HAVING count(*) >= $5`,
			tenantID, countChannels, cutoff, candidates, rule.MaxSends)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	over := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, fmt.Errorf("scan over-cap subscriber: %w", err)
		}
		over = append(over, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate over-cap subscribers: %w", err)
	}
	return over, nil
}

/* ---------- HTTP handlers ---------------------------------------- */

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := d.tenantTx(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, label, max_sends, window_hours, active,
	   COALESCE(channels, ARRAY[]::text[]), created_at, updated_at
 FROM frequency_cap_rules
 WHERE tenant_id = $1::uuid
	ORDER BY created_at`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out, err := scanRuleRows(rows)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": out})
}

type ruleRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanRuleRows(rows ruleRows) ([]Rule, error) {
	out := []Rule{}
	for rows.Next() {
		var ru Rule
		if err := rows.Scan(&ru.ID, &ru.Label, &ru.MaxSends, &ru.WindowHours, &ru.Active, &ru.Channels, &ru.CreatedAt, &ru.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan frequency cap rule: %w", err)
		}
		out = append(out, ru)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate frequency cap rules: %w", err)
	}
	return out, nil
}

type createInput struct {
	Label       string `json:"label"`
	MaxSends    int    `json:"max_sends"`
	WindowHours int    `json:"window_hours"`
	Active      *bool  `json:"active"`
	// Channels is the SUB-133 per-channel scope (migration 1400). Omitted /
	// empty defaults to ['email'] so a rule created without a channel keeps
	// the historic email-only semantics.
	Channels []string `json:"channels"`
}

var (
	errExpectedUpdatedAtRequired = errors.New("expected_updated_at is required")
	errExpectedUpdatedAtInvalid  = errors.New("expected_updated_at must be the exact non-zero RFC3339 updated_at value returned for the rule")
	errRuleNotFound              = errors.New("frequency cap rule not found")
	errRuleRevisionConflict      = errors.New("frequency cap rule revision conflict")
)

// parseRequiredExpectedUpdatedAt uses RawMessage so omitted and explicit null
// remain distinguishable: omission is a missing precondition (428), while a
// present non-string/null/malformed value is a bad precondition (400).
func parseRequiredExpectedUpdatedAt(raw json.RawMessage) (time.Time, error) {
	if len(raw) == 0 {
		return time.Time{}, errExpectedUpdatedAtRequired
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" || len(value) > 64 || strings.TrimSpace(value) != value {
		return time.Time{}, errExpectedUpdatedAtInvalid
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.IsZero() {
		return time.Time{}, errExpectedUpdatedAtInvalid
	}
	return parsed, nil
}

func writeExpectedUpdatedAtError(w http.ResponseWriter, err error) {
	if errors.Is(err, errExpectedUpdatedAtRequired) {
		writeErr(w, http.StatusPreconditionRequired, "precondition_required", "expected_updated_at is required and must match the exact rule revision")
		return
	}
	writeErr(w, http.StatusBadRequest, "invalid_expected_updated_at", errExpectedUpdatedAtInvalid.Error())
}

func validRuleID(w http.ResponseWriter, raw string) bool {
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw {
		writeErr(w, http.StatusBadRequest, "invalid_frequency_cap_id", "frequency cap id must be a canonical lowercase UUID")
		return false
	}
	return true
}

func writeRuleMutationError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	switch {
	case errors.Is(err, errRuleNotFound), errors.Is(err, pgx.ErrNoRows):
		writeErr(w, http.StatusNotFound, "not_found", "rule not found")
	case errors.Is(err, errRuleRevisionConflict):
		writeErr(w, http.StatusConflict, "frequency_cap_revision_conflict", "the frequency cap changed after it was loaded; reload before changing it")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func scanRuleRow(row pgx.Row) (Rule, error) {
	var ru Rule
	if err := row.Scan(
		&ru.ID, &ru.Label, &ru.MaxSends, &ru.WindowHours, &ru.Active,
		&ru.Channels, &ru.CreatedAt, &ru.UpdatedAt,
	); err != nil {
		return Rule{}, err
	}
	return ru, nil
}

func boundedAuditText(value string, maxRunes int) (string, bool) {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value, false
	}
	return string(runes[:maxRunes]), true
}

func ruleAuditSnapshot(rule Rule) map[string]any {
	label, labelTruncated := boundedAuditText(rule.Label, maxRuleLabelUTF16Units)
	channels := make([]string, 0, 3)
	for _, channel := range rule.Channels {
		if len(channels) == cap(channels) {
			break
		}
		bounded, _ := boundedAuditText(channel, 16)
		channels = append(channels, bounded)
	}
	snapshot := map[string]any{
		"label":        label,
		"max_sends":    rule.MaxSends,
		"window_hours": rule.WindowHours,
		"active":       rule.Active,
		"channels":     channels,
		"updated_at":   rule.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if labelTruncated {
		snapshot["label_truncated"] = true
	}
	if len(rule.Channels) > len(channels) {
		snapshot["channels_truncated"] = true
	}
	return snapshot
}

const maxRuleLabelUTF16Units = 160

// normalizeRuleLabel applies the shared desktop/API label boundary. The
// desktop uses JavaScript String.length and an HTML maxLength, both measured in
// UTF-16 code units. Count those units here rather than UTF-8 bytes or Go runes
// so every API-accepted label remains valid when decoded by the desktop.
func normalizeRuleLabel(label string) (string, string) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", "label is required"
	}
	units := 0
	for _, r := range label {
		units += utf16.RuneLen(r)
	}
	if units > maxRuleLabelUTF16Units {
		return "", fmt.Sprintf("label must be %d characters or fewer", maxRuleLabelUTF16Units)
	}
	return label, ""
}

// normalizeChannels trims, lowercases, de-duplicates, and rejects unknown
// channel names. An empty input returns ['email'] (the migration default) so a
// rule always carries an explicit scope. Returns ("", nil) on success or a
// validation message on an unknown channel.
func normalizeChannels(in []string) ([]string, string) {
	if len(in) == 0 {
		return []string{defaultChannel}, ""
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, c := range in {
		c = strings.TrimSpace(strings.ToLower(c))
		if c == "" {
			continue
		}
		switch c {
		case "email", "sms", "push":
		default:
			return nil, fmt.Sprintf("channel %q is not supported (allowed: email, sms, push)", c)
		}
		if _, dup := seen[c]; dup {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	if len(out) == 0 {
		return []string{defaultChannel}, ""
	}
	return out, ""
}

func (d *Deps) create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	label, msg := normalizeRuleLabel(in.Label)
	if msg != "" {
		httperror.WriteValidation(w, "validation_failed", msg)
		return
	}
	if msg := validateRule(in.MaxSends, in.WindowHours); msg != "" {
		httperror.WriteValidation(w, "validation_failed", msg)
		return
	}
	channels, msg := normalizeChannels(in.Channels)
	if msg != "" {
		httperror.WriteValidation(w, "validation_failed", msg)
		return
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	tx, err := d.tenantTx(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	ru, err := scanRuleRow(tx.QueryRow(r.Context(), `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active, channels)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
RETURNING id::text, label, max_sends, window_hours, active,
          COALESCE(channels, ARRAY[]::text[]), created_at, updated_at`,
		t.ID, label, in.MaxSends, in.WindowHours, active, channels,
	))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.auditRuleMutation(
		r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"settings.sending.frequency_cap.created", ru.ID,
		map[string]any{
			"route_template": "/api/v1/sending/frequency-caps",
			"after":          ruleAuditSnapshot(ru),
		},
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	responseBody, err := json.Marshal(map[string]any{"rule": ru})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// json.Encoder (used by writeJSON) terminates one JSON value with a
	// newline. Persist and write those same bytes so a replay is byte-exact.
	responseBody = append(responseBody, '\n')
	w.Header().Set("Content-Type", "application/json")
	storageKey, hasStorageKey := idempotency.StorageKeyFromContext(r.Context())
	requestHash, hasRequestHash := idempotency.RequestHashFromContext(r.Context())
	if hasStorageKey != hasRequestHash {
		httperror.WriteInternal(w, d.Logger, errors.New("frequency: incomplete idempotency request identity"), r.Context())
		return
	}
	if hasStorageKey {
		if err := idempotency.CompletePendingInTx(r.Context(), tx, &idempotency.Record{
			Key:             storageKey,
			TenantID:        t.ID,
			RequestHash:     requestHash,
			ResponseStatus:  http.StatusCreated,
			ResponseBody:    responseBody,
			ResponseHeaders: w.Header().Clone(),
		}); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(responseBody)
}

type patchInput struct {
	Label             *string         `json:"label"`
	MaxSends          *int            `json:"max_sends"`
	WindowHours       *int            `json:"window_hours"`
	Active            *bool           `json:"active"`
	ExpectedUpdatedAt json.RawMessage `json:"expected_updated_at"`
	// Channels is the SUB-133 per-channel scope (migration 1400). nil = leave
	// unchanged; a non-nil (possibly empty) value replaces the scope (an empty
	// array normalises to ['email']).
	Channels []string `json:"channels"`
}

func (d *Deps) patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if !validRuleID(w, id) {
		return
	}
	var in patchInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	expectedUpdatedAt, err := parseRequiredExpectedUpdatedAt(in.ExpectedUpdatedAt)
	if err != nil {
		writeExpectedUpdatedAtError(w, err)
		return
	}
	var normalizedLabel *string
	if in.Label != nil {
		label, msg := normalizeRuleLabel(*in.Label)
		if msg != "" {
			httperror.WriteValidation(w, "validation_failed", msg)
			return
		}
		normalizedLabel = &label
	}
	var normalizedChannels []string
	if in.Channels != nil {
		channels, msg := normalizeChannels(in.Channels)
		if msg != "" {
			httperror.WriteValidation(w, "validation_failed", msg)
			return
		}
		normalizedChannels = channels
	}
	tx, err := d.tenantTx(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Lock the exact row before comparing the client-observed revision. The
	// lock remains held through the rule write, audit insert, and commit.
	cur, err := scanRuleRow(tx.QueryRow(r.Context(), `
SELECT id::text, label, max_sends, window_hours, active,
	   COALESCE(channels, ARRAY[]::text[]), created_at, updated_at
	FROM frequency_cap_rules
	WHERE tenant_id = $1::uuid AND id = $2::uuid
	FOR UPDATE`, t.ID, id,
	))
	if err != nil {
		writeRuleMutationError(w, r, d, err)
		return
	}
	if !cur.UpdatedAt.Equal(expectedUpdatedAt) {
		writeRuleMutationError(w, r, d, errRuleRevisionConflict)
		return
	}
	nextLabel := cur.Label
	nextMax := cur.MaxSends
	nextWindow := cur.WindowHours
	nextActive := cur.Active
	nextChannels := cur.Channels
	if normalizedLabel != nil {
		nextLabel = *normalizedLabel
	}
	if in.MaxSends != nil {
		nextMax = *in.MaxSends
	}
	if in.WindowHours != nil {
		nextWindow = *in.WindowHours
	}
	if in.Active != nil {
		nextActive = *in.Active
	}
	if in.Channels != nil {
		nextChannels = normalizedChannels
	}
	if msg := validateRule(nextMax, nextWindow); msg != "" {
		httperror.WriteValidation(w, "validation_failed", msg)
		return
	}
	ru, err := scanRuleRow(tx.QueryRow(r.Context(), `
UPDATE frequency_cap_rules
	SET label = $3,
	    max_sends = $4,
	    window_hours = $5,
	    active = $6,
	    channels = $7,
	    updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $8::timestamptz
RETURNING id::text, label, max_sends, window_hours, active,
          COALESCE(channels, ARRAY[]::text[]), created_at, updated_at`,
		t.ID, id, nextLabel, nextMax, nextWindow, nextActive, nextChannels, expectedUpdatedAt,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			err = errRuleRevisionConflict
		}
		writeRuleMutationError(w, r, d, err)
		return
	}
	if err := d.auditRuleMutation(
		r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"settings.sending.frequency_cap.updated", ru.ID,
		map[string]any{
			"route_template":      "/api/v1/sending/frequency-caps/{id}",
			"expected_updated_at": expectedUpdatedAt.UTC().Format(time.RFC3339Nano),
			"before":              ruleAuditSnapshot(cur),
			"after":               ruleAuditSnapshot(ru),
		},
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rule": ru})
}

type deleteInput struct {
	ExpectedUpdatedAt json.RawMessage `json:"expected_updated_at"`
}

const frequencyDeleteJSONMaxBodyBytes int64 = 4 << 10

func (d *Deps) delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if !validRuleID(w, id) {
		return
	}
	var in deleteInput
	if err := httpbody.DecodeJSONWith(
		w, r, frequencyDeleteJSONMaxBodyBytes, &in,
		httpbody.Options{AllowEmptyBody: true},
	); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	expectedUpdatedAt, err := parseRequiredExpectedUpdatedAt(in.ExpectedUpdatedAt)
	if err != nil {
		writeExpectedUpdatedAtError(w, err)
		return
	}
	tx, err := d.tenantTx(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	cur, err := scanRuleRow(tx.QueryRow(r.Context(), `
SELECT id::text, label, max_sends, window_hours, active,
       COALESCE(channels, ARRAY[]::text[]), created_at, updated_at
  FROM frequency_cap_rules
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id))
	if err != nil {
		writeRuleMutationError(w, r, d, err)
		return
	}
	if !cur.UpdatedAt.Equal(expectedUpdatedAt) {
		writeRuleMutationError(w, r, d, errRuleRevisionConflict)
		return
	}
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM frequency_cap_rules
		  WHERE tenant_id = $1::uuid AND id = $2::uuid AND updated_at = $3::timestamptz`,
		t.ID, id, expectedUpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeRuleMutationError(w, r, d, errRuleRevisionConflict)
		return
	}
	if err := d.auditRuleMutation(
		r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"settings.sending.frequency_cap.deleted", cur.ID,
		map[string]any{
			"route_template":      "/api/v1/sending/frequency-caps/{id}",
			"expected_updated_at": expectedUpdatedAt.UTC().Format(time.RFC3339Nano),
			"before":              ruleAuditSnapshot(cur),
		},
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validateRule(maxSends, windowHours int) string {
	if maxSends <= 0 || maxSends > 1000 {
		return fmt.Sprintf("max_sends must be between 1 and 1000 (got %d)", maxSends)
	}
	if windowHours < 1 || windowHours > 720 {
		return fmt.Sprintf("window_hours must be between 1 and 720 (got %d)", windowHours)
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
