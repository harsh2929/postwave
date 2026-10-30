// SPDX-License-Identifier: AGPL-3.0-only
//
// Package scoring implements the lead-scoring engine.
//
// Two surfaces:
//
//   1. CRUD on scoring_rules — tenants configure per-event weights.
//   2. Worker that recomputes subscribers.engagement_score from
//      the last 90 days of subscriber_events.
//
// The score is a single smallint per subscriber. Downstream segments
// branch on it ("engagement_score > 50"). Automations branch on it
// via the same path. Keeping it as one column means zero schema
// change downstream — every existing tool that reads
// `subscribers.*` sees the score for free.

package scoring

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DefaultRules is the fallback set the worker applies when a tenant
// has no scoring_rules rows. Calibrated to mirror Mailchimp's
// observed defaults — operators don't need to configure anything
// to get a useful score.
var DefaultRules = map[string]int{
	"opened":       1,
	"clicked":      5,
	"replied":      10,
	"unsubscribed": -20,
	"complained":   -50,
	"bounced":      -10,
}

const (
	scoringWindowDays   = 90
	maxScoringRules     = 14
	maxScoringNoteRunes = 240
	maxScoringNoteBytes = 1024
)

// EventCatalog is the closed vocabulary enforced by the canonical
// subscriber_events table. The UI renders this instead of accepting event
// names that can never match production data.
var EventCatalog = []EventCatalogItem{
	{EventType: "opened", Label: "Email opened", Category: "engagement"},
	{EventType: "clicked", Label: "Link clicked", Category: "engagement"},
	{EventType: "replied", Label: "Email replied", Category: "engagement"},
	{EventType: "delivered", Label: "Email delivered", Category: "delivery"},
	{EventType: "bounced", Label: "Email bounced", Category: "delivery"},
	{EventType: "complained", Label: "Spam complaint", Category: "consent"},
	{EventType: "unsubscribed", Label: "Unsubscribed", Category: "consent"},
	{EventType: "suppressed", Label: "Suppressed", Category: "consent"},
	{EventType: "consent_changed", Label: "Consent changed", Category: "consent"},
	{EventType: "custom", Label: "Custom event", Category: "profile"},
	{EventType: "identified", Label: "Identity resolved", Category: "profile"},
	{EventType: "merged", Label: "Profile merged", Category: "profile"},
	{EventType: "status_changed", Label: "Subscriber status changed", Category: "profile"},
	{EventType: "lifecycle_stage_changed", Label: "Lifecycle stage changed", Category: "profile"},
}

type EventCatalogItem struct {
	EventType string `json:"event_type"`
	Label     string `json:"label"`
	Category  string `json:"category"`
}

// Rule is the wire shape for scoring_rules rows.
type Rule struct {
	ID        string `json:"id"`
	EventType string `json:"event_type"`
	Weight    int    `json:"weight"`
	Note      string `json:"note,omitempty"`
}

// Deps wires the handlers + worker.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers admin CRUD plus a compatibility route that fails
// closed until manual recompute has a durable job contract.
//
//	GET    /api/v1/scoring/rules            list rules
//	PUT    /api/v1/scoring/rules            replace the whole set
//	POST   /api/v1/scoring/recompute        stable unavailable response;
//	                                         automatic refresh remains active.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/scoring/rules", d.ListRules)
	r.With(admin).Put("/api/v1/scoring/rules", d.PutRules)
	r.With(admin).Post("/api/v1/scoring/recompute", d.RecomputeNow)
}

// ListRules GET /api/v1/scoring/rules.
func (d *Deps) ListRules(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	out, err := listRules(r.Context(), tx, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	version := ruleSetVersion(out)
	w.Header().Set("ETag", `"`+version+`"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"rules":         out,
		"defaults":      defaultRuleRows(),
		"event_catalog": EventCatalog,
		"version":       version,
		"window_days":   scoringWindowDays,
	})
}

// PutInput is the body of PUT /api/v1/scoring/rules.
type PutInput struct {
	Rules           []Rule `json:"rules"`
	ExpectedVersion string `json:"expected_version"`
}

// PutRules PUT /api/v1/scoring/rules — replace the whole set.
func (d *Deps) PutRules(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PutInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	normalized, reason := normalizeRules(in.Rules)
	if reason != "" {
		httperror.WriteValidation(w, "validation_failed", reason)
		return
	}
	in.ExpectedVersion = strings.TrimSpace(in.ExpectedVersion)
	if !validRuleSetVersion(in.ExpectedVersion) {
		httperror.WriteValidation(w, "validation_failed", "expected_version is required and must be the version returned by GET /api/v1/scoring/rules")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := lockScoringRuleSet(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	current, err := listRules(r.Context(), tx, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	currentVersion := ruleSetVersion(current)
	if currentVersion != in.ExpectedVersion {
		w.Header().Set("ETag", `"`+currentVersion+`"`)
		httperror.Write(w, http.StatusConflict, "scoring_rules_conflict", "Scoring rules changed after this draft loaded. Refresh and review the current rule set before saving again.")
		return
	}
	// Wipe and re-insert. Two-phase transaction keeps the period of
	// "empty rules" invisible to readers (worker uses the same tx
	// snapshot).
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM scoring_rules WHERE tenant_id = $1::uuid`, t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for _, rl := range normalized {
		_, err := tx.Exec(r.Context(), `
INSERT INTO scoring_rules (tenant_id, event_type, weight, note)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''))`,
			t.ID, strings.TrimSpace(rl.EventType), rl.Weight, rl.Note)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	version := ruleSetVersion(normalized)
	w.Header().Set("ETag", `"`+version+`"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"saved":   len(normalized),
		"version": version,
	})
}

// RecomputeNow POST /api/v1/scoring/recompute retains compatibility while
// failing closed. A synchronous tenant-wide scan has no preview, progress,
// cancellation, idempotency, or durable receipt and must not be operator-
// invocable. The background worker calls RecomputeTenant directly.
func (d *Deps) RecomputeNow(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	httperror.Write(
		w,
		http.StatusConflict,
		"scoring_recompute_unavailable",
		"Manual score recompute is unavailable until it runs as a previewed, cancellable, durable job with a receipt. Scores continue to refresh automatically.",
	)
}

// RecomputeTenant runs one tenant's recompute. Public so the
// background worker can call it without duplicating the SQL.
//
// Algorithm:
//
//  1. Load the tenant's rules (or default if none).
//  2. For each subscriber with engagement events in the last 90 days,
//     sum (count_per_event_type × weight_per_event_type).
//  3. UPDATE subscribers.engagement_score in one CTE.
//
// We use a single CTE so the entire recompute is one round-trip
// per tenant — important for large tenants where round-tripping
// per subscriber would be 100k+ queries.
func RecomputeTenant(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockScoringRuleSet(ctx, tx, tenantID); err != nil {
		return 0, err
	}

	// Load rules into a map so we can transmit them as a temp table
	// inside the CTE. Empty → seed with defaults.
	rules, err := loadRules(ctx, tx, tenantID)
	if err != nil {
		return 0, err
	}
	if len(rules) == 0 {
		rules = DefaultRules
	}

	// Build the VALUES clause for the rule table.
	if len(rules) == 0 {
		// No rules + no defaults (shouldn't happen, defensive) → zero stale
		// scores. Rows that are already zero are not rewritten.
		tag, err := tx.Exec(ctx,
			`UPDATE subscribers SET engagement_score = 0, engagement_score_at = now()
				   WHERE tenant_id = $1::uuid AND engagement_score IS DISTINCT FROM 0`, tenantID)
		if err != nil {
			return 0, err
		}
		return tag.RowsAffected(), tx.Commit(ctx)
	}

	eventTypes := make([]string, 0, len(rules))
	weights := make([]int, 0, len(rules))
	for et, w := range rules {
		eventTypes = append(eventTypes, et)
		weights = append(weights, w)
	}

	// Single CTE: compute every subscriber's score from events in the window,
	// including a zero for subscribers whose prior events aged out. Automated
	// mailbox opens are excluded so Apple MPP does not inflate engagement.
	// Only changed scores are written; the 15-minute worker therefore does not
	// churn every subscriber row or trigger unrelated downstream work.
	q := `
WITH rule_set(event_type, weight) AS (
  SELECT unnest($2::text[]), unnest($3::int[])
),
scores AS (
	SELECT s.id,
	       LEAST(32767::bigint, GREATEST(-32768::bigint,
	         COALESCE(SUM(COALESCE(r.weight, 0)), 0)::bigint
	       ))::smallint AS score
	  FROM subscribers s
	  LEFT JOIN subscriber_events e
	    ON e.tenant_id = s.tenant_id
	   AND e.subscriber_email = s.email
	   AND e.at > now() - ($4::int * INTERVAL '1 day')
	   AND (
	     e.event_type <> 'opened'
	     OR NOT EXISTS (
	       SELECT 1
	         FROM bot_open_signatures signature
	        WHERE signature.enabled
	          AND (signature.tenant_id IS NULL OR signature.tenant_id = $1::uuid)
	          AND COALESCE(e.user_agent, '') ~ signature.pattern
	     )
	   )
	  LEFT JOIN rule_set r ON r.event_type = e.event_type
	 WHERE s.tenant_id = $1::uuid
	 GROUP BY s.id
)
UPDATE subscribers s
	   SET engagement_score = sc.score,
	       engagement_score_at = now()
	  FROM scores sc
	 WHERE s.tenant_id = $1::uuid
	   AND s.id = sc.id
	   AND s.engagement_score IS DISTINCT FROM sc.score`
	tag, err := tx.Exec(ctx, q, tenantID, eventTypes, weights, scoringWindowDays)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// loadRules pulls scoring_rules for the tenant in the supplied tx.
// Errors are returned to the caller so the worker can log them; a
// genuinely empty set returns (empty map, nil).
func loadRules(ctx context.Context, tx pgx.Tx, tenantID string) (map[string]int, error) {
	out := map[string]int{}
	rows, err := tx.Query(ctx,
		`SELECT event_type, weight FROM scoring_rules WHERE tenant_id = $1::uuid`,
		tenantID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var et string
		var wt int
		if err := rows.Scan(&et, &wt); err != nil {
			return out, err
		}
		out[et] = wt
	}
	return out, rows.Err()
}

func listRules(ctx context.Context, tx pgx.Tx, tenantID string) ([]Rule, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, event_type, weight, COALESCE(note, '')
  FROM scoring_rules
 WHERE tenant_id = $1::uuid
 ORDER BY event_type`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var rule Rule
		if err := rows.Scan(&rule.ID, &rule.EventType, &rule.Weight, &rule.Note); err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func lockScoringRuleSet(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
  hashtextextended('postwave:scoring:' || $1::text, 0)
)`, tenantID)
	return err
}

func defaultRuleRows() []Rule {
	rows := make([]Rule, 0, len(DefaultRules))
	for eventType, weight := range DefaultRules {
		rows = append(rows, Rule{EventType: eventType, Weight: weight})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].EventType < rows[j].EventType })
	return rows
}

func normalizeRules(in []Rule) ([]Rule, string) {
	if len(in) > maxScoringRules {
		return nil, "at most 14 scoring rules are allowed"
	}
	allowed := make(map[string]struct{}, len(EventCatalog))
	for _, item := range EventCatalog {
		allowed[item.EventType] = struct{}{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]Rule, 0, len(in))
	for index, candidate := range in {
		eventType := strings.TrimSpace(candidate.EventType)
		if _, ok := allowed[eventType]; !ok {
			return nil, "rule " + strconv.Itoa(index) + " has an event_type outside the server catalog"
		}
		if _, duplicate := seen[eventType]; duplicate {
			return nil, "duplicate event_type " + eventType
		}
		seen[eventType] = struct{}{}
		if candidate.Weight < -1000 || candidate.Weight > 1000 {
			return nil, "weight must be -1000..1000"
		}
		note := strings.TrimSpace(candidate.Note)
		if !utf8.ValidString(note) || len(note) > maxScoringNoteBytes || utf8.RuneCountInString(note) > maxScoringNoteRunes {
			return nil, "rule " + strconv.Itoa(index) + " note must be at most 240 characters"
		}
		for _, r := range note {
			if unicode.IsControl(r) {
				return nil, "rule " + strconv.Itoa(index) + " note must not contain control characters"
			}
		}
		out = append(out, Rule{EventType: eventType, Weight: candidate.Weight, Note: note})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EventType < out[j].EventType })
	return out, ""
}

func ruleSetVersion(rules []Rule) string {
	type versionRule struct {
		EventType string `json:"event_type"`
		Weight    int    `json:"weight"`
		Note      string `json:"note"`
	}
	canonical := make([]versionRule, 0, len(rules))
	for _, rule := range rules {
		canonical = append(canonical, versionRule{
			EventType: strings.TrimSpace(rule.EventType),
			Weight:    rule.Weight,
			Note:      strings.TrimSpace(rule.Note),
		})
	}
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].EventType < canonical[j].EventType })
	encoded, _ := json.Marshal(canonical)
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func validRuleSetVersion(value string) bool {
	if len(value) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
