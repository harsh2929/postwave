// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Worker is the top-level orchestrator: it runs the daily
// BaselineWorker and a faster detection tick that walks fresh
// audit_log rows, applies all four detectors, and writes
// audit_anomaly_scores. The existing audit_alerts.Worker reads from
// audit_anomaly_scores and fires channel dispatch on score >=
// threshold.
type Worker struct {
	Pool              QueryablePool
	Logger            *slog.Logger
	BaselineWorker    *BaselineWorker
	BaselineInterval  time.Duration
	DetectionInterval time.Duration

	ImpossibleTravel *ImpossibleTravelDetector
	OffHours         *OffHoursDetector
	PeerGroup        *PeerGroupDetector
	Escalation       *EscalationChainDetector

	// AlertThreshold is the score above which the row is also written
	// into the audit_alerts dispatch queue. Default 60.
	AlertThreshold float64
}

// Default returns a Worker with sane defaults wired. Call Run on the
// result.
func Default(pool QueryablePool, logger *slog.Logger) *Worker {
	peer := &PeerGroupDetector{}
	return &Worker{
		Pool:              pool,
		Logger:            logger,
		BaselineWorker:    &BaselineWorker{Pool: pool, LookbackDays: 30, PeerGroup: peer},
		BaselineInterval:  24 * time.Hour,
		DetectionInterval: 5 * time.Minute,
		ImpossibleTravel:  &ImpossibleTravelDetector{},
		OffHours:          &OffHoursDetector{},
		PeerGroup:         peer,
		Escalation:        &EscalationChainDetector{},
		AlertThreshold:    60,
	}
}

// Run drives the worker until ctx is cancelled. Spins two tickers
// (baseline + detection) inside a single goroutine.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("ueba worker: missing deps")
	}
	bi := w.BaselineInterval
	if bi <= 0 {
		bi = 24 * time.Hour
	}
	di := w.DetectionInterval
	if di <= 0 {
		di = 5 * time.Minute
	}
	if w.Logger != nil {
		w.Logger.Info("ueba worker: starting", "baseline_interval", bi.String(), "detection_interval", di.String())
	}
	// First baseline pass on startup so a fresh deploy doesn't wait
	// 24h for any baseline at all.
	if w.BaselineWorker != nil {
		if err := w.BaselineWorker.Run(ctx, time.Now().UTC()); err != nil && w.Logger != nil {
			w.Logger.Warn("ueba baseline initial pass failed", "err", err.Error())
		}
	}
	baselineTick := time.NewTicker(bi)
	defer baselineTick.Stop()
	detectionTick := time.NewTicker(di)
	defer detectionTick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-baselineTick.C:
			if w.BaselineWorker == nil {
				continue
			}
			if err := w.BaselineWorker.Run(ctx, time.Now().UTC()); err != nil && w.Logger != nil {
				w.Logger.Warn("ueba baseline tick failed", "err", err.Error())
			}
		case <-detectionTick.C:
			if err := w.detectionTick(ctx); err != nil && w.Logger != nil {
				w.Logger.Warn("ueba detection tick failed", "err", err.Error())
			}
		}
	}
}

// detectionTick scans audit_log rows newer than the last anomaly_score
// row per tenant, applies the four detectors, and writes scores.
func (w *Worker) detectionTick(ctx context.Context) error {
	tx, err := w.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.audit_ueba_worker', 'true', true)`); err != nil {
		return fmt.Errorf("guc set: %w", err)
	}
	// Pull last 24h worth of rows that don't yet have a score. The
	// LEFT JOIN keeps the query bounded even if a tenant has a million
	// stale rows.
	rows, err := tx.Query(ctx, `
SELECT a.id, a.tenant_id::text, a.action,
       COALESCE(a.actor_type, '') AS actor_type,
       COALESCE(a.actor_label, '') AS actor_label,
       COALESCE(a.ip::text, '') AS ip,
       COALESCE(a.created_at, now()) AS at,
       COALESCE(a.metadata, '{}'::jsonb)::text AS meta
  FROM audit_log a
  LEFT JOIN audit_anomaly_scores s
         ON s.tenant_id = a.tenant_id AND s.audit_id = a.id
 WHERE s.id IS NULL
   AND a.created_at >= now() - interval '24 hours'
   AND a.actor_label IS NOT NULL
 ORDER BY a.created_at ASC
 LIMIT 5000`)
	if err != nil {
		return fmt.Errorf("scan unscored: %w", err)
	}
	var events []AuditEvent
	for rows.Next() {
		var ev AuditEvent
		var metaJSON string
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.Action, &ev.ActorType, &ev.ActorLabel, &ev.IP, &ev.At, &metaJSON); err != nil {
			rows.Close()
			return fmt.Errorf("scan: %w", err)
		}
		if metaJSON != "" {
			_ = json.Unmarshal([]byte(metaJSON), &ev.Metadata)
		}
		events = append(events, ev)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows err: %w", err)
	}

	// Per-actor sliding window for impossible-travel + escalation-chain
	// (they need a "prev event").
	type actorKey struct{ tenant, label, atype string }
	prevByActor := map[actorKey]*AuditEvent{}
	scores := make([]AnomalyScore, 0, len(events))

	for i := range events {
		ev := events[i]
		ak := actorKey{ev.TenantID, ev.ActorLabel, ev.ActorType}
		prev := prevByActor[ak]
		base, _ := w.baselineFor(ctx, tx, ev.TenantID, ev.ActorLabel, ev.ActorType)
		var reasons []DetectorReason
		if w.ImpossibleTravel != nil {
			reasons = append(reasons, w.ImpossibleTravel.Detect(ctx, ev, base, prev)...)
		}
		if w.OffHours != nil {
			reasons = append(reasons, w.OffHours.Detect(ctx, ev, base, prev)...)
		}
		if w.PeerGroup != nil {
			reasons = append(reasons, w.PeerGroup.Detect(ctx, ev, base, prev)...)
		}
		if w.Escalation != nil {
			reasons = append(reasons, w.Escalation.Detect(ctx, ev, base, prev)...)
		}
		prevByActor[ak] = &events[i]
		if len(reasons) == 0 {
			continue
		}
		score := AggregateScore(reasons)
		mitre := flattenMitre(reasons)
		scores = append(scores, AnomalyScore{
			TenantID:        ev.TenantID,
			AuditID:         ev.ID,
			Score:           score,
			Reasons:         reasons,
			MitreTechniques: mitre,
		})
	}

	// Persist.
	for _, s := range scores {
		reasonsJSON, _ := json.Marshal(s.Reasons)
		_, err := tx.Exec(ctx, `
INSERT INTO audit_anomaly_scores
    (tenant_id, audit_id, score, reasons, mitre_techniques)
VALUES
    ($1::uuid, $2, $3, $4::jsonb, $5::text[])
ON CONFLICT (tenant_id, audit_id) DO UPDATE
   SET score = EXCLUDED.score,
       reasons = EXCLUDED.reasons,
       mitre_techniques = EXCLUDED.mitre_techniques`,
			s.TenantID, s.AuditID, s.Score, string(reasonsJSON), pgTextArray(s.MitreTechniques))
		if err != nil {
			return fmt.Errorf("insert anomaly score: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if w.Logger != nil && len(scores) > 0 {
		w.Logger.Info("ueba detection tick", "scored", len(scores), "events", len(events))
	}
	return nil
}

// baselineFor reads the most recent baseline for an actor inside the
// worker tx (which already carries the ueba_worker GUC, so RLS allows
// the cross-tenant read).
func (w *Worker) baselineFor(ctx context.Context, tx pgx.Tx, tenantID, label, atype string) (*Baseline, error) {
	var hoursJSON, ipsJSON, actionsJSON string
	var mean float64
	var clusterID *int
	err := tx.QueryRow(ctx, `
SELECT typical_hours::text, typical_ips::text, typical_actions::text, mean_actions_per_day, cluster_id
  FROM audit_user_baselines
 WHERE tenant_id = $1::uuid AND actor_label = $2 AND actor_type = $3
 ORDER BY day DESC
 LIMIT 1`, tenantID, label, atype).Scan(&hoursJSON, &ipsJSON, &actionsJSON, &mean, &clusterID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	b := Baseline{
		TenantID:          tenantID,
		ActorLabel:        label,
		ActorType:         atype,
		MeanActionsPerDay: mean,
		ClusterID:         clusterID,
	}
	hoursIntermediate := map[string]int{}
	_ = json.Unmarshal([]byte(hoursJSON), &hoursIntermediate)
	b.TypicalHours = map[int]int{}
	for k, v := range hoursIntermediate {
		var h int
		_, _ = fmt.Sscanf(k, "%d", &h)
		b.TypicalHours[h] = v
	}
	_ = json.Unmarshal([]byte(ipsJSON), &b.TypicalIPs)
	_ = json.Unmarshal([]byte(actionsJSON), &b.TypicalActions)
	return &b, nil
}

// AggregateScore composes per-detector confidences into a single
// [0..100] score. Each detector contributes confidence * weight; we
// cap the sum at 100 so a row with many detectors firing doesn't
// overflow the column constraint.
func AggregateScore(reasons []DetectorReason) float64 {
	weights := map[string]float64{
		"impossible_travel": 35,
		"off_hours":         15,
		"peer_group":        20,
		"escalation_chain":  40,
	}
	var score float64
	for _, r := range reasons {
		w, ok := weights[r.Type]
		if !ok {
			w = 10
		}
		score += r.Confidence * w
	}
	if score > 100 {
		return 100
	}
	if score < 0 {
		return 0
	}
	return score
}

func flattenMitre(reasons []DetectorReason) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 4)
	for _, r := range reasons {
		for _, m := range r.Mitre {
			if seen[m] {
				continue
			}
			seen[m] = true
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return out
}

// pgTextArray formats a Go string slice into a Postgres text[]
// literal. Embedded special chars are escaped — used only for
// MITRE technique IDs (which are alphanumeric) so the worst-case
// quoting is trivial, but we do it right anyway.
func pgTextArray(items []string) string {
	if len(items) == 0 {
		return "{}"
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, it := range items {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		for _, c := range it {
			if c == '"' || c == '\\' {
				b.WriteByte('\\')
			}
			b.WriteRune(c)
		}
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}
