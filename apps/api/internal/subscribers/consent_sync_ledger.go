// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-121 — Real-time consent sync ledger.
//
// When a subscriber unsubscribes (or otherwise revokes consent) Moosewave's
// webhook dispatcher fans the event out to every subscribed downstream tool.
// This file adds the per-destination *compliance ledger* (migration 0563) that
// records, for each downstream destination, whether the unsubscribe/consent
// signal was delivered and — when it failed — drives a bounded exponential-
// backoff retry. It lets a DPO answer "which CRM/ad-platform got the
// unsubscribe, and which failed?" and surfaces the failures for intervention.
//
// Production status: dormant and unmounted. The repository, retry worker, and
// HTTP route must not be composed until a real destination registry and
// authenticated delivery adapter exist. Missing adapters fail closed.

package subscribers

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrConsentSyncUnavailable is returned when the dormant ledger is invoked
// without real destination discovery or delivery wiring. Production leaves
// the surface unmounted until both adapters exist.
var ErrConsentSyncUnavailable = errors.New("consent sync ledger is unavailable")

// Consent-sync event types. Mirror the migration 0563 event_type CHECK.
const (
	ConsentSyncEventUnsubscribe    = "unsubscribe"
	ConsentSyncEventConsentRevoked = "consent_revoked"
	ConsentSyncEventConsentGranted = "consent_granted"
	ConsentSyncEventStatusChange   = "status_change"
)

// Consent-sync ledger statuses. Mirror the migration 0563 status CHECK.
const (
	ConsentSyncStatusPending   = "pending"
	ConsentSyncStatusDelivered = "delivered"
	ConsentSyncStatusRetrying  = "retrying"
	ConsentSyncStatusFailed    = "failed"
)

// consentSyncMaxAttempts caps the retry worker: 5 attempts over ~24h with
// exponential backoff (see consentSyncBackoff).
const consentSyncMaxAttempts = 5

// ConsentSyncDestination is one downstream target the unsubscribe signal must
// reach. ID is a stable connector/webhook identifier; URL is the resolved
// endpoint (may be empty for a logical destination).
type ConsentSyncDestination struct {
	ID  string
	URL string
}

// ConsentSyncDestinationLister returns the active downstream destinations a
// tenant's consent changes must propagate to, in the supplied tx. Implemented
// by an adapter over the webhooks/destinations registry in production
// composition.
type ConsentSyncDestinationLister interface {
	ListConsentSyncDestinations(ctx context.Context, tx pgx.Tx, tenantID string) ([]ConsentSyncDestination, error)
}

// ConsentSyncDeliverer attempts to push one ledger row's event to its
// destination. Returns nil on a delivered ack; a non-nil error marks the
// attempt failed and schedules a retry (until the cap). Implemented by an
// adapter over the webhook/HTTP client in main.go.
type ConsentSyncDeliverer interface {
	Deliver(ctx context.Context, row ConsentSyncLedgerRow) error
}

// ConsentSyncLedgerRow is one ledger entry (migration 0563).
type ConsentSyncLedgerRow struct {
	ID string `json:"id"`
	// TenantID is carried so a deliverer can address the destination without a
	// second lookup — the ledger row is the compliance record and must be
	// self-sufficient.
	TenantID        string     `json:"tenant_id"`
	SubscriberID    string     `json:"subscriber_id"`
	EventType       string     `json:"event_type"`
	DestinationID   string     `json:"destination_id"`
	DestinationURL  string     `json:"destination_url"`
	Status          string     `json:"status"`
	AttemptCount    int        `json:"attempt_count"`
	LastAttemptedAt *time.Time `json:"last_attempted_at,omitempty"`
	NextAttemptAt   *time.Time `json:"next_attempt_at,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// ConsentSyncLedger is the SUB-121 ledger writer + retry worker. Pool is
// required for the standalone read/retry paths; the RecordEvent dispatch path
// runs inside the caller's tx so it does not need its own connection.
type ConsentSyncLedger struct {
	Pool *db.Pool
	// Destinations resolves the per-tenant downstream targets. It is required;
	// a synthetic destination would not be delivery evidence.
	Destinations ConsentSyncDestinationLister
	// Deliverer performs a retry attempt and is required for retry sweeps.
	Deliverer ConsentSyncDeliverer
}

// RecordEvent inserts one pending ledger row per configured destination for the
// given (subscriber, event) inside tx. Idempotent on (subscriber, event,
// destination): a re-fire resets the row to pending for a fresh attempt rather
// than duplicating it.
func (l *ConsentSyncLedger) RecordEvent(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, eventType string) error {
	if l == nil || l.Destinations == nil {
		return ErrConsentSyncUnavailable
	}
	dests, err := l.Destinations.ListConsentSyncDestinations(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	for _, d := range dests {
		if _, err := tx.Exec(ctx, `
INSERT INTO consent_sync_ledger
       (tenant_id, subscriber_id, event_type, destination_id, destination_url, status, attempt_count, next_attempt_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', 0, now())
ON CONFLICT (tenant_id, subscriber_id, event_type, destination_id) DO UPDATE
   SET status          = 'pending',
       attempt_count   = 0,
       last_error      = '',
       next_attempt_at = now(),
       destination_url = EXCLUDED.destination_url,
       updated_at      = now()`,
			tenantID, subscriberID, eventType, d.ID, d.URL); err != nil {
			return err
		}
	}
	return nil
}

// ListForSubscriber returns the ledger rows for one subscriber, newest-first.
// ErrNotFound when the subscriber does not exist.
func (l *ConsentSyncLedger) ListForSubscriber(ctx context.Context, tenantID, subscriberID string) ([]ConsentSyncLedgerRow, error) {
	tx, err := db.WithTenant(ctx, l.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, consentSyncSelectSQL+`
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY created_at DESC`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	out, err := scanConsentSyncRows(rows)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RunRetrySweep claims up to limit due rows for the tenant (status in
// pending/retrying AND next_attempt_at <= now), attempts delivery through the
// Deliverer, and updates each row's status/backoff. Returns the number of rows
// processed. Missing delivery wiring fails visibly without claiming work.
func (l *ConsentSyncLedger) RunRetrySweep(ctx context.Context, tenantID string, limit int) (int, error) {
	if l == nil || l.Pool == nil || l.Deliverer == nil {
		return 0, ErrConsentSyncUnavailable
	}
	if limit <= 0 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, l.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, consentSyncSelectSQL+`
 WHERE tenant_id = $1::uuid
   AND status IN ('pending', 'retrying')
   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 ORDER BY next_attempt_at ASC NULLS FIRST
 LIMIT $2
 FOR UPDATE SKIP LOCKED`, tenantID, limit)
	if err != nil {
		return 0, err
	}
	due, err := scanConsentSyncRows(rows)
	if err != nil {
		return 0, err
	}

	processed := 0
	for _, row := range due {
		processed++
		attempt := row.AttemptCount + 1
		now := time.Now().UTC()
		derr := l.Deliverer.Deliver(ctx, row)
		if derr == nil {
			if _, err := tx.Exec(ctx, `
UPDATE consent_sync_ledger
   SET status='delivered', attempt_count=$3, last_attempted_at=$4,
       next_attempt_at=NULL, last_error='', updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, row.ID, attempt, now); err != nil {
				return processed, err
			}
			continue
		}
		// Failure: schedule a retry or give up at the cap.
		status := ConsentSyncStatusRetrying
		var next *time.Time
		if attempt >= consentSyncMaxAttempts {
			status = ConsentSyncStatusFailed
		} else {
			t := now.Add(consentSyncBackoff(attempt))
			next = &t
		}
		if _, err := tx.Exec(ctx, `
UPDATE consent_sync_ledger
   SET status=$3, attempt_count=$4, last_attempted_at=$5,
       next_attempt_at=$6, last_error=$7, updated_at=now()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
			tenantID, row.ID, status, attempt, now, next, truncErr(derr.Error())); err != nil {
			return processed, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return processed, err
	}
	return processed, nil
}

// consentSyncBackoff returns the delay before the Nth attempt (1-indexed):
// roughly 1m, 5m, 30m, 3h — bounded so the 5-attempt budget spans ~24h.
func consentSyncBackoff(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Minute
	case 2:
		return 5 * time.Minute
	case 3:
		return 30 * time.Minute
	default:
		// 2^(attempt) hours, capped at 12h.
		h := math.Pow(2, float64(attempt-2))
		if h > 12 {
			h = 12
		}
		return time.Duration(h) * time.Hour
	}
}

func truncErr(s string) string {
	const max = 1000
	if len(s) > max {
		return s[:max]
	}
	return s
}

const consentSyncSelectSQL = `
SELECT id::text, tenant_id::text, subscriber_id::text, event_type, destination_id, destination_url,
       status, attempt_count, last_attempted_at, next_attempt_at, last_error,
       created_at, updated_at
  FROM consent_sync_ledger`

func scanConsentSyncRows(rows pgx.Rows) ([]ConsentSyncLedgerRow, error) {
	defer rows.Close()
	out := []ConsentSyncLedgerRow{}
	for rows.Next() {
		var r ConsentSyncLedgerRow
		if err := rows.Scan(&r.ID, &r.TenantID, &r.SubscriberID, &r.EventType, &r.DestinationID, &r.DestinationURL,
			&r.Status, &r.AttemptCount, &r.LastAttemptedAt, &r.NextAttemptAt, &r.LastError,
			&r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ConsentSyncWebhookDestinations resolves consent-sync destinations from the
// outbound-webhook registry.
//
// Written because `ConsentSyncLedger` shipped complete — writer, retry sweep,
// idempotency, migration 0563 — and guarded at seven call sites by
// `if ... ConsentSyncLedger != nil`, with no composition path assigning it.
// Every one of those guards was permanently false: a subscriber unsubscribed,
// the local row updated, and nothing propagated to the destinations their data
// had been pushed to.
//
// That is the question a data-protection officer asks — "you were told to stop;
// who else holds this record and were they told?" — and the answer was a silent
// no, with the code to answer it already written.
//
// SUBSCRIPTION IS CONSENT TO RECEIVE, not merely to exist. Only webhooks that
// asked for `subscriber.unsubscribed` are returned: pushing a consent change to
// an endpoint that never requested one would itself be an unrequested
// disclosure. Disabled webhooks are excluded — a destination that is off is not
// a destination, and recording a ledger row against it would manufacture
// evidence of an attempt that cannot happen.
type ConsentSyncWebhookDestinations struct{}

func (ConsentSyncWebhookDestinations) ListConsentSyncDestinations(
	ctx context.Context, tx pgx.Tx, tenantID string,
) ([]ConsentSyncDestination, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, url
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND active
   AND deleted_at IS NULL
   AND 'subscriber.unsubscribed' = ANY (events)
 ORDER BY id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConsentSyncDestination{}
	for rows.Next() {
		var d ConsentSyncDestination
		if err := rows.Scan(&d.ID, &d.URL); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
