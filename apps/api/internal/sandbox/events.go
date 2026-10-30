// SPDX-License-Identifier: AGPL-3.0-only
package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SimSchedule controls the proportion of recipients that receive each
// downstream event type. Defaults to {open:0.30, click:0.05, bounce:0.005,
// complaint:0.001} per the spec.
type SimSchedule struct {
	OpenRate      float64
	ClickRate     float64
	BounceRate    float64
	ComplaintRate float64
	// Window caps the time horizon over which events are scheduled.
	DeliveredWithin time.Duration
	OpenWithin      time.Duration
	ClickWithin     time.Duration
	BounceWithin    time.Duration
}

// DefaultSchedule is the production default lifecycle distribution.
var DefaultSchedule = SimSchedule{
	OpenRate:        0.30,
	ClickRate:       0.05,
	BounceRate:      0.005,
	ComplaintRate:   0.001,
	DeliveredWithin: 5 * time.Minute,
	OpenWithin:      1 * time.Hour,
	ClickWithin:     2 * time.Hour,
	BounceWithin:    30 * time.Minute,
}

// EventQueue is the slice of *db.Pool the simulator needs. Defined as an
// interface so tests can stand in a fake without standing up Postgres.
type EventQueue interface {
	EnqueueSandbox(ctx context.Context, ev SandboxEvent) error
}

// SandboxEvent is a single row in sandbox_events.
type SandboxEvent struct {
	TenantID        string
	CampaignID      string
	SubscriberEmail string
	EventType       string // open | click | bounce | complaint | delivered
	At              time.Time
}

// Simulator orchestrates SimulateLifecycle over a Queue.
type Simulator struct {
	Queue  EventQueue
	Logger *slog.Logger
}

// SimulateLifecycle enqueues deterministic fake events into sandbox_events.
// Times are derived from a sha256 hash of (campaignID, recipientIndex) so a
// re-run produces an identical timeline. The synthetic recipient email is
// `sandbox+<idx>@<tenant>.sandbox.postwave.invalid` — an unroutable domain
// so a misconfigured flusher cannot accidentally send mail.
func (s *Simulator) SimulateLifecycle(
	ctx context.Context,
	tenantID, campaignID string,
	recipientCount int,
	schedule SimSchedule,
	now time.Time,
) error {
	if s.Queue == nil {
		return fmt.Errorf("sandbox: queue not wired")
	}
	if recipientCount <= 0 {
		return nil
	}
	for i := 0; i < recipientCount; i++ {
		email := syntheticEmail(tenantID, i)
		bucket := hashBucket(campaignID, i)

		if err := s.Queue.EnqueueSandbox(ctx, SandboxEvent{
			TenantID: tenantID, CampaignID: campaignID,
			SubscriberEmail: email, EventType: "delivered",
			At: now.Add(scaleDuration(bucket.deliveredOffset, schedule.DeliveredWithin)),
		}); err != nil {
			return err
		}
		if bucket.openProb < schedule.OpenRate {
			_ = s.Queue.EnqueueSandbox(ctx, SandboxEvent{
				TenantID: tenantID, CampaignID: campaignID,
				SubscriberEmail: email, EventType: "opened",
				At: now.Add(scaleDuration(bucket.openOffset, schedule.OpenWithin)),
			})
		}
		if bucket.clickProb < schedule.ClickRate {
			_ = s.Queue.EnqueueSandbox(ctx, SandboxEvent{
				TenantID: tenantID, CampaignID: campaignID,
				SubscriberEmail: email, EventType: "clicked",
				At: now.Add(scaleDuration(bucket.clickOffset, schedule.ClickWithin)),
			})
		}
		if bucket.bounceProb < schedule.BounceRate {
			_ = s.Queue.EnqueueSandbox(ctx, SandboxEvent{
				TenantID: tenantID, CampaignID: campaignID,
				SubscriberEmail: email, EventType: "bounced",
				At: now.Add(scaleDuration(bucket.bounceOffset, schedule.BounceWithin)),
			})
		}
		if bucket.complaintProb < schedule.ComplaintRate {
			_ = s.Queue.EnqueueSandbox(ctx, SandboxEvent{
				TenantID: tenantID, CampaignID: campaignID,
				SubscriberEmail: email, EventType: "complained",
				At: now.Add(scaleDuration(bucket.complaintOffset, schedule.BounceWithin)),
			})
		}
	}
	return nil
}

// hashedBucket carries the deterministic per-recipient floats (in [0,1)) used
// to decide which lifecycle events fire and at what offsets.
type hashedBucket struct {
	openProb, clickProb, bounceProb, complaintProb         float64
	deliveredOffset, openOffset, clickOffset, bounceOffset float64
	complaintOffset                                        float64
}

func hashBucket(campaignID string, idx int) hashedBucket {
	h := sha256.New()
	h.Write([]byte(campaignID))
	h.Write([]byte{0})
	var idxBuf [8]byte
	binary.BigEndian.PutUint64(idxBuf[:], uint64(idx))
	h.Write(idxBuf[:])
	sum := h.Sum(nil)

	// 8 floats from 32 bytes → 4 bytes each → uint32 / max-uint32.
	f := func(start int) float64 {
		v := binary.BigEndian.Uint32(sum[start : start+4])
		return float64(v) / float64(1<<32)
	}
	return hashedBucket{
		openProb: f(0), clickProb: f(4), bounceProb: f(8), complaintProb: f(12),
		deliveredOffset: f(16), openOffset: f(20), clickOffset: f(24),
		bounceOffset: f(28), complaintOffset: f(28),
	}
}

func scaleDuration(frac float64, max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(frac * float64(max))
}

func syntheticEmail(tenantID string, idx int) string {
	// 8-hex-char fingerprint of the tenant id keeps the email short and
	// distinct without leaking the full UUID.
	sum := sha256.Sum256([]byte(tenantID))
	fp := hex.EncodeToString(sum[:4])
	return fmt.Sprintf("sandbox+%d@%s.sandbox.postwave.invalid", idx, fp)
}

// --- pgx-backed Queue + Flusher ---

// PgxQueue is the production EventQueue. Inserts rows directly into
// sandbox_events without a tenant-scoped tx (the table's permissive flusher
// policy permits this; the restrictive tenant policy still applies for any
// tenant-context read).
type PgxQueue struct {
	Pool *db.Pool
}

// EnqueueSandbox inserts a single row.
func (q *PgxQueue) EnqueueSandbox(ctx context.Context, ev SandboxEvent) error {
	conn, err := q.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, `
INSERT INTO sandbox_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5)`,
		ev.TenantID, ev.CampaignID, ev.SubscriberEmail, ev.EventType, ev.At)
	return err
}

// Flusher promotes due sandbox_events into subscriber_events. Run from a
// goroutine in main.go via Run(ctx). Exits when ctx is done.
type Flusher struct {
	Pool     *db.Pool
	Interval time.Duration
	Logger   *slog.Logger
}

// Run loops Flush every Interval until ctx is done.
func (f *Flusher) Run(ctx context.Context) {
	interval := f.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := f.Flush(ctx, time.Now().UTC()); err != nil {
				if f.Logger != nil {
					f.Logger.Warn("sandbox flush failed", "err", err.Error())
				}
			} else if n > 0 && f.Logger != nil {
				f.Logger.Debug("sandbox flush", "promoted", n)
			}
		}
	}
}

// Flush moves every undelivered sandbox row whose `at` is <= now into
// subscriber_events and marks the source row delivered=true.
//
// We use a single SQL CTE so the promote+mark happens atomically per batch.
// Returns the number of rows promoted.
func (f *Flusher) Flush(ctx context.Context, now time.Time) (int, error) {
	conn, err := f.Pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	tag, err := conn.Exec(ctx, `
WITH due AS (
    SELECT id, tenant_id, campaign_id, subscriber_email, event_type, at
    FROM sandbox_events
    WHERE delivered = false AND at <= $1
    ORDER BY at
    LIMIT 500
), promoted AS (
    INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, campaign_id, at)
    SELECT tenant_id, subscriber_email, event_type, campaign_id, at FROM due
    RETURNING 1
)
UPDATE sandbox_events SET delivered = true
WHERE id IN (SELECT id FROM due)`, now)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
