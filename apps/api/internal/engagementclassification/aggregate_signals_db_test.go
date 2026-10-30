// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The rules are dead unless the loader fills the fields they read. A rule that
// can never fire in production is worse than no rule: it reads as coverage
// while measuring nothing.
//
// Seeds through the SAME path as the rest of the F01 suite — canonical
// subscriber_events rows plus Repo.Record — so a column the writer stops
// populating fails here too.
func TestAggregateLoaderPopulatesTheImpossibilitySignals_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig())

	messageHash := repeat("a", 63) + "9"
	suffix := strings.ReplaceAll(fixture.TenantID, "-", "")[:12]
	base := fixture.At.Add(-time.Hour).Truncate(time.Microsecond)

	type seeded struct {
		id int64
		at time.Time
	}
	seed := func(eventType string, at time.Time, providerID string) seeded {
		var out seeded
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
) VALUES ($1::uuid, $2, $3, $4::uuid, 'f01-signals', $5, $5, $6, '{}'::jsonb, $7)
RETURNING id, at`,
			fixture.TenantID, "signals-"+suffix+"@example.test", eventType,
			fixture.CampaignID, providerID,
			"<signals-"+suffix+"@example.test>", at).Scan(&out.id, &out.at); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %s: %v", eventType, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit seed: %v", err)
		}
		return out
	}

	// A click BEFORE either open, then two opens 300ms apart from two regions —
	// the shape a link-first scanner produces.
	clickEvent := seed("clicked", base, "sig-click-"+suffix)
	openOne := seed("opened", base.Add(30*time.Second), "sig-open1-"+suffix)
	openTwo := seed("opened", base.Add(30*time.Second+300*time.Millisecond), "sig-open2-"+suffix)

	record := func(event seeded, key, region, link string) ObservationInput {
		observation := classifierDBObservation(fixture, 0)
		observation.EventRef = EventRef{ID: event.id, At: event.at}
		observation.MessageIdentityHash = messageHash
		observation.OccurredAt = event.at
		observation.DeliveredAt = nil
		observation.NetworkRegion = region
		observation.LinkIdentityHash = link
		observation.IdempotencyKey = "signals-" + key + "-" + suffix
		observation.SourceEventID = "sig-" + key + "-" + suffix
		if _, err := repo.Record(ctx, fixture.TenantID, observation, MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record %s: %v", key, err)
		}
		return observation
	}
	click := record(clickEvent, "click", "eu-west-1", repeat("b", 63)+"1")
	record(openOne, "open1", "eu-west-1", "")
	record(openTwo, "open2", "us-east-1", "")

	tx, err := app.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The observation table is worker-scoped: production loads this aggregate
	// inside WithTenantWorker, so the tenant GUC alone sees nothing.
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.outbox_worker','true',true),
		        set_config('app.engagement_classifier_worker','true',true),
		        set_config('app.tenant_id', $1, true)`,
		fixture.TenantID); err != nil {
		t.Fatalf("scope: %v", err)
	}

	aggregate, err := loadMessageAggregate(ctx, tx, fixture.TenantID, click)
	if err != nil {
		t.Fatalf("load aggregate: %v", err)
	}

	if aggregate.OpenCount != 2 {
		t.Errorf("OpenCount = %d, want 2", aggregate.OpenCount)
	}
	if aggregate.MinOpenGap <= 0 || aggregate.MinOpenGap > time.Second {
		t.Errorf("MinOpenGap = %v, want the sub-second gap between the two opens", aggregate.MinOpenGap)
	}
	if aggregate.FirstOpenAt == nil {
		t.Fatal("FirstOpenAt was not populated, so click-before-open can never fire")
	}
	if !click.OccurredAt.Before(*aggregate.FirstOpenAt) {
		t.Errorf("the click was not seen as preceding the first open: click=%v open=%v",
			click.OccurredAt, *aggregate.FirstOpenAt)
	}
	if aggregate.DistinctOpenRegions != 2 {
		t.Errorf("DistinctOpenRegions = %d, want 2", aggregate.DistinctOpenRegions)
	}
	if aggregate.RegionSpan <= 0 {
		t.Error("RegionSpan was not measured, so geographic impossibility can never fire")
	}

	// And the rules must actually fire on the loaded aggregate — the point of
	// populating the fields at all.
	result, err := classifier.Classify(click, aggregate)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"R_RAPID_REPEAT_OPEN", "R_CLICK_BEFORE_OPEN", "R_GEO_IMPOSSIBLE"} {
		if !firedRule(result, id) {
			t.Errorf("%s did not fire on a loaded aggregate that exhibits it: %+v", id, result.Rules)
		}
	}
	if result.Classification != Machine {
		t.Errorf("three impossibility rules produced %q, not machine", result.Classification)
	}
}
