// SPDX-License-Identifier: AGPL-3.0-only
//
// G-20b — anonymous event ingestion, stitch-producer half.
//
// internal/publictrack's POST /api/public/track/anonymous writes activity
// into subscriber_anonymous_events (migration 1744) purely under a
// client-generated anonymous_id, with NO subscriber row involved. Separately,
// stitchAnonymous (anonymous_stitch.go) already links an anonymous_id to a
// now-known subscriber the moment an /identify call carries one, recording
// that link in subscriber_anonymous_profiles (migration 0451).
//
// AttributeAnonymousEvents is the piece that connects the two: given an
// anonymous_id that has just been stitched to subscriberID, it copies the
// accrued (not-yet-attributed) subscriber_anonymous_events rows onto the
// subscriber's normal timeline (subscriber_events), so the pre-identification
// activity shows up alongside everything recorded after. Each row is marked
// attributed_at so a repeated identify call for the same anonymous_id does
// not duplicate the copy.
//
// NOTE (wiring): this header used to say the method was "intentionally NOT
// called from stitchAnonymous or Identify yet", pending a product decision on
// whether backfill should be opt-in. That decision was made and the method IS
// wired: Identify calls it via attributeAnonymousAfterIdentify (identify.go)
// on all three outcomes — created, updated and merged. Backfill is
// unconditional, because an identify that carries an anonymous_id is itself
// the opt-in signal; there is no second flag.
//
// It runs POST-COMMIT rather than inside stitchAnonymous (the call site this
// note originally proposed) for two reasons: this method opens its own
// transaction, so calling it from inside the identify tx would nest, and
// holding the identify tx open across a bulk copy would widen a hot write
// path for work that is re-derivable. It is best-effort for the same reason
// scanPII is — the identity has already committed, and losing attribution is
// recoverable (the events are still on their alias, attributed_at unset)
// in a way losing the identity would not be.
//
// The wiring is asserted by TestIdentifyItselfAttributesPriorActivity, which
// drives Identify rather than this method, precisely so that unwiring it
// again fails a test.
package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/subscriberevents"
)

// anonEventToAttribute is one not-yet-attributed subscriber_anonymous_events
// row, read fully before any writes so the read cursor never overlaps a
// write on the same connection.
type anonEventToAttribute struct {
	id            int64
	eventName     *string
	eventType     string
	properties    []byte // raw jsonb
	sourceEventID *string
	occurredAt    time.Time
}

// AttributeAnonymousEvents copies subscriber_anonymous_events rows accrued
// under anonymousID onto subscriberID's subscriber_events timeline, then
// marks each copied row attributed_at so a repeated call is a no-op for rows
// already copied. Returns the number of events newly copied.
//
// Tolerant of migration 1744 not being applied yet (subscriber_anonymous_events
// absent): returns (0, nil) rather than failing the caller's identify flow,
// matching stitchAnonymous's tolerance of subscriber_anonymous_profiles
// (migration 0451) being absent.
//
// The copied event's source is "anonymous_stitch" and its source_event_id is
// derived from the anonymous event's own primary key (anon-<id>), which is
// stable and unique regardless of whether the original public-track call
// supplied a source_event_id — so a re-run (e.g. two identify calls racing
// before the attributed_at UPDATE commits) dedups via the same
// subscriber_event_dedup_keys mechanism RecordSubscriberEvent uses, rather
// than relying solely on the attributed_at marker.
func (r *Repo) AttributeAnonymousEvents(ctx context.Context, tenantID, anonymousID, subscriberID string) (int64, error) {
	if tenantID == "" || anonymousID == "" || subscriberID == "" {
		return 0, nil
	}

	var tx pgx.Tx
	var err error
	if r.EngagementClassifier != nil {
		tx, err = db.WithTenantWorker(ctx, r.Pool, tenantID)
	} else {
		tx, err = db.WithTenant(ctx, r.Pool, tenantID)
	}
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return 0, err
	}

	rows, err := tx.Query(ctx, `
SELECT id, event_name, event_type, properties, source_event_id, occurred_at
  FROM subscriber_anonymous_events
 WHERE tenant_id = $1::uuid AND anonymous_id = $2 AND attributed_at IS NULL
 ORDER BY occurred_at ASC`, tenantID, anonymousID)
	if err != nil {
		if isUndefinedTable(err) {
			return 0, nil
		}
		return 0, err
	}
	// Drain fully before issuing any writes on this tx/connection.
	pending := make([]anonEventToAttribute, 0, 16)
	for rows.Next() {
		var e anonEventToAttribute
		if err := rows.Scan(&e.id, &e.eventName, &e.eventType, &e.properties, &e.sourceEventID, &e.occurredAt); err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, e)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()

	if len(pending) == 0 {
		return 0, tx.Commit(ctx)
	}

	var copied int64
	for _, e := range pending {
		meta := map[string]any{}
		if len(e.properties) > 0 {
			_ = json.Unmarshal(e.properties, &meta)
		}
		meta["anonymous_id"] = anonymousID
		if e.eventName != nil && *e.eventName != "" {
			meta["event_name"] = *e.eventName
		}
		metaRaw, err := json.Marshal(meta)
		if err != nil {
			return copied, fmt.Errorf("marshal attributed anonymous event metadata: %w", err)
		}

		stitchSourceEventID := fmt.Sprintf("anon-%d", e.id)
		claim, err := subscriberevents.ClaimDedupKey(ctx, tx, tenantID, anonymousStitchSource, stitchSourceEventID)
		if err != nil {
			return copied, err
		}
		if claim.Claimed {
			var newID int64
			var newAt time.Time
			if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, campaign_id, link_url,
     user_agent, ip, at, source, source_event_id, metadata)
VALUES ($1::uuid, $2, $3, NULL, NULL, NULL, NULL, $4, $5, $6, $7::jsonb)
RETURNING id, at`,
				tenantID, sub.Email, e.eventType, e.occurredAt, anonymousStitchSource, stitchSourceEventID, string(metaRaw)).
				Scan(&newID, &newAt); err != nil {
				return copied, fmt.Errorf("insert attributed subscriber_event: %w", err)
			}
			if err := subscriberevents.BindDedupKey(ctx, tx, tenantID, anonymousStitchSource, stitchSourceEventID, newID, newAt); err != nil {
				return copied, err
			}
			if r.EngagementClassifier != nil {
				if err := r.EngagementClassifier.RecordProviderEvent(
					ctx, tx, tenantID,
					engagementclassification.ProviderEventInput{
						EventRef: engagementclassification.EventRef{ID: newID, At: newAt},
						Source:   anonymousStitchSource, SourceEventID: stitchSourceEventID,
						IdempotencyKey: fmt.Sprintf(
							"subscriber-event:%d:%s", newID,
							newAt.UTC().Format(time.RFC3339Nano),
						),
						EventSchemaVersion: engagementclassification.ObservationSchemaV1,
						EventType:          e.eventType,
						OccurredAt:         newAt,
						IngestedAt:         time.Now().UTC(),
						RecipientAddress:   sub.Email,
						OrderedHeaders:     []engagementclassification.Header{},
					},
				); err != nil {
					return copied, fmt.Errorf("classify attributed anonymous event: %w", err)
				}
			}
		}
		// Whether newly claimed or already bound by an earlier partial run,
		// the anonymous source row is now accounted for on the timeline —
		// mark it attributed so subsequent identify calls skip it.
		if _, err := tx.Exec(ctx, `
UPDATE subscriber_anonymous_events
   SET attributed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2 AND attributed_at IS NULL`,
			tenantID, e.id); err != nil {
			return copied, err
		}
		if claim.Claimed {
			copied++
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return copied, err
	}
	return copied, nil
}

// anonymousStitchSource namespaces the subscriber_events rows written by
// AttributeAnonymousEvents, mirroring how publictrack's trackSource
// ("first_party") scopes its own (tenant_id, source, source_event_id) dedup
// space. Distinct from publictrack's anonTrackSource, which namespaces rows
// on the OTHER table (subscriber_anonymous_events) before attribution.
const anonymousStitchSource = "anonymous_stitch"
