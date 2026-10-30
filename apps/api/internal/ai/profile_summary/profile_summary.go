// Package profile_summary implements SUB-058-070: per-subscriber LLM
// profile summaries with explainability + 24h cache.
//
// Surface:
//
//	GET /api/v1/subscribers/{id}/ai-summary
//	  → {summary, drivers, last_updated, cache_hit}
//
// Flow:
//  1. Resolve subscriber → email + status + signals (last 30d events,
//     top tags, consent state, predictive scores). The Assembler does
//     this in one tx.
//  2. Hash the structured drivers slice → content_hash. If the cache
//     row at (tenant, subscriber, content_hash) is fresh, return it.
//  3. Build the prompt with PII tokenized at the gateway:
//     real email → "subscriber@example" stand-in. The summary that
//     comes back is detokenized before being persisted / returned so
//     the operator sees the real address.
//  4. Call the AI provider via the Generator. If it errs, fall back
//     to a deterministic template built from the same drivers — the
//     wire shape stays identical; only `source` differs.
//  5. Write an explainability row (prompt_hash, model, drivers,
//     response, source) — retained 90d by retention sweep.
//  6. Upsert the cache row (24h TTL).
package profile_summary

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Driver is one structured signal that informed the summary. Surfaced
// verbatim under the "Why is this person here?" expandable list.
type Driver struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Value  string `json:"value"`
	Weight string `json:"weight,omitempty"` // "high" | "medium" | "low"
}

// Signals is the input to the summary renderer / prompt assembler.
// Each field is intentionally optional — missing data degrades to a
// shorter summary, never an error.
type Signals struct {
	Email            string
	Status           string
	SubscribedAt     time.Time
	LastEngagementAt *time.Time
	Sent30d          int
	Opens30d         int
	Clicks30d        int
	Replies30d       int
	TopTags          []string
	ConsentState     string  // "double_optin" | "single_optin" | "import" | "unknown"
	ChurnScore       float64 // 0..1; 0 = unknown
	CLVCents         int     // historic CLV in cents; 0 = unknown
	EngagementScore  float64 // 0..1
	CurrentLifecycle string  // "new" | "active" | "lapsing" | "dormant"
}

// Summary is the wire response.
type Summary struct {
	Summary     string    `json:"summary"`
	Drivers     []Driver  `json:"drivers"`
	LastUpdated time.Time `json:"last_updated"`
	CacheHit    bool      `json:"cache_hit"`
	Source      string    `json:"source"` // "ai" | "deterministic"
}

// Generator is the LLM gateway surface. tenantID is forwarded for
// quota accounting; the caller has already tokenized PII in the
// prompt so the provider never sees the real email.
type Generator interface {
	Generate(ctx context.Context, tenantID, prompt string) (text, model string, err error)
}

// Deps wires Pool + (optional) LLM generator.
type Deps struct {
	Pool *db.Pool
	// Gen is the LLM client. When nil, every call falls back to the
	// deterministic renderer — the response shape is identical so the
	// UI doesn't need to branch.
	Gen Generator
	// Logger is used to log internal errors server-side without echoing
	// raw error text to clients. May be nil.
	Logger *slog.Logger
}

const cacheTTL = 24 * time.Hour

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/ai-summary", d.get)
}

func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	subscriberID := chi.URLParam(r, "id")
	if subscriberID == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "id required")
		return
	}

	out, err := Compute(r.Context(), d.Pool, d.Gen, t.ID, subscriberID)
	if err != nil {
		if errors.Is(err, ErrSubscriberNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ErrSubscriberNotFound is returned when the {id} doesn't resolve.
var ErrSubscriberNotFound = errors.New("subscriber not found")

// Compute is the end-to-end pipeline. Exposed for tests + admin tools.
func Compute(ctx context.Context, pool *db.Pool, gen Generator, tenantID, subscriberID string) (*Summary, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sig, err := collectSignals(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	drivers := ExtractDrivers(sig)
	contentHash := hashDrivers(drivers)

	// Cache lookup — same drivers within 24h get a hit.
	if cached, hit, err := loadCache(ctx, tx, tenantID, subscriberID, contentHash); err != nil {
		return nil, err
	} else if hit {
		_ = tx.Commit(ctx)
		cached.CacheHit = true
		return cached, nil
	}

	// Build prompt; tokenize PII for the provider call.
	tokenized, detok := tokenizePrompt(BuildPrompt(sig, drivers), sig.Email)

	var (
		text   string
		model  string
		source = "deterministic"
	)
	if gen != nil {
		out, m, gerr := gen.Generate(ctx, tenantID, tokenized)
		if gerr == nil && strings.TrimSpace(out) != "" {
			text = detok(out)
			model = m
			source = "ai"
		}
	}
	if text == "" {
		text = renderDeterministic(sig, drivers)
		source = "deterministic"
	}

	promptHash := sha256Hex(tokenized)
	now := time.Now().UTC()

	if err := writeExplainability(ctx, tx, tenantID, subscriberID, model, promptHash, text, drivers, source); err != nil {
		return nil, fmt.Errorf("explainability: %w", err)
	}
	if err := upsertCache(ctx, tx, tenantID, subscriberID, contentHash, text, drivers, source, now); err != nil {
		return nil, fmt.Errorf("cache: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return &Summary{
		Summary:     text,
		Drivers:     drivers,
		LastUpdated: now,
		CacheHit:    false,
		Source:      source,
	}, nil
}

// collectSignals pulls the structured signals the renderer + prompt
// need. Every block is fault-tolerant: a missing column or empty
// result leaves its field at the zero value rather than failing.
func collectSignals(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string) (Signals, error) {
	var sig Signals

	row := tx.QueryRow(ctx, `
SELECT email::text, status, COALESCE(consent_source, ''), created_at, tags
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))`,
		tenantID, subscriberID)
	var tags []string
	if err := row.Scan(&sig.Email, &sig.Status, &sig.ConsentState, &sig.SubscribedAt, &tags); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sig, ErrSubscriberNotFound
		}
		return sig, fmt.Errorf("lookup subscriber: %w", err)
	}
	if sig.ConsentState == "" {
		sig.ConsentState = "unknown"
	}
	sig.TopTags = topN(tags, 3)

	// Last-30d events. subscriber_events is optional — fall back to 0.
	if hasTable(ctx, tx, "subscriber_events") {
		_ = tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type IN ('sent','delivered'))::int,
  count(*) FILTER (WHERE event_type = 'opened')::int,
  count(*) FILTER (WHERE event_type = 'clicked')::int,
  count(*) FILTER (WHERE event_type IN ('replied','reply'))::int,
  max(at) FILTER (WHERE event_type IN ('opened','clicked','replied'))
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND lower(subscriber_email) = lower($2)
   AND at >= now() - interval '30 days'`,
			tenantID, sig.Email,
		).Scan(&sig.Sent30d, &sig.Opens30d, &sig.Clicks30d, &sig.Replies30d, &sig.LastEngagementAt)
	}

	// Predictive scores (optional).
	if hasTable(ctx, tx, "predictive_profiles") {
		_ = tx.QueryRow(ctx, `
SELECT COALESCE(churn_risk, 0)::float8, COALESCE(historic_clv_cents, 0)::int
  FROM predictive_profiles
 WHERE tenant_id = $1::uuid
   AND lower(email) = lower($2)
 ORDER BY calculated_at DESC NULLS LAST
 LIMIT 1`, tenantID, sig.Email,
		).Scan(&sig.ChurnScore, &sig.CLVCents)
	}

	sig.EngagementScore = computeEngagement(sig)
	sig.CurrentLifecycle = classifyLifecycle(sig)
	return sig, nil
}

func hasTable(ctx context.Context, tx pgx.Tx, name string) bool {
	var ok bool
	_ = tx.QueryRow(ctx, `SELECT to_regclass('public.'||$1) IS NOT NULL`, name).Scan(&ok)
	return ok
}

func topN(xs []string, n int) []string {
	if len(xs) <= n {
		return append([]string{}, xs...)
	}
	out := make([]string, n)
	copy(out, xs[:n])
	return out
}

func computeEngagement(s Signals) float64 {
	if s.Sent30d == 0 && s.LastEngagementAt == nil {
		return 0
	}
	rec := 0.0
	if s.LastEngagementAt != nil {
		days := time.Since(*s.LastEngagementAt).Hours() / 24
		if days < 0 {
			days = 0
		}
		// exp(-d/30) ≈ 1 at d=0, 0.37 at d=30, 0.13 at d=60
		rec = 1.0
		for i := 0.0; i < days/30; i++ {
			rec *= 0.37
		}
	}
	freq := 0.0
	if s.Sent30d > 0 {
		freq = float64(s.Opens30d+s.Clicks30d) / float64(s.Sent30d)
		if freq > 1 {
			freq = 1
		}
	}
	reply := 0.0
	if s.Sent30d > 0 {
		reply = float64(s.Replies30d) / float64(s.Sent30d)
		if reply > 1 {
			reply = 1
		}
	}
	score := 0.5*rec + 0.3*freq + 0.2*reply
	if score < 0 {
		score = 0
	}
	if score > 1 {
		score = 1
	}
	return score
}

func classifyLifecycle(s Signals) string {
	if s.LastEngagementAt == nil {
		days := time.Since(s.SubscribedAt).Hours() / 24
		if days < 14 {
			return "new"
		}
		return "dormant"
	}
	days := time.Since(*s.LastEngagementAt).Hours() / 24
	switch {
	case days < 7:
		return "active"
	case days < 30:
		return "lapsing"
	default:
		return "dormant"
	}
}

// ExtractDrivers ranks the structured signals that informed the
// summary. Order is "highest signal first" so the UI can render the
// first few without the operator having to expand.
func ExtractDrivers(s Signals) []Driver {
	out := []Driver{}

	if s.LastEngagementAt != nil {
		out = append(out, Driver{
			Key: "last_engagement_at", Label: "Last engagement",
			Value:  s.LastEngagementAt.UTC().Format(time.RFC3339),
			Weight: "high",
		})
	}
	if s.CurrentLifecycle != "" {
		out = append(out, Driver{
			Key: "lifecycle", Label: "Lifecycle stage",
			Value:  s.CurrentLifecycle,
			Weight: "high",
		})
	}
	if s.Sent30d > 0 {
		out = append(out, Driver{
			Key: "events_30d", Label: "30-day activity",
			Value: fmt.Sprintf("%d sent · %d opens · %d clicks · %d replies",
				s.Sent30d, s.Opens30d, s.Clicks30d, s.Replies30d),
			Weight: "high",
		})
	}
	if len(s.TopTags) > 0 {
		out = append(out, Driver{
			Key: "top_tags", Label: "Top tags",
			Value:  strings.Join(s.TopTags, ", "),
			Weight: "medium",
		})
	}
	if s.ConsentState != "" && s.ConsentState != "unknown" {
		out = append(out, Driver{
			Key: "consent", Label: "Consent",
			Value:  s.ConsentState,
			Weight: "medium",
		})
	}
	if s.ChurnScore > 0 {
		w := "low"
		if s.ChurnScore >= 0.6 {
			w = "high"
		} else if s.ChurnScore >= 0.3 {
			w = "medium"
		}
		out = append(out, Driver{
			Key: "churn_score", Label: "Churn risk",
			Value:  fmt.Sprintf("%.2f", s.ChurnScore),
			Weight: w,
		})
	}
	if s.CLVCents > 0 {
		out = append(out, Driver{
			Key: "clv_cents", Label: "Historic CLV",
			Value:  fmt.Sprintf("%.2f", float64(s.CLVCents)/100),
			Weight: "medium",
		})
	}
	if s.EngagementScore > 0 {
		out = append(out, Driver{
			Key: "engagement_score", Label: "Engagement score",
			Value:  fmt.Sprintf("%.2f", s.EngagementScore),
			Weight: "low",
		})
	}
	return out
}

// BuildPrompt assembles the LLM prompt. The PII gateway tokenizes the
// email before the prompt leaves the boundary — see tokenizePrompt.
func BuildPrompt(s Signals, drivers []Driver) string {
	var b strings.Builder
	b.WriteString("You are summarising one email subscriber in 2-3 sentences for a marketing operator.\n")
	b.WriteString("Use the structured signals below. Do not invent facts. Be concrete and operator-useful.\n\n")

	fmt.Fprintf(&b, "Subject: %s\n", s.Email)
	fmt.Fprintf(&b, "Status: %s\n", s.Status)
	fmt.Fprintf(&b, "Subscribed: %s\n", s.SubscribedAt.UTC().Format("2006-01-02"))
	if s.LastEngagementAt != nil {
		fmt.Fprintf(&b, "Last engagement: %s\n", s.LastEngagementAt.UTC().Format("2006-01-02"))
	}
	fmt.Fprintf(&b, "Lifecycle: %s\n", s.CurrentLifecycle)
	fmt.Fprintf(&b, "Consent: %s\n", s.ConsentState)
	if s.Sent30d > 0 {
		fmt.Fprintf(&b, "30d activity: sent=%d opens=%d clicks=%d replies=%d\n",
			s.Sent30d, s.Opens30d, s.Clicks30d, s.Replies30d)
	}
	if len(s.TopTags) > 0 {
		fmt.Fprintf(&b, "Top tags: %s\n", strings.Join(s.TopTags, ", "))
	}
	if s.ChurnScore > 0 {
		fmt.Fprintf(&b, "Churn risk: %.2f\n", s.ChurnScore)
	}
	if s.CLVCents > 0 {
		fmt.Fprintf(&b, "Historic CLV (USD): %.2f\n", float64(s.CLVCents)/100)
	}
	b.WriteString("\nWrite the summary now. Plain prose, no markdown, no list formatting.")
	return b.String()
}

// renderDeterministic is the AI-unavailable fallback. Same drivers,
// same vibe — built from string templating so the UI never sees an
// empty card. Mirrors campaign_summary's renderer policy.
func renderDeterministic(s Signals, _ []Driver) string {
	var b strings.Builder

	fmt.Fprintf(&b, "%s is a %s subscriber", s.Email, s.CurrentLifecycle)
	if !s.SubscribedAt.IsZero() {
		fmt.Fprintf(&b, " since %s", s.SubscribedAt.Format("Jan 2006"))
	}
	b.WriteString(".")

	if s.Sent30d > 0 {
		fmt.Fprintf(&b, " Over the last 30 days they received %d sends with %d opens and %d clicks",
			s.Sent30d, s.Opens30d, s.Clicks30d)
		if s.Replies30d > 0 {
			fmt.Fprintf(&b, " and %d replies", s.Replies30d)
		}
		b.WriteString(".")
	} else {
		b.WriteString(" No sends recorded in the last 30 days.")
	}

	if len(s.TopTags) > 0 {
		fmt.Fprintf(&b, " Top tags: %s.", strings.Join(s.TopTags, ", "))
	}
	if s.ChurnScore >= 0.6 {
		fmt.Fprintf(&b, " Churn risk is elevated (%.2f) — consider a win-back send.", s.ChurnScore)
	} else if s.CurrentLifecycle == "active" {
		b.WriteString(" Engagement is healthy — safe to include in next broadcast.")
	}
	return b.String()
}

// tokenizePrompt replaces the real email with a stable opaque token
// (sha256 prefix → "subscriber_xxxx@example.invalid") so the AI
// provider never sees raw PII. The returned detok closure reverses
// the substitution on the response.
func tokenizePrompt(prompt, email string) (string, func(string) string) {
	if email == "" {
		return prompt, func(s string) string { return s }
	}
	tok := "subscriber_" + sha256Hex(email)[:10] + "@example.invalid"
	tokenized := strings.ReplaceAll(prompt, email, tok)
	detok := func(out string) string { return strings.ReplaceAll(out, tok, email) }
	return tokenized, detok
}

func hashDrivers(drivers []Driver) string {
	keys := make([]string, len(drivers))
	for i, d := range drivers {
		keys[i] = d.Key + "=" + d.Value
	}
	sort.Strings(keys)
	return sha256Hex(strings.Join(keys, "|"))
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func loadCache(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, contentHash string) (*Summary, bool, error) {
	// subscriberID may be a UUID or an email — for email lookups we
	// resolve to the subscribers.id first so the cache key is stable.
	subUUID, err := resolveSubscriberUUID(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, false, err
	}

	var out Summary
	var driversJSON []byte
	err = tx.QueryRow(ctx, `
SELECT summary, drivers, source, last_updated
  FROM ai_profile_summary_cache
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND content_hash = $3
   AND expires_at > now()`,
		tenantID, subUUID, contentHash,
	).Scan(&out.Summary, &driversJSON, &out.Source, &out.LastUpdated)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if len(driversJSON) > 0 {
		_ = json.Unmarshal(driversJSON, &out.Drivers)
	}
	return &out, true, nil
}

func upsertCache(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, contentHash, summary string, drivers []Driver, source string, now time.Time) error {
	subUUID, err := resolveSubscriberUUID(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return err
	}
	driversJSON, _ := json.Marshal(drivers)
	_, err = tx.Exec(ctx, `
INSERT INTO ai_profile_summary_cache
       (tenant_id, subscriber_id, content_hash, summary, drivers, source, last_updated, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::timestamptz, $7::timestamptz + interval '24 hours')
ON CONFLICT (tenant_id, subscriber_id, content_hash) DO UPDATE
   SET summary      = EXCLUDED.summary,
       drivers      = EXCLUDED.drivers,
       source       = EXCLUDED.source,
       last_updated = EXCLUDED.last_updated,
       expires_at   = EXCLUDED.expires_at`,
		tenantID, subUUID, contentHash, summary, string(driversJSON), source, now,
	)
	return err
}

func writeExplainability(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, model, promptHash, response string, drivers []Driver, source string) error {
	subUUID, err := resolveSubscriberUUID(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return err
	}
	driversJSON, _ := json.Marshal(drivers)
	_, err = tx.Exec(ctx, `
INSERT INTO ai_explainability_records
       (tenant_id, subscriber_id, surface, model, prompt_hash, response, drivers, source)
VALUES ($1::uuid, $2::uuid, 'subscriber_summary', $3, $4, $5, $6::jsonb, $7)`,
		tenantID, subUUID, model, promptHash, response, string(driversJSON), source,
	)
	return err
}

// resolveSubscriberUUID converts {id} (UUID or email) → canonical UUID.
// Cached per-tx via a tiny map would be overkill — Compute only calls
// this a handful of times.
func resolveSubscriberUUID(ctx context.Context, tx pgx.Tx, tenantID, id string) (string, error) {
	var out string
	err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))`,
		tenantID, id,
	).Scan(&out)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrSubscriberNotFound
		}
		return "", err
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
