// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// DigestRunner emits campaign.opens.digest + campaign.clicks.digest
// webhook events on a configurable cadence (default hourly).
//
// Why this exists: campaign_report_events writes one row per recipient
// open / click. Firing a webhook per row would be N×subscribers events
// per campaign — easily 10k-100k for a real send. The catalog entries
// for campaign.opened and campaign.clicked stay in webhooks.AllEvents
// for tenants who genuinely want every-event firehose, but the
// expected pattern is to subscribe to the .digest variants.
//
// Pattern: every Tick(), find every (tenant, campaign) with new
// open/click events since the last emission cursor. Emit one digest
// event per tuple summarising the deltas + top-clicked links. Update
// the cursor in the same outbox tx so a crash mid-emit is replay-safe.
type DigestRunner struct {
	Pool       *db.Pool
	OutboxRepo *outbox.Repo
	Dispatcher *webhooks.Dispatcher
	// IntegrationFanouts is the same slice main.go wires into the
	// webhooks FanoutHandler — Slack/Discord/Teams adapters that
	// also receive the digest.
	IntegrationFanouts []webhooks.IntegrationFanouter
	Logger             *slog.Logger
	// Interval between ticks. Defaults to 1 hour. Production hourly is
	// the right cadence — sub-hourly digest spam defeats the purpose;
	// daily digests miss the "this campaign is going viral" signal.
	Interval time.Duration
}

// Run blocks until ctx is cancelled. Errors per-tick are logged but
// the loop continues — a single tenant's bad data must not break
// every other tenant's digest.
func (r *DigestRunner) Run(ctx context.Context) {
	if r == nil || r.Pool == nil || r.OutboxRepo == nil {
		return
	}
	interval := r.Interval
	if interval <= 0 {
		interval = 1 * time.Hour
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			r.tickOnce(ctx)
		}
	}
}

// tickOnce runs both the opens digest and clicks digest in the same
// pass, sharing the cursor read.
func (r *DigestRunner) tickOnce(ctx context.Context) {
	for _, kind := range []string{"opened", "clicked"} {
		if err := r.runDigestForKind(ctx, kind); err != nil {
			r.log().Warn("analytics digest tick failed",
				"event_kind", kind, "err", err.Error())
		}
	}
}

// digestRow is one (tenant, campaign) tuple that needs a digest emitted.
type digestRow struct {
	TenantID    string
	CampaignID  string
	WindowStart time.Time
	WindowEnd   time.Time
	Count       int
	UniqueCount int
	TopLinks    []LinkStats
}

func (r *DigestRunner) runDigestForKind(ctx context.Context, eventKind string) error {
	// One read tx to find work, then per-tuple write transactions to
	// emit + update cursor. Per-tuple isolation means a single
	// poisonous tenant doesn't block others.
	rows, err := r.findDueTuples(ctx, eventKind)
	if err != nil {
		return fmt.Errorf("find due: %w", err)
	}
	for _, row := range rows {
		if err := r.emitDigest(ctx, eventKind, row); err != nil {
			r.log().Warn("digest emit failed",
				"event_kind", eventKind,
				"tenant", row.TenantID,
				"campaign", row.CampaignID,
				"err", err.Error())
			// Don't return; continue with the next tuple.
		}
	}
	return nil
}

// findDueTuples locates every (tenant, campaign) pair with new events
// of `eventKind` since the cursor's last_at (or since campaign send
// when no cursor exists). Returns the deltas + top links so the
// emit step doesn't re-query.
func (r *DigestRunner) findDueTuples(ctx context.Context, eventKind string) ([]digestRow, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	// LEFT JOIN cursor → cursors.last_at IS NULL means "first digest
	// for this tuple"; we still emit (with the campaign's sent time as
	// the window start). Bounded by 32 tuples per tick so a backlog
	// after a long downtime doesn't fan out tens of thousands of
	// digests in one go.
	sqlText := `
SELECT cre.tenant_id::text, cre.campaign_id::text,
       COALESCE(c.last_at, '1970-01-01'::timestamptz) AS window_start,
       max(cre.at) AS window_end,
       count(*)::int AS n,
       count(DISTINCT cre.subscriber_email)::int AS uniq
  FROM campaign_report_events cre
  LEFT JOIN campaign_digest_cursors c
    ON c.tenant_id = cre.tenant_id
   AND c.campaign_id = cre.campaign_id
   AND c.event_kind = $1
 WHERE cre.event_type = $1
   AND cre.at > COALESCE(c.last_at, '1970-01-01'::timestamptz)
 GROUP BY cre.tenant_id, cre.campaign_id, c.last_at
 HAVING count(*) > 0
 ORDER BY window_end ASC
 LIMIT 32`
	pgRows, err := tx.Query(ctx, sqlText, eventKind)
	if err != nil {
		return nil, err
	}
	defer pgRows.Close()
	out := []digestRow{}
	for pgRows.Next() {
		var d digestRow
		if err := pgRows.Scan(&d.TenantID, &d.CampaignID,
			&d.WindowStart, &d.WindowEnd, &d.Count, &d.UniqueCount); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := pgRows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Top links pass for click digests only — opens have no links.
	if eventKind == "clicked" {
		for i := range out {
			top, _ := r.topLinksInWindow(ctx, out[i])
			out[i].TopLinks = top
		}
	}
	return out, nil
}

func (r *DigestRunner) topLinksInWindow(ctx context.Context, d digestRow) ([]LinkStats, error) {
	tx, err := db.WithTenant(ctx, r.Pool, d.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT link_url, count(*)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type = 'clicked'
   AND at > $3 AND at <= $4
   AND link_url IS NOT NULL
 GROUP BY link_url
 ORDER BY count(*) DESC
 LIMIT 5`, d.TenantID, d.CampaignID, d.WindowStart, d.WindowEnd)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LinkStats{}
	for rows.Next() {
		var l LinkStats
		if err := rows.Scan(&l.URL, &l.Clicks); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, tx.Commit(ctx)
}

// emitDigest fires the webhook event AND advances the cursor in the
// same tenant tx, so a crash between fire + cursor-update doesn't
// double-emit on the next tick.
func (r *DigestRunner) emitDigest(ctx context.Context, eventKind string, d digestRow) error {
	eventType := "campaign.opens.digest"
	if eventKind == "clicked" {
		eventType = "campaign.clicks.digest"
	}
	body := map[string]any{
		"tenant_id":    d.TenantID,
		"campaign_id":  d.CampaignID,
		"window_start": d.WindowStart,
		"window_end":   d.WindowEnd,
		"count":        d.Count,
		"unique_count": d.UniqueCount,
	}
	if len(d.TopLinks) > 0 {
		body["top_links"] = d.TopLinks
	}
	bodyBytes, _ := json.Marshal(body)

	tx, err := db.WithTenant(ctx, r.Pool, d.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fire via the dispatcher so the event reaches every subscribed
	// webhook + every wired integration adapter.
	if r.Dispatcher != nil {
		if _, err := r.Dispatcher.Fire(ctx, tx, webhooks.FireInput{
			TenantID:  d.TenantID,
			EventType: webhooks.EventType(eventType),
			Body:      json.RawMessage(bodyBytes),
		}); err != nil {
			return fmt.Errorf("dispatcher fire: %w", err)
		}
	}
	for _, adapter := range r.IntegrationFanouts {
		if adapter == nil {
			continue
		}
		if _, err := adapter.Fire(ctx, tx, d.TenantID, eventType, json.RawMessage(bodyBytes)); err != nil {
			return fmt.Errorf("integration fire: %w", err)
		}
	}
	// Advance the cursor in the same tx.
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_digest_cursors (tenant_id, campaign_id, event_kind, last_at)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (tenant_id, campaign_id, event_kind) DO UPDATE
   SET last_at = EXCLUDED.last_at, updated_at = now()`,
		d.TenantID, d.CampaignID, eventKind, d.WindowEnd,
	); err != nil {
		return fmt.Errorf("update cursor: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *DigestRunner) log() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}
