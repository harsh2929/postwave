// SPDX-License-Identifier: AGPL-3.0-only
//
// classification_filter_db_test.go — live-Postgres proof that the F01 band
// actually changes which rows are counted, in SQL, on every engagement
// endpoint in this package.
//
// The fixture is deliberately three recipients with three different fates,
// because two is not enough to catch the failure that matters. A fixture with
// only classified rows would let "unclassified counts as human" pass unnoticed;
// a fixture with only human and unknown would let the machine band be a copy of
// the human one. So: one recipient with an explicit HUMAN decision, one with an
// explicit MACHINE decision, and one that was never classified at all — the
// row that predates the classifier, which is the case every seam here gets
// wrong by default.
//
// Skips without DATABASE_URL, following the established pg-backed pattern in
// this package.
package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	ec "github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// f01ProbeUA is the user agent the fixture's machine registry entry matches.
// A fixture-local token rather than a real bot signature, so the test cannot
// pass or fail because the shipped registry changed.
const f01ProbeUA = "Mozilla/5.0 (compatible; PostwaveF01Probe/1.0)"

type f01Recipient struct {
	Email   string
	Country string
	UA      string
	Link    string
	// Client is ClassifyClient(UA) — the mail-client family the devices report
	// buckets this recipient into. The three recipients deliberately fall into
	// three DIFFERENT families so a devices assertion can name which one
	// survived a band instead of only counting how many did.
	Client string
	// Band is the classification the fixture writes for this recipient's
	// interactions. Empty means "never classified" — the unknown case.
	Band ec.Classification
}

type f01Fixture struct {
	TenantID   string
	CampaignID string
	Human      f01Recipient
	Machine    f01Recipient
	Unknown    f01Recipient
	At         time.Time
}

func (f f01Fixture) recipients() []f01Recipient {
	return []f01Recipient{f.Human, f.Machine, f.Unknown}
}

// f01InsertLedgerEvent writes one canonical subscriber_events row and returns
// its composite identity. `at` is part of the partitioned primary key, so it is
// echoed back rather than guessed by the caller.
func f01InsertLedgerEvent(
	t *testing.T, pool *db.Pool, ctx context.Context,
	tenantID, campaignID, email, eventType, ua, country, link string, at time.Time,
) ec.EventRef {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ref ec.EventRef
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events
    (tenant_id, subscriber_email, event_type, campaign_id, link_url, user_agent,
     country, source, at, metadata)
VALUES ($1::uuid, $2, $3, $4::uuid, NULLIF($5,''), $6, $7, 'f01-fixture', $8, '{}'::jsonb)
RETURNING id, at`, tenantID, email, eventType, campaignID, link, ua, country, at).
		Scan(&ref.ID, &ref.At); err != nil {
		t.Fatalf("insert subscriber_events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber_events: %v", err)
	}
	return ref
}

// f01InsertReportEvent writes the compatibility-model twin of a ledger event.
// The identity tuple MUST match exactly — that tuple is the bridge the
// campaign_report_events band predicate correlates on.
func f01InsertReportEvent(
	t *testing.T, pool *db.Pool, ctx context.Context,
	tenantID, campaignID, email, eventType, ua, link string, at time.Time, metadata string,
) {
	t.Helper()
	followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_report_events
    (tenant_id, campaign_id, subscriber_email, event_type, link_url, user_agent, at, metadata)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''), $6, $7, $8::jsonb)`,
		tenantID, campaignID, email, eventType, link, ua, at, metadata)
}

// f01Classify writes a real classification for one ledger event through the
// product's own append-only path.
//
// Using engagementclassification.Repo.Record rather than an INSERT means the
// test exercises the same shadow-view projection the filter reads. A
// hand-written INSERT could satisfy the filter's predicate while disagreeing
// with what the classifier would actually have produced.
func f01Classify(
	t *testing.T, pool *db.Pool, ctx context.Context,
	tenantID string, ref ec.EventRef, band ec.Classification, ua, eventType, key string,
) {
	t.Helper()
	config := ec.DefaultConfig()
	registry := []ec.RegistryEntry{{
		RegistryVersion: config.RegistryVersion,
		EntryID:         "R_F01_ANALYTICS_PROBE",
		MatcherType:     ec.MatchUASubstring,
		MatcherValue:    "postwavef01probe",
		MachineSubtype:  ec.SubtypeUnknownBot,
		Confidence:      1,
		SourceNote:      "analytics classification-filter fixture",
		LastVerified:    time.Now().UTC(),
	}}
	classifier, err := ec.NewClassifier(config, registry)
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}

	delivered := ref.At.Add(-2 * time.Minute)
	dwell := int64(45000) // 45s, comfortably over the 20s human-dwell floor
	observation := ec.ObservationInput{
		EventRef:           ref,
		Source:             "f01-fixture",
		SourceEventID:      key,
		IdempotencyKey:     key,
		EventSchemaVersion: ec.ObservationSchemaV1,
		// Echoed from the caller; RecordInTx overwrites it with the canonical
		// subscriber_events value before classifying, but the input validator
		// runs first and requires a well-formed one.
		EventType:       eventType,
		OccurredAt:      ref.At,
		IngestedAt:      ref.At,
		PrivacyExpiryAt: ref.At.Add(90 * 24 * time.Hour),
		UserAgent:       ua,
		OrderedHeaders: []ec.Header{
			{Name: "User-Agent", Value: ua},
			{Name: "Accept-Language", Value: "en-US"},
		},
		OrderedHeadersComplete: true,
		ProviderSignals:        map[string]any{},
	}
	if band == ec.Human {
		// Two positive rules clear the 0.80 human threshold from the 0.50
		// base: R_HUMAN_LATENCY (opened well after delivery) and
		// R_ENGAGEMENT_DEPTH (a real dwell beacon).
		observation.DeliveredAt = &delivered
		observation.DwellMilliseconds = &dwell
	}

	repo := &ec.Repo{Pool: pool}
	receipt, err := repo.Record(ctx, tenantID, observation, ec.MessageAggregate{}, classifier)
	if err != nil {
		t.Fatalf("record classification: %v", err)
	}
	if receipt.Result.Classification != band {
		t.Fatalf("fixture produced %q for %q, want %q — the fixture must genuinely "+
			"exercise the band, not assert 0 == 0",
			receipt.Result.Classification, key, band)
	}
}

// seedF01Fixture builds the three-fate campaign.
//
// Every recipient gets a delivery, an open and a click, written to BOTH the
// canonical ledger and the compatibility read model with the same identity, so
// the endpoints that read either table see the same population.
func seedF01Fixture(t *testing.T, pool *db.Pool, ctx context.Context) f01Fixture {
	t.Helper()
	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "f01 bands", "f01 bands "+tenantID[:8])
	suffix := tenantID[:8]
	fixture := f01Fixture{
		TenantID:   tenantID,
		CampaignID: campaignID,
		At:         time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Microsecond),
		Human: f01Recipient{
			Email: "f01-human-" + suffix + "@example.test", Country: "SE",
			UA:   "Mozilla/5.0 (Macintosh) HumanReader/1.0 Mail/1.0",
			Link: "https://example.test/human",
			Band: ec.Human,
		},
		Machine: f01Recipient{
			Email: "f01-machine-" + suffix + "@example.test", Country: "IE",
			UA: f01ProbeUA + " Yahoo", Link: "https://example.test/machine",
			Band: ec.Machine,
		},
		Unknown: f01Recipient{
			Email: "f01-unknown-" + suffix + "@example.test", Country: "NO",
			UA: "Mozilla/5.0 (Windows) SomethingNew/9.9", Link: "https://example.test/unknown",
			Band: "",
		},
	}
	fixture.Human.Client = ClassifyClient(fixture.Human.UA)
	fixture.Machine.Client = ClassifyClient(fixture.Machine.UA)
	fixture.Unknown.Client = ClassifyClient(fixture.Unknown.UA)
	// Guard the fixture: three recipients that collapsed into one client family
	// would make every devices assertion below unable to tell the bands apart.
	if fixture.Human.Client == fixture.Machine.Client ||
		fixture.Human.Client == fixture.Unknown.Client ||
		fixture.Machine.Client == fixture.Unknown.Client {
		t.Fatalf("fixture client families collapsed: human=%q machine=%q unknown=%q",
			fixture.Human.Client, fixture.Machine.Client, fixture.Unknown.Client)
	}

	for i, r := range fixture.recipients() {
		deliveredAt := fixture.At.Add(-2 * time.Minute)
		// Deliveries live only in the compatibility model here: they are the
		// engagement panel's denominator, and F01 never classifies them.
		f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, r.Email,
			"delivered", r.UA, "", deliveredAt, `{}`)

		for j, eventType := range []string{"opened", "clicked"} {
			at := fixture.At.Add(time.Duration(i*10+j) * time.Second)
			link := ""
			if eventType == "clicked" {
				link = r.Link
			}
			ref := f01InsertLedgerEvent(t, pool, ctx, tenantID, campaignID,
				r.Email, eventType, r.UA, r.Country, link, at)
			f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, r.Email,
				eventType, r.UA, link, ref.At, `{}`)
			if r.Band != "" {
				f01Classify(t, pool, ctx, tenantID, ref, r.Band, r.UA, eventType,
					fmt.Sprintf("f01-%s-%s-%d", suffix, eventType, i))
			}
		}
	}
	return fixture
}

// ----------------------------------------------------------------------
// The proof
// ----------------------------------------------------------------------

// Geography, devices and the link report read the canonical ledger directly.
// One recipient per band means each assertion is a distinct, non-trivial value:
// a filter that returned everything, nothing, or the wrong band all fail.
func TestClassificationFilterPartitionsLedgerBackedReportsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	svc := NewService(pool)

	countryOpens := func(filter ClassificationFilter) map[string]int {
		rows, err := svc.Geography(ctx, fixture.TenantID, fixture.CampaignID, filter)
		if err != nil {
			t.Fatalf("Geography(%q): %v", filter, err)
		}
		out := map[string]int{}
		for _, r := range rows {
			out[r.Country] = r.Opens
		}
		return out
	}

	all := countryOpens(ClassificationAll)
	if all[fixture.Human.Country] != 1 || all[fixture.Machine.Country] != 1 ||
		all[fixture.Unknown.Country] != 1 {
		t.Fatalf("unfiltered geography = %v; the fixture did not land, so every "+
			"assertion below would be vacuous", all)
	}

	human := countryOpens(ClassificationHuman)
	if human[fixture.Human.Country] != 1 {
		t.Errorf("human band lost the human open: %v", human)
	}
	if human[fixture.Machine.Country] != 0 {
		t.Errorf("human band counted the machine open: %v", human)
	}
	if human[fixture.Unknown.Country] != 0 {
		t.Errorf("human band counted the NEVER-CLASSIFIED open: %v — an event with "+
			"no decision is unknown, and laundering it into human is the exact "+
			"dishonesty F01 exists to end", human)
	}

	machine := countryOpens(ClassificationMachine)
	if machine[fixture.Machine.Country] != 1 || machine[fixture.Human.Country] != 0 ||
		machine[fixture.Unknown.Country] != 0 {
		t.Errorf("machine band = %v", machine)
	}

	unknown := countryOpens(ClassificationUnknown)
	if unknown[fixture.Unknown.Country] != 1 {
		t.Errorf("unknown band lost the never-classified open: %v", unknown)
	}
	if unknown[fixture.Human.Country] != 0 || unknown[fixture.Machine.Country] != 0 {
		t.Errorf("unknown band counted a settled event: %v", unknown)
	}

	// The bands must partition, not overlap: three ones that sum to the blend.
	total := human[fixture.Human.Country] + human[fixture.Machine.Country] + human[fixture.Unknown.Country] +
		machine[fixture.Human.Country] + machine[fixture.Machine.Country] + machine[fixture.Unknown.Country] +
		unknown[fixture.Human.Country] + unknown[fixture.Machine.Country] + unknown[fixture.Unknown.Country]
	if total != 3 {
		t.Errorf("bands sum to %d opens, want the 3 in the unfiltered report", total)
	}

	// Devices: the same rule, on the surface where machine contamination is
	// most visible to a customer.
	deviceOpens := func(filter ClassificationFilter) int {
		rows, err := svc.Devices(ctx, fixture.TenantID, fixture.CampaignID, filter)
		if err != nil {
			t.Fatalf("Devices(%q): %v", filter, err)
		}
		n := 0
		for _, r := range rows {
			n += r.Opens
		}
		return n
	}
	if got := deviceOpens(ClassificationAll); got != 3 {
		t.Fatalf("unfiltered device opens = %d, want 3", got)
	}
	for filter, want := range map[ClassificationFilter]int{
		ClassificationHuman: 1, ClassificationMachine: 1, ClassificationUnknown: 1,
	} {
		if got := deviceOpens(filter); got != want {
			t.Errorf("device opens for %q = %d, want %d", filter, got, want)
		}
	}

	// Link report: clicks only, per URL.
	linkClicks := func(filter ClassificationFilter) map[string]int {
		rows, err := svc.LinkReport(ctx, fixture.TenantID, fixture.CampaignID, filter)
		if err != nil {
			t.Fatalf("LinkReport(%q): %v", filter, err)
		}
		out := map[string]int{}
		for _, r := range rows {
			out[r.URL] = r.Clicks
		}
		return out
	}
	if got := linkClicks(ClassificationAll); len(got) != 3 {
		t.Fatalf("unfiltered link report = %v, want all three links", got)
	}
	if got := linkClicks(ClassificationHuman); len(got) != 1 || got[fixture.Human.Link] != 1 {
		t.Errorf("human link report = %v, want only the human link", got)
	}
	if got := linkClicks(ClassificationUnknown); got[fixture.Human.Link] != 0 ||
		got[fixture.Unknown.Link] != 1 {
		t.Errorf("unknown link report = %v", got)
	}
}

// Compare reads the ledger too, but in one pass that also counts bounces,
// complaints and unsubscribes. Those event types carry no classification, and
// filtering them would make a bouncing campaign look clean.
func TestClassificationFilterNeverZeroesUnclassifiableEventTypesDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)

	// A bounce and an unsubscribe on the canonical ledger. Neither is ever
	// classified, so neither may disappear under a band.
	bounceAt := fixture.At.Add(5 * time.Minute)
	f01InsertLedgerEvent(t, pool, ctx, fixture.TenantID, fixture.CampaignID,
		"f01-bounced-"+fixture.TenantID[:8]+"@example.test", "bounced", "", "SE", "", bounceAt)
	f01InsertLedgerEvent(t, pool, ctx, fixture.TenantID, fixture.CampaignID,
		"f01-unsub-"+fixture.TenantID[:8]+"@example.test", "unsubscribed", "", "SE", "",
		bounceAt.Add(time.Second))

	// campaign_recipients is Compare's denominator.
	followupExec(t, pool, ctx, fixture.TenantID, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email, status)
SELECT $1::uuid, $2::uuid, e, 'sent'
  FROM unnest($3::text[]) AS e`,
		fixture.TenantID, fixture.CampaignID,
		[]string{fixture.Human.Email, fixture.Machine.Email, fixture.Unknown.Email,
			"f01-bounced-" + fixture.TenantID[:8] + "@example.test",
			"f01-unsub-" + fixture.TenantID[:8] + "@example.test"})

	svc := NewService(pool)
	row := func(filter ClassificationFilter) CompareRow {
		rows, err := svc.Compare(ctx, fixture.TenantID, []string{fixture.CampaignID}, filter)
		if err != nil {
			t.Fatalf("Compare(%q): %v", filter, err)
		}
		if len(rows) != 1 {
			t.Fatalf("Compare(%q) returned %d rows", filter, len(rows))
		}
		return rows[0]
	}

	all := row(ClassificationAll)
	if all.TotalRecipients != 5 {
		t.Fatalf("unfiltered recipients = %d, want 5", all.TotalRecipients)
	}
	if all.BounceRate == 0 || all.UnsubRate == 0 || all.OpenRate == 0 {
		t.Fatalf("unfiltered compare row = %+v; the fixture did not land", all)
	}

	human := row(ClassificationHuman)
	// The band narrows opens and clicks...
	if human.OpenRate >= all.OpenRate {
		t.Errorf("human open rate %v did not narrow from the blend %v",
			human.OpenRate, all.OpenRate)
	}
	// ...and leaves the unclassifiable event types exactly alone.
	if human.BounceRate != all.BounceRate {
		t.Errorf("human band changed the bounce rate from %v to %v; bounces carry no "+
			"classification and a filtered bounce rate makes a failing campaign "+
			"look clean", all.BounceRate, human.BounceRate)
	}
	if human.UnsubRate != all.UnsubRate {
		t.Errorf("human band changed the unsub rate from %v to %v", all.UnsubRate, human.UnsubRate)
	}
	if human.TotalRecipients != all.TotalRecipients {
		t.Errorf("human band changed the denominator from %d to %d",
			all.TotalRecipients, human.TotalRecipients)
	}
}

// The engagement panel is the flagship. It reads campaign_report_events, which
// carries no foreign key to the classified ledger, so this is also the proof
// that the identity bridge works.
func TestEngagementPanelClassificationBandsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	svc := NewService(pool)

	panel := func(filter ClassificationFilter) EngagementPanel {
		p, err := svc.EngagementPanel(ctx, fixture.TenantID, fixture.CampaignID, false, filter)
		if err != nil {
			t.Fatalf("EngagementPanel(%q): %v", filter, err)
		}
		return p
	}

	all := panel(ClassificationAll)
	if all.Delivered != 3 || all.RawOpenRate != 1 {
		t.Fatalf("unfiltered panel = %+v; want 3 delivered and 3 unique opens", all)
	}
	if all.ClassificationFilter != "all" {
		t.Errorf("unfiltered panel filter = %q, want \"all\"", all.ClassificationFilter)
	}

	for filter, wantOpens := range map[ClassificationFilter]float64{
		ClassificationHuman: 1, ClassificationMachine: 1, ClassificationUnknown: 1,
	} {
		p := panel(filter)
		// THE DENOMINATOR SURVIVES. This is the assertion that stops a band
		// from reporting a confident 0% open rate.
		if p.Delivered != 3 {
			t.Errorf("%q band changed delivered from 3 to %d; the rate denominator "+
				"must not be filtered", filter, p.Delivered)
		}
		if got := p.RawOpenRate * float64(p.Delivered); got != wantOpens {
			t.Errorf("%q band unique opens = %v, want %v", filter, got, wantOpens)
		}
		if p.ClassificationFilter != string(filter) {
			t.Errorf("%q band echoed %q", filter, p.ClassificationFilter)
		}
	}

	// The bands partition the blend.
	sum := panel(ClassificationHuman).RawOpenRate + panel(ClassificationMachine).RawOpenRate +
		panel(ClassificationUnknown).RawOpenRate
	if sum != all.RawOpenRate {
		t.Errorf("bands sum to a raw open rate of %v, blend is %v", sum, all.RawOpenRate)
	}
}

// UNSET MUST KEEP TODAY'S NUMBERS EXACTLY.
//
// The oracle is the historical counting SQL itself, embedded verbatim and run
// against the same fixture. Comparing against a hand-written expectation would
// only prove the test author's arithmetic; comparing against the query this
// endpoint used before the band existed proves the default did not move.
//
// The one deliberate difference from the shipped text is the hard-bounce
// source: campaign_report_events has never had a bounce_type COLUMN, so the
// original expression could not execute at all. See
// TestEngagementPanelHardBounceReadsMetadataDB.
func TestUnsetClassificationReproducesTheHistoricalQueryDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Verbatim pre-F01 aggregation: no band, no interactionOnly, no bridge.
	rows, err := tx.Query(ctx, `
SELECT event_type,
       count(*)::int                            AS n,
       count(DISTINCT subscriber_email)::int    AS uniq
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type IN ('delivered','opened','clicked','bounced')
 GROUP BY event_type`, fixture.TenantID, fixture.CampaignID)
	if err != nil {
		t.Fatalf("historical query: %v", err)
	}
	var wantDelivered, wantOpens, wantClicks int
	for rows.Next() {
		var et string
		var n, uniq int
		if err := rows.Scan(&et, &n, &uniq); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		switch et {
		case "delivered":
			wantDelivered = n
		case "opened":
			wantOpens = uniq
		case "clicked":
			wantClicks = uniq
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if wantDelivered == 0 || wantOpens == 0 || wantClicks == 0 {
		t.Fatalf("historical oracle produced %d/%d/%d; a zero oracle would pass "+
			"against any implementation", wantDelivered, wantOpens, wantClicks)
	}

	svc := NewService(pool)
	got, err := svc.EngagementPanel(ctx, fixture.TenantID, fixture.CampaignID, false, ClassificationAll)
	if err != nil {
		t.Fatalf("EngagementPanel: %v", err)
	}
	if got.Delivered != wantDelivered {
		t.Errorf("unset delivered = %d, historical = %d", got.Delivered, wantDelivered)
	}
	if rate := got.RawOpenRate * float64(got.Delivered); rate != float64(wantOpens) {
		t.Errorf("unset unique opens = %v, historical = %d — the default response "+
			"moved, which silently rewrites every customer's reporting history",
			rate, wantOpens)
	}

	// The ledger-backed reports get the same treatment.
	var histOpens, histClicks int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FILTER (WHERE event_type = 'opened'),
       COUNT(*) FILTER (WHERE event_type = 'clicked')
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked')`,
		fixture.TenantID, fixture.CampaignID).Scan(&histOpens, &histClicks); err != nil {
		t.Fatalf("historical geography oracle: %v", err)
	}
	geo, err := svc.Geography(ctx, fixture.TenantID, fixture.CampaignID, ClassificationAll)
	if err != nil {
		t.Fatalf("Geography: %v", err)
	}
	gotOpens, gotClicks := 0, 0
	for _, r := range geo {
		gotOpens += r.Opens
		gotClicks += r.Clicks
	}
	if gotOpens != histOpens || gotClicks != histClicks {
		t.Errorf("unset geography = %d opens/%d clicks, historical = %d/%d",
			gotOpens, gotClicks, histOpens, histClicks)
	}
	if gotOpens == 0 {
		t.Fatal("geography oracle is empty; the comparison above proves nothing")
	}
}

// The grouped time series reads the compatibility model through the same
// bridge, over a date-bucketed window.
func TestGroupedTimeseriesClassificationBandsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	svc := NewService(pool)

	total := func(filter ClassificationFilter) int {
		series, err := svc.GroupedTimeseries(ctx, fixture.TenantID, "campaign", "opens", 7, filter)
		if err != nil {
			t.Fatalf("GroupedTimeseries(%q): %v", filter, err)
		}
		n := 0
		for _, s := range series {
			if s.Key != fixture.CampaignID {
				continue
			}
			for _, p := range s.Points {
				n += p.Value
			}
		}
		return n
	}

	if got := total(ClassificationAll); got != 3 {
		t.Fatalf("unfiltered series = %d opens, want 3", got)
	}
	for filter, want := range map[ClassificationFilter]int{
		ClassificationHuman: 1, ClassificationMachine: 1, ClassificationUnknown: 1,
	} {
		if got := total(filter); got != want {
			t.Errorf("series for %q = %d opens, want %d", filter, got, want)
		}
	}
	if _, err := svc.GroupedTimeseries(ctx, fixture.TenantID, "campaign", "bounces", 7,
		ClassificationHuman); err == nil {
		t.Error("a classification band on bounces was answered; bounces carry no " +
			"engagement classification and an empty series reads as 'no bounces'")
	}
}

// campaign_report_events has never had a bounce_type COLUMN — the ingester
// writes the canonical bounce type into the metadata envelope. Reading the
// column made this endpoint fail on every request for every tenant.
func TestEngagementPanelHardBounceReadsMetadataDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "f01 bounces", "f01 bounces "+tenantID[:8])
	at := time.Now().UTC().Add(-10 * time.Minute)

	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID,
		"hard-"+tenantID[:8]+"@example.test", "delivered", "", "", at, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID,
		"hard-"+tenantID[:8]+"@example.test", "bounced", "", "",
		at.Add(time.Minute), `{"bounce_type":"hard"}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID,
		"soft-"+tenantID[:8]+"@example.test", "delivered", "", "", at, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID,
		"soft-"+tenantID[:8]+"@example.test", "bounced", "", "",
		at.Add(time.Minute), `{"bounce_type":"soft"}`)

	// The panel's only consumer of the hard-bounce count is the AI-surfacing
	// score's bounce-health term, so that is where the number is observable.
	// hardBounceRate = 1/2 → 0.3*(1-0.5) = 0.15 with no other signal present.
	panel, err := NewService(pool).EngagementPanel(ctx, tenantID, campaignID, false, ClassificationAll)
	if err != nil {
		t.Fatalf("EngagementPanel: %v", err)
	}
	if panel.Delivered != 2 {
		t.Fatalf("delivered = %d, want 2", panel.Delivered)
	}
	if !almostEqual(panel.AISurfacingScore, 0.15) {
		t.Errorf("AI-surfacing score = %v, want 0.15 — one hard bounce out of two "+
			"deliveries; a score of 0.3 means the hard bounce was not seen at all",
			panel.AISurfacingScore)
	}
	if len(panel.AISurfacingBasis) == 0 || panel.AISurfacingBasis[0] != "hard_bounce_rate" {
		t.Errorf("AI-surfacing basis = %v, want hard_bounce_rate present",
			panel.AISurfacingBasis)
	}
}

// Replies are classified by a different, older classifier. The band must map
// onto the SHARED internal/replies predicates rather than a sixth private copy —
// and the UNFILTERED reply figure must be the number this endpoint has always
// returned.
//
// The shipped campaign_replies
// query carried no classification predicate; a human-only default deletes every
// reply written before the reply classifier existed (classification IS NULL)
// AND every auto-reply, from every historical report, with nothing on the wire
// to say the definition moved. On a real tenant that is most of the reply
// column going to near-zero overnight, which reads as an audience that stopped
// answering.
//
// The oracle is the pre-filter SQL itself, embedded verbatim and run against the
// same fixture — not a hand-written expectation, which would only prove the test
// author's arithmetic.
func TestUnsetReplyCountExcludesKnownMachineAndKeepsUnclassifiedDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "f01 replies", "f01 replies "+tenantID[:8])
	at := time.Now().UTC().Add(-15 * time.Minute)

	// A deliberately lopsided mix, so no two bands share an expected number and
	// a filter that returned the wrong band cannot pass by coincidence:
	//   2 human replies from alice, 1 from bob   → human    = 3 rows / 2 people
	//   1 out-of-office, 1 auto-reply            → machine  = 2 rows / 2 people
	//   1 reply stored before the classifier     → unknown  = 1 row  / 1 person
	//                                            → total    = 6 rows / 5 people
	alice := "reply-alice-" + tenantID[:8] + "@example.test"
	seed := []struct{ email, class string }{
		{alice, "human_reply"},
		{alice, "human_reply"},
		{"reply-bob-" + tenantID[:8] + "@example.test", "human_reply"},
		{"reply-ooo-" + tenantID[:8] + "@example.test", "out_of_office"},
		{"reply-auto-" + tenantID[:8] + "@example.test", "auto_reply"},
		{"reply-legacy-" + tenantID[:8] + "@example.test", ""},
	}
	delivered := map[string]bool{}
	for _, r := range seed {
		followupExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_replies
    (tenant_id, campaign_id, recipient_email, source, received_at, classification)
VALUES ($1::uuid, $2::uuid, $3, 'f01-fixture', $4, NULLIF($5,''))`,
			tenantID, campaignID, r.email, at, r.class)
		if !delivered[r.email] {
			delivered[r.email] = true
			// A delivery each, so the panel has a denominator and is not vacuous.
			f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, r.email,
				"delivered", "", "", at.Add(-time.Minute), `{}`)
		}
	}

	// The oracle: the exact query this endpoint ran before the band existed.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var histCount, histDistinct int64
	if err := tx.QueryRow(ctx, `
SELECT count(*)::bigint,
       count(DISTINCT recipient_email)::bigint
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(&histCount, &histDistinct); err != nil {
		t.Fatalf("historical reply oracle: %v", err)
	}
	if histCount != 6 || histDistinct != 5 {
		t.Fatalf("historical oracle = %d replies / %d repliers, want 6/5; the fixture "+
			"did not land and every assertion below would be vacuous",
			histCount, histDistinct)
	}

	svc := NewService(pool)
	reply := func(filter ClassificationFilter) (int64, int64) {
		p, err := svc.EngagementPanel(ctx, tenantID, campaignID, false, filter)
		if err != nil {
			t.Fatalf("EngagementPanel(%q): %v", filter, err)
		}
		return p.ReplyCount, p.DistinctReplyers
	}

	// The unset figure excludes what is KNOWN machine and retains what was never
	// classified: 3 human + 1 pre-classifier legacy = 4 rows / 3 people, out of a
	// historical 6/5. Deliberately neither endpoint of the argument:
	//
	//   - equal to 6/5 would count the out-of-office notice and the auto-reply as
	//     engagement, and this figure feeds AISurfacingScore where ReplyRate is
	//     weighted 0.5, so a holiday period would raise what gets surfaced.
	//   - equal to 3/2 (human-only) would drop the pre-classifier reply, and every
	//     historical reply count in the product would fall for a reason the
	//     product never states.
	gotCount, gotDistinct := reply(ClassificationAll)
	if gotCount != 4 || gotDistinct != 3 {
		t.Errorf("unset reply figure = %d replies / %d repliers, want 4/3 "+
			"(3 human + 1 unclassified, excluding the 2 known machine replies); "+
			"historical unfiltered was %d/%d",
			gotCount, gotDistinct, histCount, histDistinct)
	}
	// Guard the guard, in BOTH directions, so this cannot pass by coincidence.
	if gotCount == histCount {
		t.Error("the unset figure equals the raw historical total, so known " +
			"auto-replies are still being counted as engagement")
	}
	if humanOnly, _ := reply(ClassificationHuman); gotCount == humanOnly {
		t.Error("the unset figure equals the human-only band, so the pre-classifier " +
			"reply was dropped and history moved")
	}

	// And the three bands partition that total, each with its own number.
	for _, tc := range []struct {
		filter                  ClassificationFilter
		wantCount, wantDistinct int64
		why                     string
	}{
		{ClassificationHuman, 3, 2, "the three replies a person actually wrote"},
		{ClassificationMachine, 2, 2, "the out-of-office notice and the auto-reply"},
		{ClassificationUnknown, 1, 1, "the reply stored before the classifier existed; " +
			"a NULL classification is unknown, never human"},
	} {
		c, d := reply(tc.filter)
		if c != tc.wantCount || d != tc.wantDistinct {
			t.Errorf("%q reply figure = %d replies / %d repliers, want %d/%d — %s",
				tc.filter, c, d, tc.wantCount, tc.wantDistinct, tc.why)
		}
	}
	humanCount, _ := reply(ClassificationHuman)
	machineCount, _ := reply(ClassificationMachine)
	unknownCount, _ := reply(ClassificationUnknown)
	if humanCount+machineCount+unknownCount != histCount {
		t.Errorf("bands sum to %d replies, unfiltered total is %d — the three "+
			"predicates do not partition campaign_replies",
			humanCount+machineCount+unknownCount, histCount)
	}
	if humanCount == histCount {
		t.Error("the human band equals the raw historical total, so this fixture " +
			"cannot distinguish a human-only default from a correct one")
	}
}

// A compatibility row with no classified ledger twin is UNKNOWN, not missing.
//
// campaign_report_events has several writers that never touch the canonical
// ledger (the Mailchimp compat surface, conversion attribution, sample data).
// If the unknown band were written as EXISTS(classification = 'unknown') those
// rows would satisfy no band at all: they would vanish from human, from
// machine, and from unknown, and the three bands would quietly stop summing to
// the unfiltered total. This is the fixture that makes the negation load-bearing
// rather than stylistic.
func TestUnknownBandCountsCompatibilityRowsWithNoLedgerTwinDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "f01 orphan", "f01 orphan "+tenantID[:8])
	email := "f01-orphan-" + tenantID[:8] + "@example.test"
	at := time.Now().UTC().Add(-20 * time.Minute)

	// Compatibility rows only. No subscriber_events row exists for this open,
	// so no classification can exist for it either.
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, email, "delivered", "", "", at, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, email, "opened", "", "",
		at.Add(time.Minute), `{}`)

	svc := NewService(pool)
	opens := func(filter ClassificationFilter) float64 {
		p, err := svc.EngagementPanel(ctx, tenantID, campaignID, false, filter)
		if err != nil {
			t.Fatalf("EngagementPanel(%q): %v", filter, err)
		}
		if p.Delivered != 1 {
			t.Fatalf("%q band delivered = %d, want 1", filter, p.Delivered)
		}
		return p.RawOpenRate * float64(p.Delivered)
	}
	if got := opens(ClassificationAll); got != 1 {
		t.Fatalf("unfiltered opens = %v, want 1; the fixture did not land", got)
	}
	if got := opens(ClassificationHuman); got != 0 {
		t.Errorf("human band counted an open with no classification at all: %v", got)
	}
	if got := opens(ClassificationMachine); got != 0 {
		t.Errorf("machine band counted an open with no classification at all: %v", got)
	}
	if got := opens(ClassificationUnknown); got != 1 {
		t.Errorf("unknown band = %v, want 1 — a compatibility row with no classified "+
			"ledger twin has no decision, and an unknown band that cannot see it "+
			"loses the row from every band", got)
	}
}

// End to end through the mounted handler: the query parameter must actually
// reach the SQL, and the payload must state what it measured.
func TestEngagementPanelHandlerAppliesTheQueryParameterDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	deps := &ExtendedDeps{Service: NewService(pool)}

	call := func(query string) EngagementPanel {
		req := httptest.NewRequest(http.MethodGet,
			"/api/v1/campaigns/"+fixture.CampaignID+"/engagement"+query, nil)
		req = req.WithContext(middleware.WithTenant(req.Context(),
			&middleware.Tenant{ID: fixture.TenantID}))
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", fixture.CampaignID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		rec := httptest.NewRecorder()
		deps.EngagementPanel(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d body %s", query, rec.Code, rec.Body.String())
		}
		var out EngagementPanel
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}

	all := call("")
	if all.ClassificationFilter != "all" || all.RawOpenRate != 1 {
		t.Fatalf("unfiltered payload = %+v", all)
	}
	human := call("?classification=human")
	if human.ClassificationFilter != "human" {
		t.Errorf("payload filter = %q, want human", human.ClassificationFilter)
	}
	if got := human.RawOpenRate * float64(human.Delivered); got != 1 {
		t.Errorf("human unique opens through the handler = %v, want 1 — the query "+
			"parameter did not reach the SQL", got)
	}
	if human.Delivered != all.Delivered {
		t.Errorf("handler band changed delivered from %d to %d", all.Delivered, human.Delivered)
	}
}
