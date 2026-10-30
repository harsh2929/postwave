// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"encoding/json"
	"time"
)

// ProgressEvent is a database-derived, content-free lifecycle receipt. EventNo
// is a stable per-run cursor; callers must not infer progress from timestamps.
type ProgressEvent struct {
	TenantID        string          `json:"-"`
	CampaignID      string          `json:"campaign_id"`
	RunID           string          `json:"run_id"`
	EventNo         int64           `json:"event_no"`
	EventID         string          `json:"event_id"`
	AttemptCount    int             `json:"attempt_count"`
	EventType       string          `json:"event_type"`
	Stage           string          `json:"stage"`
	Status          string          `json:"status"`
	EntityID        *string         `json:"entity_id,omitempty"`
	ArtifactID      *string         `json:"artifact_id,omitempty"`
	ConfigurationID *string         `json:"configuration_id,omitempty"`
	ReceiptHash     *string         `json:"receipt_hash,omitempty"`
	Metadata        json.RawMessage `json:"metadata"`
	OccurredAt      time.Time       `json:"occurred_at"`
}

// ListProgressEvents returns trigger-derived progress strictly after the
// supplied per-run cursor. It cannot expose another tenant even if a run UUID
// is guessed because the query executes inside the normal tenant RLS boundary.
func (r *Repo) ListProgressEvents(
	ctx context.Context,
	tenantID, runID string,
	afterEventNo int64,
	limit int,
) ([]ProgressEvent, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok || afterEventNo < 0 {
		return nil, ErrInvalidInput
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, campaign_id::text, run_id::text,
       event_no, event_id::text, attempt_count, event_type, stage, status,
       entity_id::text, artifact_id::text, configuration_id, receipt_hash,
       metadata, occurred_at
  FROM campaign_assurance_progress_events
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND event_no > $3
 ORDER BY event_no
 LIMIT $4`, tenantID, runID, afterEventNo, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	values := make([]ProgressEvent, 0)
	for rows.Next() {
		var value ProgressEvent
		if err := rows.Scan(
			&value.TenantID, &value.CampaignID, &value.RunID,
			&value.EventNo, &value.EventID, &value.AttemptCount,
			&value.EventType, &value.Stage, &value.Status,
			&value.EntityID, &value.ArtifactID, &value.ConfigurationID,
			&value.ReceiptHash, &value.Metadata, &value.OccurredAt,
		); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return values, nil
}
