// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AnomalyScoreResponse is the wire shape for GET
// /api/v1/audit/{id}/anomaly-score. Used by the "Why high risk?" modal.
type AnomalyScoreResponse struct {
	Available       bool              `json:"available"`
	AuditID         int64             `json:"auditId"`
	Score           float64           `json:"score"`
	Bucket          string            `json:"bucket"`
	Reasons         []map[string]any  `json:"reasons"`
	MitreTechniques []string          `json:"mitreTechniques"`
	Baseline        *BaselineSnapshot `json:"baseline,omitempty"`
	CreatedAt       time.Time         `json:"createdAt"`
}

// BaselineSnapshot is the actor's most-recent baseline row, projected
// for the slideover deviation panel.
type BaselineSnapshot struct {
	ActorLabel        string         `json:"actorLabel"`
	ActorType         string         `json:"actorType"`
	Day               string         `json:"day"`
	TypicalHours      map[string]int `json:"typicalHours"`
	TypicalIPs        []string       `json:"typicalIps"`
	TypicalActions    map[string]int `json:"typicalActions"`
	MeanActionsPerDay float64        `json:"meanActionsPerDay"`
}

// AnomalyScore GET /api/v1/audit/{id}/anomaly-score
//
// ueba-baselines (AI/Anomaly, P1): returns the score + reasons +
// baseline snapshot for a single audit_log row. Used by the "Why
// high risk?" modal. Returns {available:false} when no row exists
// in audit_anomaly_scores (rather than 404) so the modal can render
// "no anomaly detected" inline rather than an error toast.
func (h *AuditHandlers) AnomalyScore(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	idStr := chi.URLParam(r, "id")
	auditID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || auditID <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "id must be a positive integer")
		return
	}
	resp, err := h.fetchAnomalyScore(r.Context(), t.ID, auditID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *AuditHandlers) fetchAnomalyScore(ctx context.Context, tenantID string, auditID int64) (*AnomalyScoreResponse, error) {
	tx, err := h.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}

	var score float64
	var reasonsJSON, mitreRaw string
	var createdAt time.Time
	var actorLabel, actorType string

	err = tx.QueryRow(ctx, `
SELECT s.score, s.reasons::text, s.mitre_techniques::text, s.created_at,
       COALESCE(a.actor_label, '') AS actor_label,
       COALESCE(a.actor_type, '') AS actor_type
  FROM audit_anomaly_scores s
  JOIN audit_log a ON a.id = s.audit_id AND a.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1::uuid AND s.audit_id = $2
 LIMIT 1`, tenantID, auditID).Scan(&score, &reasonsJSON, &mitreRaw, &createdAt, &actorLabel, &actorType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &AnomalyScoreResponse{Available: false, AuditID: auditID, Reasons: []map[string]any{}, MitreTechniques: []string{}}, nil
		}
		return nil, err
	}

	var reasons []map[string]any
	_ = json.Unmarshal([]byte(reasonsJSON), &reasons)
	mitre := parsePgTextArray(mitreRaw)

	resp := &AnomalyScoreResponse{
		Available:       true,
		AuditID:         auditID,
		Score:           score,
		Bucket:          riskBucket(score),
		Reasons:         reasons,
		MitreTechniques: mitre,
		CreatedAt:       createdAt,
	}
	if actorLabel != "" {
		var day time.Time
		var hoursJSON, ipsJSON, actionsJSON string
		var mean float64
		err := tx.QueryRow(ctx, `
SELECT day, typical_hours::text, typical_ips::text, typical_actions::text, mean_actions_per_day
  FROM audit_user_baselines
 WHERE tenant_id = $1::uuid AND actor_label = $2 AND actor_type = $3
 ORDER BY day DESC
 LIMIT 1`, tenantID, actorLabel, actorType).Scan(&day, &hoursJSON, &ipsJSON, &actionsJSON, &mean)
		if err == nil {
			snap := &BaselineSnapshot{
				ActorLabel:        actorLabel,
				ActorType:         actorType,
				Day:               day.Format("2006-01-02"),
				MeanActionsPerDay: mean,
			}
			_ = json.Unmarshal([]byte(hoursJSON), &snap.TypicalHours)
			_ = json.Unmarshal([]byte(ipsJSON), &snap.TypicalIPs)
			_ = json.Unmarshal([]byte(actionsJSON), &snap.TypicalActions)
			resp.Baseline = snap
		}
	}
	return resp, nil
}

// riskBucket mirrors the frontend RiskBucket type — kept on the server
// so the client can read a single canonical bucket without re-deriving
// thresholds.
func riskBucket(score float64) string {
	if score >= 60 {
		return "high"
	}
	if score >= 25 {
		return "med"
	}
	return "low"
}

// parsePgTextArray parses a Postgres text[] literal into a Go slice.
// Handles the trivial subset emitted by the UEBA worker (alphanumeric
// MITRE IDs); does not try to be a full ARRAY literal parser.
func parsePgTextArray(s string) []string {
	if len(s) < 2 || s == "{}" {
		return []string{}
	}
	body := s[1 : len(s)-1]
	out := []string{}
	cur := []rune{}
	inQuote := false
	for _, c := range body {
		switch {
		case c == '"' && !inQuote:
			inQuote = true
		case c == '"' && inQuote:
			inQuote = false
		case c == ',' && !inQuote:
			if len(cur) > 0 {
				out = append(out, string(cur))
				cur = cur[:0]
			}
		default:
			cur = append(cur, c)
		}
	}
	if len(cur) > 0 {
		out = append(out, string(cur))
	}
	return out
}

// RecentAnomalies GET /api/v1/audit/anomalies/recent — top-N anomaly
// scores in the last 24h. Powers the UEBA insights tile in
// AuditInsightsRow.
func (h *AuditHandlers) RecentAnomalies(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	limit := 5
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}
	tx, err := h.Pool.BeginTx(r.Context(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT set_config('app.tenant_id', $1, true)`, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT s.audit_id, s.score, s.reasons::text, s.mitre_techniques::text, s.created_at,
       COALESCE(a.action, '') AS action,
       COALESCE(a.actor_label, '') AS actor_label,
       COALESCE(a.actor_type, '') AS actor_type
  FROM audit_anomaly_scores s
  JOIN audit_log a ON a.id = s.audit_id AND a.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1::uuid
   AND s.created_at >= now() - interval '24 hours'
 ORDER BY s.score DESC, s.created_at DESC
 LIMIT $2`, t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var auditID int64
		var score float64
		var reasonsJSON, mitreRaw string
		var createdAt time.Time
		var action, actorLabel, actorType string
		if err := rows.Scan(&auditID, &score, &reasonsJSON, &mitreRaw, &createdAt, &action, &actorLabel, &actorType); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		var reasons []map[string]any
		_ = json.Unmarshal([]byte(reasonsJSON), &reasons)
		dominant := ""
		if len(reasons) > 0 {
			if dt, ok := reasons[0]["type"].(string); ok {
				dominant = dt
			}
		}
		items = append(items, map[string]any{
			"auditId":         auditID,
			"score":           score,
			"bucket":          riskBucket(score),
			"action":          action,
			"actorLabel":      actorLabel,
			"actorType":       actorType,
			"dominantType":    dominant,
			"reasons":         reasons,
			"mitreTechniques": parsePgTextArray(mitreRaw),
			"createdAt":       createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"count": len(items),
	})
}
