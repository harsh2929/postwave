// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

// Batch write tools let an agent apply many subscriber writes in a single
// governed call instead of N round-trips — the audit's "agents work with
// large lists" gap. Both are write-tier (gated by write_enabled + the full
// governance chokepoint) and bounded. Each item runs inside a per-item
// SAVEPOINT so one bad row (e.g. unknown subscriber) is reported without
// aborting the rest of the batch — partial success with a per-item report.

const maxBatchItems = 500

// batchResult is the per-item outcome returned to the agent.
type batchResult struct {
	Index   int            `json:"index"`
	OK      bool           `json:"ok"`
	Error   string         `json:"error,omitempty"`
	Data    map[string]any `json:"data,omitempty"`
	Deduped bool           `json:"deduped,omitempty"`
}

// runBatch applies fn to each item inside a per-item savepoint within one
// tenant write-tx, collecting per-item results. A failing item rolls back
// only its savepoint; the batch continues.
func runBatch[T any](ctx context.Context, d *Deps, items []T, fn func(ctx context.Context, tx pgx.Tx, tenantID string, item T) (map[string]any, bool, error)) (any, error) {
	return withTenantWriteTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		results := make([]batchResult, 0, len(items))
		var okCount int
		for i, item := range items {
			if _, err := tx.Exec(ctx, "SAVEPOINT pw_batch_item"); err != nil {
				return nil, fmt.Errorf("savepoint: %w", err)
			}
			data, deduped, err := fn(ctx, tx, tenantID, item)
			if err != nil {
				if _, rbErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT pw_batch_item"); rbErr != nil {
					return nil, fmt.Errorf("rollback savepoint: %w", rbErr)
				}
				results = append(results, batchResult{Index: i, OK: false, Error: err.Error()})
				continue
			}
			if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT pw_batch_item"); err != nil {
				return nil, fmt.Errorf("release savepoint: %w", err)
			}
			results = append(results, batchResult{Index: i, OK: true, Data: data, Deduped: deduped})
			okCount++
		}
		return map[string]any{
			"requested": len(items),
			"succeeded": okCount,
			"failed":    len(items) - okCount,
			"results":   results,
		}, nil
	})
}

// ---------------------------------------------------------------------
// batch_record_subscriber_events
// ---------------------------------------------------------------------

type batchEventsInput struct {
	Events []mcpSubscriberEventInput `json:"events"`
}

func handleBatchRecordSubscriberEvents(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in batchEventsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if len(in.Events) == 0 {
		return nil, errors.New("events must contain at least one item")
	}
	if len(in.Events) > maxBatchItems {
		return nil, fmt.Errorf("events is capped at %d items per call", maxBatchItems)
	}
	return runBatch(ctx, d, in.Events, func(ctx context.Context, tx pgx.Tx, tenantID string, ev mcpSubscriberEventInput) (map[string]any, bool, error) {
		ev.SubscriberID = strings.TrimSpace(ev.SubscriberID)
		ev.EventName = strings.TrimSpace(ev.EventName)
		ev.SourceEventID = strings.TrimSpace(ev.SourceEventID)
		if ev.SubscriberID == "" || ev.EventName == "" {
			return nil, false, errors.New("subscriber_id and event_name are required")
		}
		if len(ev.EventName) > 128 {
			return nil, false, errors.New("event_name exceeds 128 characters")
		}
		at := time.Now().UTC()
		if strings.TrimSpace(ev.OccurredAt) != "" {
			parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(ev.OccurredAt))
			if err != nil {
				return nil, false, fmt.Errorf("occurred_at must be RFC3339: %w", err)
			}
			at = parsed.UTC()
		}
		if ev.Metadata == nil {
			ev.Metadata = map[string]any{}
		}
		ev.Metadata["event_name"] = ev.EventName
		metaRaw, _ := json.Marshal(ev.Metadata)

		id, email, err := mcpResolveSubscriberIDEmail(ctx, tx, tenantID, ev.SubscriberID)
		if err != nil {
			return nil, false, err
		}
		var eventID int64
		var eventAt time.Time
		var deduped bool
		if ev.SourceEventID != "" {
			claim, claimErr := subscriberevents.ClaimDedupKey(ctx, tx, tenantID, "mcp", ev.SourceEventID)
			if claimErr != nil {
				return nil, false, claimErr
			}
			if !claim.Claimed {
				eventID, eventAt, deduped = claim.ExistingID, claim.ExistingAt, true
			} else {
				err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, at, source, source_event_id, metadata)
VALUES ($1::uuid, $2, 'custom', $3, 'mcp', $4, $5::jsonb)
RETURNING id, at`, tenantID, email, at, ev.SourceEventID, string(metaRaw)).Scan(&eventID, &eventAt)
				if err == nil {
					err = subscriberevents.BindDedupKey(ctx, tx, tenantID, "mcp", ev.SourceEventID, eventID, eventAt)
				}
			}
		} else {
			err = tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, at, source, metadata)
VALUES ($1::uuid, $2, 'custom', $3, 'mcp', $4::jsonb)
RETURNING id, at, false`,
				tenantID, email, at, string(metaRaw)).Scan(&eventID, &eventAt, &deduped)
		}
		if err != nil {
			return nil, false, err
		}
		return map[string]any{"id": eventID, "subscriber_id": id, "event_name": ev.EventName, "at": eventAt}, deduped, nil
	})
}

// ---------------------------------------------------------------------
// batch_upsert_subscriber_aliases
// ---------------------------------------------------------------------

type batchAliasesInput struct {
	Aliases []mcpSubscriberAliasInput `json:"aliases"`
}

func handleBatchUpsertSubscriberAliases(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in batchAliasesInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if len(in.Aliases) == 0 {
		return nil, errors.New("aliases must contain at least one item")
	}
	if len(in.Aliases) > maxBatchItems {
		return nil, fmt.Errorf("aliases is capped at %d items per call", maxBatchItems)
	}
	// Each item delegates to the canonical subscriber aggregate writer in its
	// own transaction. That preserves the batch's partial-success contract
	// while ensuring every successful item independently commits its exact
	// revision, collision check, audit, webhook, and engine intent. Agents
	// should not place two writes for the same subscriber in one batch unless
	// each carries the revision returned by the preceding write.
	results := make([]batchResult, 0, len(in.Aliases))
	okCount := 0
	for index, alias := range in.Aliases {
		raw, err := json.Marshal(alias)
		if err != nil {
			results = append(results, batchResult{Index: index, OK: false, Error: "invalid alias arguments"})
			continue
		}
		out, err := handleUpsertSubscriberAlias(ctx, d, raw)
		if err != nil {
			results = append(results, batchResult{Index: index, OK: false, Error: err.Error()})
			continue
		}
		encoded, err := json.Marshal(out)
		if err != nil {
			results = append(results, batchResult{Index: index, OK: false, Error: "alias response could not be encoded"})
			continue
		}
		data := map[string]any{}
		if err := json.Unmarshal(encoded, &data); err != nil {
			results = append(results, batchResult{Index: index, OK: false, Error: "alias response could not be decoded"})
			continue
		}
		results = append(results, batchResult{Index: index, OK: true, Data: data})
		okCount++
	}
	return map[string]any{
		"requested": len(in.Aliases),
		"succeeded": okCount,
		"failed":    len(in.Aliases) - okCount,
		"results":   results,
	}, nil
}
