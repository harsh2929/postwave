// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The two latency rules are the reason delivered_at matters.
//
// R_PREFETCH_LATENCY ("an open under 5s after delivery is machine") and
// R_HUMAN_LATENCY ("an open after 30s with no machine indicators is weak human
// evidence") both read a delivery time. The `delivered_at` COLUMN is accepted
// end-to-end and populated by no writer, so both rules read nil and never fired —
// which meant Apple prefetching a message milliseconds after delivery produced no
// machine signal at all.
func TestAnOpenImmediatelyAfterDeliveryIsMachine(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	delivered := time.Now().UTC().Add(-2 * time.Second)

	observation := validObservation()
	observation.EventType = "opened"
	observation.OccurredAt = delivered.Add(1500 * time.Millisecond)
	// Set on the OBSERVATION, which takes precedence over the aggregate. The
	// fixture already carries a DeliveredAt, so passing one only via the
	// aggregate left the fixture's value in force and measured a different
	// latency entirely — the first version of this test asserted on a number it
	// was not controlling.
	observation.DeliveredAt = &delivered

	result, err := classifier.Classify(observation, MessageAggregate{
		Complete: true, DeliveredAt: &delivered,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRule(result, "R_PREFETCH_LATENCY") {
		t.Fatalf("an open 1.5s after delivery produced no prefetch signal: %+v",
			result.Rules)
	}
}

// And a plausibly-human delay produces the human signal.
func TestAnOpenLongAfterDeliveryIsWeakHumanEvidence(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	delivered := time.Now().UTC().Add(-2 * time.Hour)

	observation := validObservation()
	observation.EventType = "opened"
	observation.OccurredAt = delivered.Add(45 * time.Minute)
	observation.DeliveredAt = &delivered

	result, err := classifier.Classify(observation, MessageAggregate{
		Complete: true, DeliveredAt: &delivered,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRule(result, "R_HUMAN_LATENCY") {
		t.Fatalf("an open 45 minutes after delivery produced no human signal: %+v",
			result.Rules)
	}
	if hasRule(result, "R_PREFETCH_LATENCY") {
		t.Error("a 45-minute delay was also called a prefetch")
	}
}

// With no delivery time, NEITHER rule fires — and that is correct.
//
// The absence of a delivery time is not evidence either way. This asserts the
// classifier does not invent one, because guessing (say, from ingested_at) would
// make every backfilled event look like a prefetch.
func TestWithNoDeliveryTimeNeitherLatencyRuleFires(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.EventType = "opened"
	observation.DeliveredAt = nil

	result, err := classifier.Classify(observation, MessageAggregate{Complete: true})
	if err != nil {
		t.Fatal(err)
	}
	if hasRule(result, "R_PREFETCH_LATENCY") || hasRule(result, "R_HUMAN_LATENCY") {
		t.Fatalf("a latency rule fired with no delivery time; the classifier "+
			"invented one and every backfilled event would look like a prefetch: %+v",
			result.Rules)
	}
}

// The aggregate DERIVES a delivery time from a sibling 'delivered' event.
//
// Behavioural, not a source grep. A source check for the derivation survives
// `if false && eventType == "delivered"` — the text is still there — and that
// exact mutation defeated the first version of this test. It is the fourth time in
// this project a presence-of-symbol guard has failed to detect disablement, so the
// rule is now explicit: presence guards catch DELETION, and only a behavioural
// test catches a short-circuit.
func TestTheAggregateDerivesDeliveryFromASiblingDeliveredEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())

	// Two observations for the SAME message: a delivery, then an open.
	//
	// The canonical subscriber_events rows are seeded DIRECTLY with the event
	// types this test needs, because the observation's event_type is forced
	// server-side by trigger from the canonical row — the fixture's spoofed value
	// is discarded, which is the correct behaviour and means a test cannot set it
	// from the observation side.
	messageHash := repeat("d", 64)
	deliveredAt := fixture.At.Add(-time.Hour).Truncate(time.Microsecond)
	suffix := strings.ReplaceAll(fixture.TenantID, "-", "")[:12]

	type seededEvent struct {
		id int64
		at time.Time
	}
	seed := func(eventType string, at time.Time, providerID string) seededEvent {
		var out seededEvent
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatalf("begin seed: %v", err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.TenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("scope: %v", err)
		}
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES ($1::uuid, $2, $3, $4::uuid, 'f01-latency', $5, $5, $6, '{}'::jsonb, $7)
RETURNING id, at`,
			fixture.TenantID, "latency-"+suffix+"@example.test", eventType,
			fixture.CampaignID, providerID,
			"<latency-"+suffix+"@example.test>", at).Scan(&out.id, &out.at); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %s event: %v", eventType, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit seed: %v", err)
		}
		return out
	}

	deliveredEvent := seed("delivered", deliveredAt, "lat-delivered-"+suffix)
	openEvent := seed("opened", deliveredAt.Add(2*time.Second), "lat-open-"+suffix)

	record := func(event seededEvent, key string) ObservationInput {
		observation := classifierDBObservation(fixture, 0)
		observation.EventRef = EventRef{ID: event.id, At: event.at}
		observation.MessageIdentityHash = messageHash
		observation.OccurredAt = event.at
		observation.DeliveredAt = nil
		observation.IdempotencyKey = "latency-" + key + "-" + suffix
		observation.SourceEventID = "lat-" + key + "-" + suffix
		if _, err := repo.Record(ctx, fixture.TenantID, observation, MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record %s observation: %v", key, err)
		}
		return observation
	}
	record(deliveredEvent, "delivered")
	open := record(openEvent, "open")

	// Load the aggregate the way production does.
	tx, err := app.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, guc := range []string{"app.tenant_id", "app.outbox_worker", "app.engagement_classifier_worker"} {
		value := "true"
		if guc == "app.tenant_id" {
			value = fixture.TenantID
		}
		if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, guc, value); err != nil {
			t.Fatalf("set %s: %v", guc, err)
		}
	}

	aggregate, err := loadMessageAggregate(ctx, tx, fixture.TenantID, open)
	if err != nil {
		t.Fatalf("loadMessageAggregate: %v", err)
	}
	// Guard the guard: an aggregate over zero siblings proves nothing.
	if aggregate.EventCount == 0 {
		t.Fatal("the aggregate saw no sibling observations; the assertion below " +
			"would pass against a completely broken derivation")
	}
	if aggregate.DeliveredAt == nil {
		t.Fatal("no delivery time was derived from the sibling 'delivered' event, " +
			"so R_PREFETCH_LATENCY and R_HUMAN_LATENCY both read nil and neither " +
			"can ever fire")
	}
	if !aggregate.DeliveredAt.Equal(deliveredAt.UTC()) {
		t.Errorf("derived delivery time = %s, want %s",
			aggregate.DeliveredAt, deliveredAt.UTC())
	}
}
