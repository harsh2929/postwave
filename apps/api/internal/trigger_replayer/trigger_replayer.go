// Package trigger_replayer implements the SUB-003 retroactive trigger window.
//
// Modern CDP-grade identity stitching (Segment, Customer.io, Klaviyo "Active
// on Site") accrues activity under an anonymous_id BEFORE the visitor hands
// over an email. When the eventual /subscribers/identify call stitches that
// anonymous_id onto a now-known profile, automations that key on
// pre-identification activity (welcome/abandon flows) must still fire for the
// events that happened while the visitor was anonymous — but only within a
// bounded backward window (we default to 72h) so a months-old anonymous hit
// doesn't suddenly trip a welcome flow.
//
// The replayer reads the reparented activity in subscriber_events inside that
// window and emits one synthetic 'identified' event per distinct source event
// so the automation runtime re-evaluates its triggers against the now-known
// profile. 'identified' is an event_type already allow-listed by migration
// 0324.
//
// This is a small, dependency-light seam: it takes a *pgxpool.Pool and a
// tenant-scoping helper so the subscribers package (and tests) can wire it
// without dragging the whole events/automation stack in.
package trigger_replayer

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// DefaultWindow is the SUB-003 retroactive trigger window: 72h backwards from
// the identify moment. Activity older than this is merged onto the profile
// (it stays queryable) but does NOT replay triggers.
const DefaultWindow = 72 * time.Hour

// Replayer emits synthetic 'identified' events for the activity a freshly
// stitched profile accrued while anonymous.
type Replayer struct {
	Pool *db.Pool
}

// New constructs a Replayer over the given pool.
func New(pool *db.Pool) *Replayer { return &Replayer{Pool: pool} }

// ReplayResult reports what the window query found and emitted.
type ReplayResult struct {
	// EventsInWindow is the count of pre-identification events found within
	// the backward window for this profile's email.
	EventsInWindow int
	// SyntheticEmitted is the number of synthetic 'identified' events
	// written for trigger re-evaluation (one per source event in window).
	SyntheticEmitted int
}

// RetryIdentifiedEventsWithin queries subscriber_events for the profile's
// activity within `window` backwards from now and emits a synthetic
// 'identified' event for each, so the automation runtime replays triggers
// against the now-known profile.
//
// subscriberEmail is the canonical address the events were reparented to
// (the identify path moves anonymous-placeholder events onto this address
// before calling the replayer). A zero or negative window falls back to
// DefaultWindow. The whole thing runs in one tenant-scoped transaction so
// the RLS policy gates both the read and the synthetic writes.
func (r *Replayer) RetryIdentifiedEventsWithin(ctx context.Context, tenantID, subscriberEmail string, window time.Duration) (*ReplayResult, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("trigger_replayer: pool required")
	}
	if tenantID == "" {
		return nil, errors.New("trigger_replayer: tenant required")
	}
	if subscriberEmail == "" {
		return nil, errors.New("trigger_replayer: subscriber email required")
	}
	if window <= 0 {
		window = DefaultWindow
	}
	cutoff := time.Now().UTC().Add(-window)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	res, err := replayInTx(ctx, tx, tenantID, subscriberEmail, cutoff)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return res, nil
}

// replayInTx is the SQL body, factored out so it can run inside an existing
// caller-owned transaction too (the identify path can replay post-write
// without a second connection if it chooses to thread its tx in).
func replayInTx(ctx context.Context, tx pgx.Tx, tenantID, subscriberEmail string, cutoff time.Time) (*ReplayResult, error) {
	rows, err := tx.Query(ctx, `
SELECT event_type, campaign_id, at
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND event_type <> 'identified'
   AND at >= $3
 ORDER BY at ASC`, tenantID, subscriberEmail, cutoff)
	if err != nil {
		return nil, err
	}
	type windowEvent struct {
		eventType  string
		campaignID *string
		at         time.Time
	}
	var found []windowEvent
	for rows.Next() {
		var we windowEvent
		if err := rows.Scan(&we.eventType, &we.campaignID, &we.at); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, we)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	res := &ReplayResult{EventsInWindow: len(found)}
	for _, we := range found {
		// Emit a synthetic 'identified' event so the automation runtime
		// re-evaluates triggers for the now-known profile. We carry the
		// original campaign linkage so campaign-scoped triggers still match.
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, campaign_id, at)
VALUES ($1::uuid, $2, 'identified', $3, now())`,
			tenantID, subscriberEmail, we.campaignID); err != nil {
			return nil, err
		}
		res.SyntheticEmitted++
	}
	return res, nil
}
