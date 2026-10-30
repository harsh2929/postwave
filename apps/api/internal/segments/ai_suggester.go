// ai_suggester.go — GAP-LS-076 (heuristic): "AI-suggested segments".
//
// IMPORTANT: this is a heuristic, deterministic preset matcher
// dressed up as AI. We label it "AI-suggested" because the UI
// surface mirrors HubSpot Breeze / Klaviyo Segments AI /
// Mailchimp AI Segment Builder, but the implementation is a
// rule-engine that inspects what's actually in the tenant's data
// (engagement rates, CLV cohorts, churn scores, recent join
// dates) and ranks pre-baked segment definitions by signal
// strength. Replace with an LLM-backed suggester in Wave 3+.
//
// The endpoint returns 5-8 suggestions, each with:
//   - name (operator-facing label)
//   - description
//   - predicate_json (a canonical SegmentNode AST; will compile
//     via the same path as a hand-built segment)
//   - estimated_size (count via the preview path)
//   - rationale (why we surfaced this one)
//
// Scoring is purely about which suggestions are likely to be
// useful given what's in the tenant — we compute lightweight
// signal counts once and gate suggestions on thresholds.

package segments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AISuggestion is one row in the response.
type AISuggestion struct {
	Key           string          `json:"key"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	PredicateJSON json.RawMessage `json:"predicate_json"`
	EstimatedSize int             `json:"estimated_size"`
	Rationale     string          `json:"rationale"`
	Category      string          `json:"category"`
}

// AISuggestionsResponse wires the suggestions plus a disclosure
// banner the UI shows above the suggestions list.
type AISuggestionsResponse struct {
	Items     []AISuggestion `json:"items"`
	Generated string         `json:"generated"`
	Notice    string         `json:"notice"`
}

// AISuggestions GET /api/v1/segments/ai-suggestions.
func (d *Deps) AISuggestions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	resp, err := d.Repo.AISuggestions(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// AISuggestions does a single tenant-scoped fan-out over the
// signal tables (subscribers, subscriber_events, profile_predictions,
// profile_rfm_scores) to compute the gating counters, then matches
// pre-baked segment templates against those counters.
func (r *Repo) AISuggestions(ctx context.Context, tenantID string) (*AISuggestionsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	signals := tenantSignals{}
	// Subscribers totals + new-this-week.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*)::int,
  count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int,
  count(*) FILTER (WHERE status = 'enabled')::int
FROM subscribers WHERE tenant_id = $1::uuid AND archived_at IS NULL`, tenantID).
		Scan(&signals.Total, &signals.NewThisWeek, &signals.Subscribed); err != nil {
		return nil, fmt.Errorf("segments: load subscriber suggestion signals: %w", err)
	}

	// Engagement: count of subscribers with no opens in last 60 days.
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int FROM subscribers s
WHERE s.tenant_id = $1::uuid
	AND s.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM subscriber_events e
    WHERE e.tenant_id = s.tenant_id
      AND e.subscriber_email = s.email
      AND e.event_type IN ('opened','clicked')
      AND e.at >= now() - interval '60 days'
  )`, tenantID).Scan(&signals.ColdSubscribers); err != nil {
		return nil, fmt.Errorf("segments: load engagement suggestion signals: %w", err)
	}

	// Predictive: high-CLV cohort (>= $50 predicted), high churn cohort.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE total_clv_cents >= 5000)::int,
  count(*) FILTER (WHERE churn_risk >= 0.7)::int
FROM profile_predictions WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&signals.HighCLV, &signals.HighChurnRisk); err != nil {
		return nil, fmt.Errorf("segments: load predictive suggestion signals: %w", err)
	}

	// RFM: champions count.
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE segment_key = 'champions')::int
FROM profile_rfm_scores WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&signals.RFMChampions); err != nil {
		return nil, fmt.Errorf("segments: load rfm suggestion signals: %w", err)
	}

	// Consent vector signals.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE consent_sms_marketing_at IS NOT NULL)::int,
  count(*) FILTER (WHERE consent_email_marketing_at IS NOT NULL)::int
FROM subscribers WHERE tenant_id = $1::uuid AND archived_at IS NULL`, tenantID).
		Scan(&signals.SMSConsented, &signals.EmailConsented); err != nil {
		return nil, fmt.Errorf("segments: load consent suggestion signals: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	suggestions := buildAISuggestions(signals)
	// Live-count each suggestion via the canonical definition population. A
	// coverage/compiler failure fails the response instead of manufacturing a
	// zero-sized recommendation.
	for i := range suggestions {
		predicate, err := CompilePopulation(ctx, suggestions[i].PredicateJSON, tenantID, r, DefinitionPopulation(false))
		if err != nil {
			return nil, fmt.Errorf("segments: compile suggestion %q: %w", suggestions[i].Key, err)
		}
		n, err := r.Count(ctx, tenantID, predicate.SQL, predicate.Args)
		if err != nil {
			return nil, fmt.Errorf("segments: count suggestion %q: %w", suggestions[i].Key, err)
		}
		suggestions[i].EstimatedSize = n
	}
	return &AISuggestionsResponse{
		Items:     suggestions,
		Generated: "heuristic-v1",
		Notice:    "Suggestions are heuristic — ranked by what is in your data today. AI-backed suggester ships in a later wave.",
	}, nil
}

// tenantSignals captures the counters the rule engine reads.
type tenantSignals struct {
	Total           int
	Subscribed      int
	NewThisWeek     int
	ColdSubscribers int
	HighCLV         int
	HighChurnRisk   int
	RFMChampions    int
	SMSConsented    int
	EmailConsented  int
}

// buildAISuggestions returns the ordered list of suggestions
// matching the tenant's signal profile.
func buildAISuggestions(s tenantSignals) []AISuggestion {
	out := make([]AISuggestion, 0, 8)

	// 1. New this week — always.
	out = append(out, AISuggestion{
		Key:         "new_this_week",
		Name:        "New subscribers (last 7 days)",
		Description: "People who joined in the last week — a welcome series is the obvious follow-up.",
		PredicateJSON: mustAST(map[string]any{
			"op": "condition", "field": "created_at",
			"comparator": "gte", "value": "now-7d",
		}),
		Rationale: "Every tenant has new joiners. Surface this so the operator does not need to think about it.",
		Category:  "lifecycle",
	})

	// 2. Cold subscribers — gated on >= 50 cold.
	if s.ColdSubscribers >= 50 {
		out = append(out, AISuggestion{
			Key:         "cold_subscribers",
			Name:        "Cold subscribers (no engagement 60d)",
			Description: "People who haven't opened or clicked in 60 days. A re-engagement series or a sunset flow is the standard play.",
			PredicateJSON: mustAST(map[string]any{
				"op": "condition", "field": "last_event_at",
				"comparator": "lt", "value": "now-60d",
			}),
			Rationale: humanCount(s.ColdSubscribers) + " subscribers have not engaged in 60 days.",
			Category:  "engagement",
		})
	}

	// 3. High-value customers — gated on HighCLV >= 10.
	if s.HighCLV >= 10 {
		out = append(out, AISuggestion{
			Key:         "high_value_customers",
			Name:        "High-value customers ($50+ total CLV)",
			Description: "Predicted total CLV of $50 or more. Reward and retain.",
			PredicateJSON: mustAST(map[string]any{
				"op": "condition", "field": "predictive.total_clv_cents",
				"comparator": "gte", "value": 5000,
			}),
			Rationale: humanCount(s.HighCLV) + " profiles match the high-value threshold.",
			Category:  "predictive",
		})
	}

	// 4. Churn risk — gated on HighChurnRisk >= 10.
	if s.HighChurnRisk >= 10 {
		out = append(out, AISuggestion{
			Key:         "churn_risk",
			Name:        "Churn risk (≥0.7)",
			Description: "Predictive churn risk of 0.7 or higher. Target with a save-offer or feedback series.",
			PredicateJSON: mustAST(map[string]any{
				"op": "condition", "field": "predictive.churn_risk",
				"comparator": "gte", "value": 0.7,
			}),
			Rationale: humanCount(s.HighChurnRisk) + " profiles flagged at high churn risk.",
			Category:  "predictive",
		})
	}

	// 5. Champions (RFM) — gated on RFMChampions >= 5.
	if s.RFMChampions >= 5 {
		out = append(out, AISuggestion{
			Key:           "champions_rfm",
			Name:          "Champions (RFM bucket)",
			Description:   "Top-tier RFM bucket — recent, frequent, high-monetary.",
			PredicateJSON: mustAST(map[string]any{"op": "condition", "field": "rfm.segment_key", "comparator": "equals", "value": "champions"}),
			Rationale:     humanCount(s.RFMChampions) + " subscribers scored champions in your last RFM run.",
			Category:      "predictive",
		})
	}

	// 6. SMS consented audience — gated on SMSConsented >= 25.
	if s.SMSConsented >= 25 {
		out = append(out, AISuggestion{
			Key:           "sms_consented",
			Name:          "Can receive SMS",
			Description:   "Subscribers with recorded SMS consent — ready for an SMS broadcast.",
			PredicateJSON: mustAST(map[string]any{"op": "condition", "field": "channel_consent.sms", "comparator": "equals", "value": true}),
			Rationale:     humanCount(s.SMSConsented) + " subscribers have SMS consent on file.",
			Category:      "consent",
		})
	}

	// 7. Anonymous fallback — only if base small enough that the
	// dashboard would otherwise feel empty.
	if s.Total > 0 && s.Subscribed > 0 {
		out = append(out, AISuggestion{
			Key:           "active_subscribed",
			Name:          "Active subscribers",
			Description:   "Currently enabled audience. Safe baseline for campaign planning.",
			PredicateJSON: mustAST(map[string]any{"op": "condition", "field": "status", "comparator": "equals", "value": "enabled"}),
			Rationale:     "A foundation segment — always useful as a broadcast baseline.",
			Category:      "lifecycle",
		})
	}

	// 8. Multi-channel reachable — when both email + SMS consented exists.
	if s.EmailConsented >= 25 && s.SMSConsented >= 10 {
		out = append(out, AISuggestion{
			Key:         "multi_channel",
			Name:        "Reachable on email AND SMS",
			Description: "Profiles consented for both email and SMS — your most-reachable cohort.",
			PredicateJSON: mustAST(map[string]any{
				"op": "and",
				"children": []map[string]any{
					{"op": "condition", "field": "channel_consent.email", "comparator": "equals", "value": true},
					{"op": "condition", "field": "channel_consent.sms", "comparator": "equals", "value": true},
				},
			}),
			Rationale: "You have meaningful overlap between email and SMS consents.",
			Category:  "consent",
		})
	}

	// Cap at 8.
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func mustAST(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// humanCount returns "1,234" with thousands separators. Inlined
// since the strconv path would be more cycles than this small loop.
func humanCount(n int) string {
	if n < 0 {
		return "-" + humanCount(-n)
	}
	if n < 1000 {
		return itoaSmall(n)
	}
	return humanCount(n/1000) + "," + zeroPad3(n%1000)
}

func itoaSmall(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func zeroPad3(n int) string {
	if n >= 100 {
		return itoaSmall(n)
	}
	if n >= 10 {
		return "0" + itoaSmall(n)
	}
	return "00" + itoaSmall(n)
}

// Compile-time check we wired the db import; some toolchains will
// drop it as unused otherwise.
var _ = db.WithTenant
