// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The three buckets must sum, and the unknown band must be present.
//
// This is the PRD's product rule expressed as a type: a caller cannot obtain
// the human count without the unknown count, because they arrive in one struct.
// The failure it prevents is the one F01 exists to fix — a dashboard reporting
// "8,200 human opens" over a population where 3,000 events were unclassifiable,
// with no way for the reader to know.
func TestSummaryBucketsSumAndCarryTheUnknownBand(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	// Seed real classifications. A summary over an EMPTY tenant sums 0+0+0 and
	// passes every arithmetic assertion no matter how broken the counting is —
	// the first version of this test did exactly that, and a mutation removing
	// `unknown` from the total sailed through it.
	repo := &Repo{Pool: app}
	// Built WITH a registry entry, because mustClassifier's variadic registry
	// defaults to empty — a classifier with no registry can never return a
	// machine verdict, so the machine bucket would stay 0 whatever the UA said.
	classifierV2 := mustClassifier(t, DefaultConfig(),
		registryEntry("R_GMAIL_PROXY_UA", MatchUASubstring, "googleimageproxy",
			SubtypeGmailProxy, 0.99))
	for i := range fixture.Events {
		observation := classifierDBObservation(fixture, i)
		if i == 0 {
			// One event that MATCHES the seeded registry, so the machine bucket
			// and its subtype breakdown are genuinely exercised. Without this the
			// fixture produces only `unknown`, the machine bucket is 0, and the
			// breakdown assertion compares 0 to 0 — which a mutation deleting the
			// breakdown entirely passed straight through.
			observation.UserAgent = "Mozilla/5.0 (compatible; GoogleImageProxy)"
		}
		if _, err := repo.Record(ctx, fixture.TenantID,
			observation, MessageAggregate{}, classifierV2); err != nil {
			t.Fatalf("record observation %d: %v", i, err)
		}
	}

	summary, err := repo.ClassificationSummaryFor(ctx, SummaryQuery{
		TenantID: fixture.TenantID,
		Since:    fixture.At.Add(-24 * time.Hour),
		Until:    fixture.At.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("ClassificationSummaryFor: %v", err)
	}

	// Guard the guard: with no rows every assertion below is vacuous.
	if summary.Total == 0 {
		t.Fatal("no classifications were counted; this test would pass against a " +
			"completely broken summary")
	}
	if summary.Human+summary.Machine+summary.Unknown != summary.Total {
		t.Fatalf("buckets %d/%d/%d do not sum to total %d — a reader cannot trust "+
			"any one of them", summary.Human, summary.Machine, summary.Unknown, summary.Total)
	}
	if summary.ClassifierVersion == "" {
		t.Error("no classifier version accompanies the counts; the PRD requires the " +
			"version wherever the result is shown, and two months' figures are not " +
			"comparable without it")
	}
	if summary.ConfigurationHash == "" || summary.MixedClassifierVersions ||
		len(summary.ClassifierVersionCoverage) != 1 {
		t.Fatalf("single-version provenance is incomplete or falsely mixed: %+v", summary)
	}
	if summary.Machine == 0 {
		t.Fatal("no machine traffic was classified; the subtype assertion below " +
			"would compare 0 to 0 and pass against a deleted breakdown")
	}
	machineTotal := int64(0)
	for _, n := range summary.MachineBySubtype {
		machineTotal += n
	}
	if machineTotal != summary.Machine {
		t.Errorf("subtype breakdown sums to %d but the machine bucket is %d; the "+
			"two disagree", machineTotal, summary.Machine)
	}
}

// Campaign scoping and interaction eligibility are part of the same product
// contract as the three buckets. A delivery row can have a classifier decision
// for operational reasons without becoming engagement. Controlled seed rows
// are independently default-denied by forced RLS and the explicit read filter.
func TestSummaryScopesCampaignAndCountsOnlyInteractions_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID)
	})

	otherCampaignID := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'F01 other campaign', 'F01 other', '<p>F01</p>')`,
		otherCampaignID, fixture.TenantID); err != nil {
		t.Fatalf("seed other campaign: %v", err)
	}

	insertEvent := func(eventType, campaignID string, offset time.Duration) EventRef {
		t.Helper()
		sourceID := "summary-scope-" + uuid.NewString()
		var event EventRef
		if err := admin.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES (
    $1::uuid, $2, $3, $4::uuid, 'f01-summary-scope',
    $5, $5, $6, '{}'::jsonb, $7
)
RETURNING id, at`, fixture.TenantID,
			fmt.Sprintf("summary-%s@example.test", sourceID), eventType, campaignID,
			sourceID, "<"+sourceID+"@example.test>",
			fixture.At.Add(offset)).Scan(&event.ID, &event.At); err != nil {
			t.Fatalf("seed %s event: %v", eventType, err)
		}
		return event
	}

	classifier := mustClassifier(t, DefaultConfig())
	repo := &Repo{Pool: app}
	record := func(event EventRef, ordinal int) {
		t.Helper()
		observation := classifierDBObservation(fixture, 0)
		observation.EventRef = event
		observation.Source = "f01-summary-scope"
		observation.SourceEventID = fmt.Sprintf("summary-source-%d", ordinal)
		observation.IdempotencyKey = fmt.Sprintf("summary-observation-%s-%d", fixture.TenantID, ordinal)
		observation.OccurredAt = event.At
		observation.IngestedAt = event.At
		observation.PrivacyExpiryAt = event.At.AddDate(1, 0, 0)
		if _, err := repo.Record(ctx, fixture.TenantID, observation,
			MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record scoped classification %d: %v", ordinal, err)
		}
	}

	for i := range fixture.Events {
		record(fixture.Events[i], i)
	}
	// One valid interaction in another campaign, plus two deliberately
	// ineligible classified rows in the requested campaign.
	record(insertEvent("clicked", otherCampaignID, 3*time.Second), 10)
	record(insertEvent("delivered", fixture.CampaignID, 4*time.Second), 11)

	query := SummaryQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.At.Add(-time.Minute), Until: fixture.At.Add(time.Minute),
	}
	summary, err := repo.ClassificationSummaryFor(ctx, query)
	if err != nil {
		t.Fatalf("campaign summary: %v", err)
	}
	if summary.Total != int64(len(fixture.Events)) {
		rows, queryErr := admin.Query(ctx, `
SELECT event_type, COALESCE(campaign_id::text, ''), is_seed, count(*)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, fixture.TenantID)
		var dimensions []string
		if queryErr == nil {
			for rows.Next() {
				var eventType, campaignID string
				var seed bool
				var count int
				if scanErr := rows.Scan(&eventType, &campaignID, &seed, &count); scanErr == nil {
					dimensions = append(dimensions,
						fmt.Sprintf("%s/%s/seed=%v=%d", eventType, campaignID, seed, count))
				}
			}
			rows.Close()
		}
		t.Fatalf("campaign total = %d, want %d; another campaign or non-interaction leaked in; events=%v query_err=%v",
			summary.Total, len(fixture.Events), dimensions, queryErr)
	}

	query.CampaignID = otherCampaignID
	other, err := repo.ClassificationSummaryFor(ctx, query)
	if err != nil {
		t.Fatalf("other campaign summary: %v", err)
	}
	if other.Total != 1 {
		t.Fatalf("other campaign total = %d, want 1", other.Total)
	}

	query.CampaignID = ""
	all, err := repo.ClassificationSummaryFor(ctx, query)
	if err != nil {
		t.Fatalf("all-campaign summary: %v", err)
	}
	if all.Total != int64(len(fixture.Events)+1) {
		t.Fatalf("all-campaign interaction total = %d, want %d",
			all.Total, len(fixture.Events)+1)
	}
}

func TestSummaryDisclosesMixedClassifierVersionsInsteadOfUsingLatestLabel_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID)
	})

	configV2 := DefaultConfig()
	classifierV2 := mustClassifier(t, configV2)
	configV3 := DefaultConfig()
	configV3.MethodologyVersion = "postwave.engagement-methodology.summary-mixed.v3"
	configV3.HumanLatencyWeight = 0.14
	classifierV3 := mustClassifier(t, configV3)
	repo := &Repo{Pool: app}
	for i, classifier := range []*Classifier{classifierV2, classifierV3} {
		if _, err := repo.Record(ctx, fixture.TenantID,
			classifierDBObservation(fixture, i), MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record version %d: %v", i, err)
		}
	}

	summary, err := repo.ClassificationSummaryFor(ctx, SummaryQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.At.Add(-time.Minute), Until: fixture.At.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("mixed summary: %v", err)
	}
	if !summary.MixedClassifierVersions || len(summary.ClassifierVersionCoverage) != 2 {
		t.Fatalf("mixed classifier provenance was hidden: %+v", summary)
	}
	if summary.ClassifierVersion != "" || summary.MethodologyVersion != "" ||
		summary.RegistryVersion != "" || summary.ConfigurationHash != "" {
		t.Fatalf("mixed summary was mislabeled with one scalar version: %+v", summary)
	}
	var covered int64
	for _, version := range summary.ClassifierVersionCoverage {
		covered += version.EventCount
	}
	if covered != summary.Total {
		t.Fatalf("version coverage=%d does not reconcile to total=%d", covered, summary.Total)
	}
}

// A backwards window is refused rather than silently returning nothing.
func TestSummaryRefusesAnInvertedWindow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, app := classifierDBPools(t, ctx)

	now := time.Now().UTC()
	if _, err := (&Repo{Pool: app}).ClassificationSummaryFor(ctx, SummaryQuery{
		TenantID: "00000000-0000-0000-0000-000000000000",
		Since:    now,
		Until:    now.AddDate(0, 0, -1),
	}); err == nil {
		t.Fatal("an inverted window returned a summary; zero counts over an " +
			"impossible range read as 'no machine traffic'")
	}
}

// A missing tenant is refused. A summary is tenant-scoped by construction and
// an empty tenant id under RLS would return zero rows, which is the same shape
// as a quiet week.
func TestSummaryRefusesAnEmptyTenant(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, app := classifierDBPools(t, ctx)

	if _, err := (&Repo{Pool: app}).ClassificationSummaryFor(ctx, SummaryQuery{}); err == nil {
		t.Fatal("an empty tenant returned a summary instead of an error")
	}
}
