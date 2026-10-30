// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// fetchEvent loads a single audit_log row. Tenant scoping is enforced
// by the RLS policy on audit_log via the SET LOCAL app.tenant_id GUC
// that the caller already set on tx; no explicit tenant_id check is
// needed in the WHERE clause.
func fetchEvent(ctx context.Context, tx pgx.Tx, id int64) (Event, error) {
	const q = `
SELECT id,
       tenant_id::text,
       action,
       actor_type,
       COALESCE(actor_label, ''),
       COALESCE(resource_id, ''),
       COALESCE(host(ip), ''),
       COALESCE(user_id::text, ''),
       at,
       metadata
FROM audit_log
WHERE id = $1
LIMIT 1`
	row := tx.QueryRow(ctx, q, id)
	var e Event
	if err := row.Scan(&e.ID, &e.TenantID, &e.Action, &e.ActorType,
		&e.ActorLabel, &e.ResourceID, &e.IP, &e.UserID, &e.At, &e.Metadata); err != nil {
		return Event{}, fmt.Errorf("fetchEvent id=%d: %w", id, err)
	}
	if e.Metadata == nil {
		e.Metadata = map[string]any{}
	}
	return e, nil
}

// fetchWindow loads up to `cap` audit_log rows in [from, to]. Caller
// is expected to be in a tx with app.tenant_id already set.
func fetchWindow(ctx context.Context, tx pgx.Tx, from, to time.Time, cap int) ([]Event, error) {
	const q = `
SELECT id,
       tenant_id::text,
       action,
       actor_type,
       COALESCE(actor_label, ''),
       COALESCE(resource_id, ''),
       COALESCE(host(ip), ''),
       COALESCE(user_id::text, ''),
       at,
       metadata
FROM audit_log
WHERE at >= $1 AND at <= $2
ORDER BY at DESC
LIMIT $3`
	rows, err := tx.Query(ctx, q, from, to, cap)
	if err != nil {
		return nil, fmt.Errorf("fetchWindow: %w", err)
	}
	defer rows.Close()
	out := make([]Event, 0, 64)
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.TenantID, &e.Action, &e.ActorType,
			&e.ActorLabel, &e.ResourceID, &e.IP, &e.UserID, &e.At, &e.Metadata); err != nil {
			return nil, fmt.Errorf("fetchWindow scan: %w", err)
		}
		if e.Metadata == nil {
			e.Metadata = map[string]any{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// annotateAnomalies fills AnomalyScore + MitreTechniques on each event
// from audit_anomaly_scores. Rows without a UEBA score keep their
// zero-value AnomalyScore — the agent treats 0 as "no signal".
//
// The table may not exist on older deployments (UEBA is gated on a
// later migration). When the query fails with "relation does not
// exist" the annotation step is a soft no-op so the investigation
// still runs on its raw evidence.
func annotateAnomalies(ctx context.Context, tx pgx.Tx, tenantID string, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(events))
	for _, e := range events {
		ids = append(ids, e.ID)
	}
	const q = `
SELECT audit_id, score, COALESCE(mitre_techniques, '{}'::text[])
FROM audit_anomaly_scores
WHERE tenant_id = $1::uuid
  AND audit_id  = ANY($2::bigint[])`
	rows, err := tx.Query(ctx, q, tenantID, ids)
	if err != nil {
		// Tolerate missing table — UEBA-disabled deploys still get a
		// functional (if less informative) investigation.
		return nil
	}
	defer rows.Close()
	scores := map[int64]float64{}
	mitre := map[int64][]string{}
	for rows.Next() {
		var aid int64
		var s float64
		var techs []string
		if err := rows.Scan(&aid, &s, &techs); err != nil {
			return fmt.Errorf("annotateAnomalies scan: %w", err)
		}
		scores[aid] = s
		mitre[aid] = techs
	}
	for i := range events {
		if v, ok := scores[events[i].ID]; ok {
			events[i].AnomalyScore = v
		}
		if v, ok := mitre[events[i].ID]; ok {
			events[i].MitreTechniques = v
		}
	}
	return rows.Err()
}
