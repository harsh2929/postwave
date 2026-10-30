// SPDX-License-Identifier: AGPL-3.0-only
//
// classification_filter_http_db_test.go — behavioural guards at the HTTP layer
// for the F01 classification band, and the behavioural proof of the
// campaign_report_events identity bridge.
//
// # WHY THIS FILE EXISTS SEPARATELY FROM THE SERVICE-LEVEL PROOFS
//
// The service-level tests in classification_filter_db_test.go prove that
// Service.Geography(..., ClassificationHuman) filters. They say nothing about
// whether the handler that reads ?classification= ever hands that value to the
// Service. An adversarial verifier mutated four handlers so each still parsed
// the parameter, still returned 400 for a bad value, and then called the
// Service with ClassificationAll — and the entire package stayed green.
//
// That is the worst shape a defect can take here. An absent filter is visible:
// the caller gets a 400 or an unknown-parameter response and knows. A filter
// that is accepted and ignored returns a blended human+machine number under a
// header that says "human", and there is nothing anywhere in the payload or the
// logs to contradict it. The number is wrong and confident.
//
// So each endpoint that accepts the parameter gets a test that goes in through
// the handler with the query string a customer would send, and asserts on the
// JSON that comes back out — not that it is "filtered", but that it contains
// the human recipient and NOT the machine or never-classified ones. The
// recipients are distinguishable by country, link URL and mail-client family
// precisely so that "which rows survived" is answerable rather than merely
// countable.
//
// # THAT CLAIM USED TO BE A PROMISE, AND THE PROMISE WAS ALREADY BROKEN
//
// An earlier revision of this comment asserted, flatly, that EVERY endpoint
// advertising the parameter had such a test. It did not. The round that wrote
// it fixed exactly the four handlers the verifier of the day happened to name
// (Geography, Devices, LinkReport, Compare) and left GroupedTimeseries with
// nothing but validation-only handler tests — so a later verifier mutated that
// fifth handler into parse-reject-echo-but-never-band and the whole package
// stayed green. On GroupedTimeseries the mutant is worse than a wrong number:
// the response body echoes classification_filter, so the payload
// AFFIRMATIVELY ASSERTED "human" while carrying the blend.
//
// A prose promise is not a mechanism, and a list maintained by whoever last
// read the file will drift again. So the enumeration now lives in
// f01BandHandlerCoverage below and is checked against the source by
// TestEveryClassificationHandlerHasABehaviouralHandlerTest: a seventh handler
// that starts accepting ?classification= fails that test until somebody adds a
// behavioural proof for it. The tests named in that map are the behavioural
// guards; the map itself only guarantees the list is complete.
package analytics

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	ec "github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// f01HandlerJSON drives one analytics handler exactly as chi would and decodes
// the successful body into out.
//
// The handler is called directly rather than through a mounted router so the
// test does not also depend on the API-key scope middleware; everything this
// file asserts — query-parameter parsing, the value handed to the Service, the
// encoded response — happens inside the handler.
func f01HandlerJSON(
	t *testing.T,
	deps *ExtendedDeps,
	call func(*ExtendedDeps, http.ResponseWriter, *http.Request),
	tenantID, campaignID, target string,
	out any,
) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	if campaignID != "" {
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", campaignID)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	}
	rec := httptest.NewRecorder()
	call(deps, rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: status %d, body %s", target, rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("GET %s: decode %v (body %s)", target, err, rec.Body.String())
	}
}

// ----------------------------------------------------------------------
// DEFECT 1 — the query parameter must reach the SQL on every endpoint that
// advertises it, not only on the engagement panel.
// ----------------------------------------------------------------------

// Geography is the surface where the blend is most visibly wrong: a
// datacentre-hosted scanner reports the country of the scanner, so an
// unfiltered map invents an audience in a region the sender has no subscribers
// in. A handler that accepts ?classification=human and returns that invented
// region is worse than one that never offered the filter.
func TestGeographyHandlerAppliesTheClassificationBandDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	deps := &ExtendedDeps{Service: NewService(pool)}

	opensByCountry := func(query string) map[string]int {
		var rows []GeographyRow
		f01HandlerJSON(t, deps, (*ExtendedDeps).Geography, fixture.TenantID, fixture.CampaignID,
			"/api/v1/campaigns/"+fixture.CampaignID+"/geography"+query, &rows)
		out := map[string]int{}
		for _, r := range rows {
			out[r.Country] = r.Opens
		}
		return out
	}

	all := opensByCountry("")
	if all[fixture.Human.Country] != 1 || all[fixture.Machine.Country] != 1 ||
		all[fixture.Unknown.Country] != 1 {
		t.Fatalf("unfiltered geography = %v; the fixture did not land, so the "+
			"filtered assertions below would be vacuous", all)
	}

	human := opensByCountry("?classification=human")
	if human[fixture.Human.Country] != 1 {
		t.Errorf("human geography = %v; lost the human open (country %s)",
			human, fixture.Human.Country)
	}
	if human[fixture.Machine.Country] != 0 {
		t.Errorf("GET /geography?classification=human returned the MACHINE open "+
			"(country %s) as well: %v — the query parameter never reached the SQL, "+
			"so the caller received the blend under a human label",
			fixture.Machine.Country, human)
	}
	if human[fixture.Unknown.Country] != 0 {
		t.Errorf("GET /geography?classification=human returned the NEVER-CLASSIFIED "+
			"open (country %s) as well: %v", fixture.Unknown.Country, human)
	}
	if len(human) != 1 {
		t.Errorf("human geography returned %d countries, want exactly 1: %v", len(human), human)
	}

	// A second band, so the endpoint cannot pass by hard-coding one answer.
	machine := opensByCountry("?classification=machine")
	if machine[fixture.Machine.Country] != 1 || machine[fixture.Human.Country] != 0 ||
		machine[fixture.Unknown.Country] != 0 {
		t.Errorf("machine geography = %v, want only country %s",
			machine, fixture.Machine.Country)
	}
}

// The client breakdown is the most machine-contaminated table in the product:
// Apple Mail Privacy Protection and Gmail's image proxy are user agents, so an
// unfiltered chart reports the prefetcher as the sender's most popular mail
// client. The three fixture recipients sit in three different client families
// so this asserts WHICH client survived, not merely how many did.
func TestDevicesHandlerAppliesTheClassificationBandDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	deps := &ExtendedDeps{Service: NewService(pool)}

	opensByClient := func(query string) map[string]int {
		var rows []DeviceRow
		f01HandlerJSON(t, deps, (*ExtendedDeps).Devices, fixture.TenantID, fixture.CampaignID,
			"/api/v1/campaigns/"+fixture.CampaignID+"/devices"+query, &rows)
		out := map[string]int{}
		for _, r := range rows {
			out[r.Client] = r.Opens
		}
		return out
	}

	all := opensByClient("")
	if all[fixture.Human.Client] != 1 || all[fixture.Machine.Client] != 1 ||
		all[fixture.Unknown.Client] != 1 {
		t.Fatalf("unfiltered devices = %v; the fixture did not land", all)
	}

	human := opensByClient("?classification=human")
	if human[fixture.Human.Client] != 1 {
		t.Errorf("human devices = %v; lost the human open (client %s)",
			human, fixture.Human.Client)
	}
	if human[fixture.Machine.Client] != 0 {
		t.Errorf("GET /devices?classification=human still reports the MACHINE client "+
			"%q: %v — the band never reached the SQL, and the chart names a "+
			"prefetcher as a mail client the audience uses",
			fixture.Machine.Client, human)
	}
	if human[fixture.Unknown.Client] != 0 {
		t.Errorf("GET /devices?classification=human still reports the never-classified "+
			"client %q: %v", fixture.Unknown.Client, human)
	}
	if len(human) != 1 {
		t.Errorf("human devices returned %d clients, want exactly 1: %v", len(human), human)
	}

	unknown := opensByClient("?classification=unknown")
	if unknown[fixture.Unknown.Client] != 1 || unknown[fixture.Human.Client] != 0 ||
		unknown[fixture.Machine.Client] != 0 {
		t.Errorf("unknown devices = %v, want only client %s", unknown, fixture.Unknown.Client)
	}
}

// The link report drives "which link worked". A scanner that follows every URL
// in the message clicks them all, so the unfiltered ranking is partly a report
// on the security appliance's crawl order.
func TestLinkReportHandlerAppliesTheClassificationBandDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)
	deps := &ExtendedDeps{Service: NewService(pool)}

	clicksByURL := func(query string) map[string]int {
		var rows []LinkRow
		f01HandlerJSON(t, deps, (*ExtendedDeps).LinkReport, fixture.TenantID, fixture.CampaignID,
			"/api/v1/campaigns/"+fixture.CampaignID+"/link-report"+query, &rows)
		out := map[string]int{}
		for _, r := range rows {
			out[r.URL] = r.Clicks
		}
		return out
	}

	all := clicksByURL("")
	if all[fixture.Human.Link] != 1 || all[fixture.Machine.Link] != 1 ||
		all[fixture.Unknown.Link] != 1 {
		t.Fatalf("unfiltered link report = %v; the fixture did not land", all)
	}

	human := clicksByURL("?classification=human")
	if human[fixture.Human.Link] != 1 {
		t.Errorf("human link report = %v; lost the human click on %s", human, fixture.Human.Link)
	}
	if human[fixture.Machine.Link] != 0 {
		t.Errorf("GET /link-report?classification=human still reports the MACHINE click "+
			"on %s: %v — the band never reached the SQL", fixture.Machine.Link, human)
	}
	if human[fixture.Unknown.Link] != 0 {
		t.Errorf("GET /link-report?classification=human still reports the "+
			"never-classified click on %s: %v", fixture.Unknown.Link, human)
	}
	if len(human) != 1 {
		t.Errorf("human link report returned %d links, want exactly 1: %v", len(human), human)
	}
}

// Compare is aggregate-per-campaign, so "only the human one survived" cannot be
// read off a single campaign's rates. The fixture therefore adds a SECOND
// campaign that only the machine-classified recipient interacted with: under
// ?classification=human that campaign must report a zero open rate while the
// first still reports the human opener. A handler that drops the band reports
// both campaigns as fully opened.
func TestCompareHandlerAppliesTheClassificationBandDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)

	// campaign_recipients is Compare's denominator.
	followupExec(t, pool, ctx, fixture.TenantID, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email, status)
SELECT $1::uuid, $2::uuid, e, 'sent'
  FROM unnest($3::text[]) AS e`,
		fixture.TenantID, fixture.CampaignID,
		[]string{fixture.Human.Email, fixture.Machine.Email, fixture.Unknown.Email})

	// The machine-only campaign.
	machineOnly := followupCampaign(t, pool, ctx, fixture.TenantID,
		"f01 machine only", "f01 machine only "+fixture.TenantID[:8])
	followupExec(t, pool, ctx, fixture.TenantID, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email, status)
VALUES ($1::uuid, $2::uuid, $3, 'sent')`,
		fixture.TenantID, machineOnly, fixture.Machine.Email)
	machineAt := fixture.At.Add(2 * time.Minute)
	ref := f01InsertLedgerEvent(t, pool, ctx, fixture.TenantID, machineOnly,
		fixture.Machine.Email, "opened", fixture.Machine.UA, fixture.Machine.Country, "", machineAt)
	f01Classify(t, pool, ctx, fixture.TenantID, ref, ec.Machine, fixture.Machine.UA, "opened",
		"f01-"+fixture.TenantID[:8]+"-machine-only")

	deps := &ExtendedDeps{Service: NewService(pool)}
	openersByCampaign := func(query string) map[string]int {
		var rows []CompareRow
		f01HandlerJSON(t, deps, (*ExtendedDeps).Compare, fixture.TenantID, "",
			"/api/v1/analytics/campaigns/compare?ids="+fixture.CampaignID+","+machineOnly+query,
			&rows)
		out := map[string]int{}
		for _, r := range rows {
			// OpenRate is distinct openers / total recipients; the recipient
			// counts are seeded above, so this recovers the integer numerator.
			out[r.CampaignID] = int(r.OpenRate*float64(r.TotalRecipients) + 0.5)
		}
		return out
	}

	all := openersByCampaign("")
	if all[fixture.CampaignID] != 3 || all[machineOnly] != 1 {
		t.Fatalf("unfiltered compare openers = %v; want 3 on the mixed campaign and 1 "+
			"on the machine-only campaign — the fixture did not land", all)
	}

	human := openersByCampaign("&classification=human")
	if human[fixture.CampaignID] != 1 {
		t.Errorf("human compare openers on the mixed campaign = %d, want 1: %v",
			human[fixture.CampaignID], human)
	}
	if human[machineOnly] != 0 {
		t.Errorf("GET /compare?classification=human reports %d human openers on a "+
			"campaign whose only interaction is an explicit MACHINE open: %v — the "+
			"band never reached the SQL, so a comparison that decides which campaign "+
			"won is being made on machine traffic",
			human[machineOnly], human)
	}

	machine := openersByCampaign("&classification=machine")
	if machine[machineOnly] != 1 || machine[fixture.CampaignID] != 1 {
		t.Errorf("machine compare openers = %v, want 1 on each campaign", machine)
	}
}

// groupedTimeseriesEnvelope is the GroupedTimeseries response body. It is
// declared here rather than reused from the handler because the handler builds
// it as an anonymous map: the shape a customer parses exists only as JSON, and
// a test that asserts on the Service's return value never sees the echoed
// classification_filter key at all.
type groupedTimeseriesEnvelope struct {
	Series               []TimeseriesSeries `json:"series"`
	ClassificationFilter string             `json:"classification_filter"`
}

// GroupedTimeseries is the endpoint where an unapplied band stops being a wrong
// number and becomes a false statement.
//
// Geography, Devices and the link report return bare arrays: a handler that
// accepted ?classification=human and silently returned the blend hands back
// machine rows under a label the CUSTOMER supplied, which is bad. This endpoint
// echoes `"classification_filter": filter.Wire()` in the payload, so the same
// defect makes the SERVER assert "human" over a body containing the machine and
// never-classified rows. Nothing downstream — no header, no log line, no other
// field — contradicts it, so the lie survives export, screenshot and audit.
//
// A verifier's mutation (M6) proved that shape was reachable: keep the parse,
// keep the 400 on `classification=humans`, keep the 400 on metric=bounces, keep
// the echo, and hand the Service ClassificationAll. `?classification=human`
// then returned classification_filter="human" with opens=3 — all three bands
// blended — and every test in this package still passed, because every
// band-behavioural assertion for this endpoint went through svc.GroupedTimeseries
// and the only handler-level tests were validation-only.
//
// So the assertions below are paired on purpose: each band checks the numbers
// AND the echo in the same breath. A series count alone would pass a handler
// that dropped the echo; an echo check alone is exactly what M6 satisfies.
//
// The second campaign is what makes "which rows survived" answerable rather
// than merely countable on an endpoint whose payload is integers: only the
// MACHINE recipient ever touched it, so under the human band it must vanish
// from the response entirely while the mixed campaign still reports its one
// human open. A handler that drops the band reports both campaigns at full
// volume.
func TestGroupedTimeseriesHandlerAppliesTheClassificationBandDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	fixture := seedF01Fixture(t, pool, ctx)

	// A campaign whose ONLY interaction is an explicit machine open. Both the
	// canonical ledger row (which carries the classification) and its
	// compatibility twin are written: GroupedTimeseries counts
	// campaign_report_events and correlates to the ledger for the band, so a
	// ledger-only event would be invisible to this endpoint in every band.
	machineOnly := followupCampaign(t, pool, ctx, fixture.TenantID,
		"f01 ts machine only", "f01 ts machine only "+fixture.TenantID[:8])
	machineAt := fixture.At.Add(3 * time.Minute)
	ref := f01InsertLedgerEvent(t, pool, ctx, fixture.TenantID, machineOnly,
		fixture.Machine.Email, "opened", fixture.Machine.UA, fixture.Machine.Country, "", machineAt)
	f01InsertReportEvent(t, pool, ctx, fixture.TenantID, machineOnly,
		fixture.Machine.Email, "opened", fixture.Machine.UA, "", ref.At, `{}`)
	f01Classify(t, pool, ctx, fixture.TenantID, ref, ec.Machine, fixture.Machine.UA, "opened",
		"f01-ts-"+fixture.TenantID[:8]+"-machine-only")

	deps := &ExtendedDeps{Service: NewService(pool)}

	// series drives the handler exactly as the desktop chart does and returns
	// both halves of the answer: the per-group totals and the band the server
	// says it measured.
	series := func(query string) (map[string]int, string) {
		t.Helper()
		var env groupedTimeseriesEnvelope
		f01HandlerJSON(t, deps, (*ExtendedDeps).GroupedTimeseries, fixture.TenantID, "",
			"/api/v1/analytics/timeseries?group_by=campaign&metric=opens&days=7"+query, &env)
		out := map[string]int{}
		for _, s := range env.Series {
			n := 0
			for _, p := range s.Points {
				n += p.Value
			}
			// Zero-filled buckets are the norm here; a group with no surviving
			// rows must be absent from the map, not present as 0, so that
			// "vanished from the response" is a distinguishable outcome.
			if n > 0 {
				out[s.Key] = n
			}
		}
		return out, env.ClassificationFilter
	}

	all, allEcho := series("")
	if all[fixture.CampaignID] != 3 || all[machineOnly] != 1 {
		t.Fatalf("unfiltered series = %v; want 3 opens on the mixed campaign and 1 on "+
			"the machine-only campaign — the fixture did not land, so every filtered "+
			"assertion below would be vacuous", all)
	}
	if allEcho != "all" {
		t.Fatalf("unfiltered classification_filter = %q, want \"all\"; a blank or "+
			"absent echo lets a reader mistake an unfiltered payload for a filtered "+
			"one", allEcho)
	}

	human, humanEcho := series("&classification=human")
	if humanEcho != "human" {
		t.Errorf("classification_filter = %q, want \"human\" — the payload must state "+
			"which band it measured", humanEcho)
	}
	if human[fixture.CampaignID] != 1 {
		t.Errorf("human series on the mixed campaign = %d opens, want exactly 1 "+
			"(only the HUMAN-classified recipient opened as a person): %v. 3 means "+
			"the parsed band never reached the SQL, and because this endpoint echoes "+
			"classification_filter=%q the response is not merely blended — it is a "+
			"blend the server labelled as human",
			human[fixture.CampaignID], human, humanEcho)
	}
	if _, present := human[machineOnly]; present {
		t.Errorf("GET /timeseries?classification=human returned %d opens for a campaign "+
			"whose only event is an explicit MACHINE open: %v — the band never reached "+
			"the SQL, so a chart titled \"human opens\" is drawing a bot's traffic",
			human[machineOnly], human)
	}
	if len(human) != 1 {
		t.Errorf("human series returned %d non-empty groups, want exactly 1: %v",
			len(human), human)
	}

	// A second and third band, so the endpoint cannot pass by hard-coding one
	// answer or by filtering to a fixed row.
	machine, machineEcho := series("&classification=machine")
	if machineEcho != "machine" {
		t.Errorf("classification_filter = %q, want \"machine\"", machineEcho)
	}
	if machine[fixture.CampaignID] != 1 || machine[machineOnly] != 1 {
		t.Errorf("machine series = %v, want 1 open on each campaign", machine)
	}

	unknown, unknownEcho := series("&classification=unknown")
	if unknownEcho != "unknown" {
		t.Errorf("classification_filter = %q, want \"unknown\"", unknownEcho)
	}
	if unknown[fixture.CampaignID] != 1 {
		t.Errorf("unknown series on the mixed campaign = %d, want 1 (the "+
			"never-classified recipient): %v", unknown[fixture.CampaignID], unknown)
	}
	if _, present := unknown[machineOnly]; present {
		t.Errorf("unknown series claimed %d opens on the machine-only campaign: %v — "+
			"an explicitly classified machine open was laundered into 'we do not know'",
			unknown[machineOnly], unknown)
	}

	// The bands must partition the unfiltered total, on the wire. If they do
	// not, the endpoint is either losing rows from every band or counting one
	// row twice — both invisible to a single-band assertion.
	for _, key := range []string{fixture.CampaignID, machineOnly} {
		if sum := human[key] + machine[key] + unknown[key]; sum != all[key] {
			t.Errorf("group %s: bands sum to %d opens but the unfiltered total is %d",
				key, sum, all[key])
		}
	}

	// metric=clicks is the endpoint's other banded metric and takes a different
	// event_type through the same predicate; the fixture gives each recipient
	// exactly one click.
	clicks := func(query string) (map[string]int, string) {
		t.Helper()
		var env groupedTimeseriesEnvelope
		f01HandlerJSON(t, deps, (*ExtendedDeps).GroupedTimeseries, fixture.TenantID, "",
			"/api/v1/analytics/timeseries?group_by=campaign&metric=clicks&days=7"+query, &env)
		out := map[string]int{}
		for _, s := range env.Series {
			n := 0
			for _, p := range s.Points {
				n += p.Value
			}
			if n > 0 {
				out[s.Key] = n
			}
		}
		return out, env.ClassificationFilter
	}
	allClicks, _ := clicks("")
	if allClicks[fixture.CampaignID] != 3 {
		t.Fatalf("unfiltered clicks = %v, want 3 on the mixed campaign", allClicks)
	}
	humanClicks, humanClicksEcho := clicks("&classification=human")
	if humanClicks[fixture.CampaignID] != 1 || humanClicksEcho != "human" {
		t.Errorf("human clicks = %v (echo %q), want 1 on the mixed campaign under "+
			"\"human\" — the band is applied to opens but not to clicks",
			humanClicks, humanClicksEcho)
	}

	// group_by=domain is the endpoint's other whitelisted dimension. It swaps
	// the SELECT key expression, and the band predicate is appended to the same
	// WHERE clause — a dimension-specific query built without it would be
	// invisible to every assertion above.
	byDomain := func(query string) (map[string]int, string) {
		t.Helper()
		var env groupedTimeseriesEnvelope
		f01HandlerJSON(t, deps, (*ExtendedDeps).GroupedTimeseries, fixture.TenantID, "",
			"/api/v1/analytics/timeseries?group_by=domain&metric=opens&days=7"+query, &env)
		out := map[string]int{}
		for _, s := range env.Series {
			n := 0
			for _, p := range s.Points {
				n += p.Value
			}
			if n > 0 {
				out[s.Key] = n
			}
		}
		return out, env.ClassificationFilter
	}
	// All four fixture opens land on the same recipient domain, so the domain
	// view is the whole tenant's volume in one group.
	const fixtureDomain = "example.test"
	allDomains, _ := byDomain("")
	if allDomains[fixtureDomain] != 4 {
		t.Fatalf("unfiltered domain series = %v, want 4 opens on %s", allDomains, fixtureDomain)
	}
	humanDomains, humanDomainEcho := byDomain("&classification=human")
	if humanDomains[fixtureDomain] != 1 || humanDomainEcho != "human" {
		t.Errorf("human domain series = %v (echo %q), want 1 open on %s — group_by=domain "+
			"builds its own key expression and lost the band",
			humanDomains, humanDomainEcho, fixtureDomain)
	}
}

// ----------------------------------------------------------------------
// DEFECT 2 — the campaign_report_events bridge, proven behaviourally.
// ----------------------------------------------------------------------

// campaign_report_events carries no foreign key to the classified ledger, so
// the band correlates on the identity both writers derive from the same
// canonical event: (tenant, campaign, recipient, event type, timestamp). Two
// properties have to hold, and neither is observable from the SQL text:
//
//  1. THE IDENTITY IS COMPLETE. Drop the recipient from the key and two
//     different people's simultaneous opens become interchangeable: one
//     person's HUMAN decision starts vouching for the other's unclassified
//     open. Drop the timestamp and one person's two opens merge, so a single
//     human open launders every later machine open by the same address.
//
//  2. IT IS A SEMI-JOIN. The ledger has no uniqueness constraint on that
//     identity — a replayed or re-ingested event legitimately produces two
//     rows with the same tuple. Under EXISTS the report row is counted once.
//     Under a join it is counted once per ledger twin, and the human count
//     exceeds the number of events that exist.
//
// The fixture builds exactly those collisions, so each assertion below fails
// under the corresponding wrong implementation rather than under none of them.
func TestCampaignReportBridgeDoesNotBleedAcrossCollidingEventsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "f01 bridge", "f01 bridge "+tenantID[:8])
	suffix := tenantID[:8]
	alice := "bridge-alice-" + suffix + "@example.test"
	bob := "bridge-bob-" + suffix + "@example.test"

	// Both timestamps sit inside today's bucket window and inside the live
	// partition. atEarly is shared by alice and bob ON PURPOSE.
	atEarly := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Microsecond)
	atLate := time.Now().UTC().Add(-1 * time.Hour).Truncate(time.Microsecond)

	humanUA := "Mozilla/5.0 (Macintosh) BridgeReader/1.0"

	// (1) alice opened at atEarly — classified HUMAN.
	aliceEarly := f01InsertLedgerEvent(t, pool, ctx, tenantID, campaignID,
		alice, "opened", humanUA, "SE", "", atEarly)
	f01Classify(t, pool, ctx, tenantID, aliceEarly, ec.Human, humanUA, "opened",
		"bridge-"+suffix+"-alice-early")

	// (2) THE SEMI-JOIN COLLISION: a second ledger row with the SAME identity
	//     tuple as (1), also classified human. One report row, two ledger twins.
	aliceEarlyReplay := f01InsertLedgerEvent(t, pool, ctx, tenantID, campaignID,
		alice, "opened", humanUA, "SE", "", atEarly)
	if aliceEarlyReplay.ID == aliceEarly.ID {
		t.Fatal("the replayed ledger event reused the original id; there is no " +
			"duplicate for the semi-join assertion to be about")
	}
	f01Classify(t, pool, ctx, tenantID, aliceEarlyReplay, ec.Human, humanUA, "opened",
		"bridge-"+suffix+"-alice-early-replay")

	// (3) THE RECIPIENT COLLISION: bob opened at the SAME timestamp as alice,
	//     and was never classified.
	bobEarly := f01InsertLedgerEvent(t, pool, ctx, tenantID, campaignID,
		bob, "opened", "Mozilla/5.0 (Windows) BridgeUnknown/9.9", "NO", "", atEarly)
	if !bobEarly.At.Equal(aliceEarly.At) {
		t.Fatalf("bob's open landed at %s and alice's at %s; without the timestamp "+
			"collision this test cannot detect a partial join key",
			bobEarly.At, aliceEarly.At)
	}

	// (4) THE TIMESTAMP COLLISION: alice opened again, later — classified MACHINE.
	aliceLate := f01InsertLedgerEvent(t, pool, ctx, tenantID, campaignID,
		alice, "opened", f01ProbeUA, "SE", "", atLate)
	f01Classify(t, pool, ctx, tenantID, aliceLate, ec.Machine, f01ProbeUA, "opened",
		"bridge-"+suffix+"-alice-late")

	// The compatibility model gets exactly THREE open rows — one per real event.
	// The replay in (2) is a ledger-side duplicate only, which is what makes the
	// join-versus-semi-join difference observable.
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, alice, "opened", humanUA, "", atEarly, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, bob, "opened",
		"Mozilla/5.0 (Windows) BridgeUnknown/9.9", "", atEarly, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, alice, "opened", f01ProbeUA, "", atLate, `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, alice, "delivered", humanUA, "",
		atEarly.Add(-time.Minute), `{}`)
	f01InsertReportEvent(t, pool, ctx, tenantID, campaignID, bob, "delivered",
		"Mozilla/5.0 (Windows) BridgeUnknown/9.9", "", atEarly.Add(-time.Minute), `{}`)

	// Guard the fixture: the duplicate ledger twin must genuinely exist, or the
	// semi-join assertion is an assertion about nothing.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var twins, reportOpens int
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*)::int FROM subscriber_events
         WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
           AND subscriber_email = $3 AND event_type = 'opened' AND at = $4),
       (SELECT count(*)::int FROM campaign_report_events
         WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND event_type = 'opened')`,
		tenantID, campaignID, alice, atEarly).Scan(&twins, &reportOpens); err != nil {
		t.Fatalf("fixture guard: %v", err)
	}
	if twins != 2 {
		t.Fatalf("alice has %d ledger rows at the shared timestamp, want 2; the "+
			"semi-join assertion below would prove nothing", twins)
	}
	if reportOpens != 3 {
		t.Fatalf("campaign_report_events holds %d opens, want 3", reportOpens)
	}

	svc := NewService(pool)

	// GroupedTimeseries counts ROWS (count(*)), which is the only place a
	// multiplying join is visible; the engagement panel counts distinct
	// recipients and would hide it.
	opens := func(filter ClassificationFilter) int {
		series, err := svc.GroupedTimeseries(ctx, tenantID, "campaign", "opens", 7, filter)
		if err != nil {
			t.Fatalf("GroupedTimeseries(%q): %v", filter, err)
		}
		n := 0
		for _, s := range series {
			if s.Key != campaignID {
				continue
			}
			for _, p := range s.Points {
				n += p.Value
			}
		}
		return n
	}

	if got := opens(ClassificationAll); got != 3 {
		t.Fatalf("unfiltered opens = %d, want the 3 compatibility rows; the fixture "+
			"did not land", got)
	}

	if got := opens(ClassificationHuman); got != 1 {
		t.Errorf("human band counted %d opens, want exactly 1 (alice's open at the "+
			"shared timestamp). 2 means the bridge is wrong in one of three ways: "+
			"it dropped the recipient (bob's simultaneous open inherited alice's "+
			"human decision), it dropped the timestamp (alice's later MACHINE open "+
			"inherited it), or it is a multiplying join (one report row counted "+
			"once per ledger twin)", got)
	}
	if got := opens(ClassificationMachine); got != 1 {
		t.Errorf("machine band counted %d opens, want exactly 1 (alice's later open)", got)
	}
	if got := opens(ClassificationUnknown); got != 1 {
		t.Errorf("unknown band counted %d opens, want exactly 1 (bob's never-classified "+
			"open). 0 means bob's report row matched alice's HUMAN ledger row and was "+
			"excluded from every band, so the bands stopped summing to the total", got)
	}
	if sum := opens(ClassificationHuman) + opens(ClassificationMachine) +
		opens(ClassificationUnknown); sum != opens(ClassificationAll) {
		t.Errorf("bands sum to %d opens, unfiltered total is %d — the bridge either "+
			"loses rows or double-counts them", sum, opens(ClassificationAll))
	}

	// The distinct-recipient view of the same collision, through the panel that
	// customers actually read.
	panelOpens := func(filter ClassificationFilter) float64 {
		p, err := svc.EngagementPanel(ctx, tenantID, campaignID, false, filter)
		if err != nil {
			t.Fatalf("EngagementPanel(%q): %v", filter, err)
		}
		if p.Delivered != 2 {
			t.Fatalf("%q band delivered = %d, want 2", filter, p.Delivered)
		}
		return p.RawOpenRate * float64(p.Delivered)
	}
	if got := panelOpens(ClassificationAll); got != 2 {
		t.Fatalf("unfiltered panel unique openers = %v, want 2", got)
	}
	if got := panelOpens(ClassificationHuman); got != 1 {
		t.Errorf("human panel unique openers = %v, want 1 (alice only); 2 means bob's "+
			"simultaneous open was matched to alice's human decision", got)
	}
	if got := panelOpens(ClassificationUnknown); got != 1 {
		t.Errorf("unknown panel unique openers = %v, want 1 (bob only)", got)
	}
}

// ----------------------------------------------------------------------
// DEFECT 3 — the enumeration itself. Two rounds of this defect were closed
// endpoint-by-endpoint against a list somebody read off by hand, and both
// times the list was short.
// ----------------------------------------------------------------------

// f01BandHandlerCoverage is the closed enumeration of *ExtendedDeps handlers
// that accept ?classification=, mapped to the test that proves the parsed band
// reaches the SQL through the HTTP layer.
//
// WHAT THIS MAP IS NOT: it is not the guard. The guard for each endpoint is the
// named test, which seeds a human-classified and a machine-classified
// interaction against a live database and asserts which one comes back. Naming
// a test here proves nothing about that test's contents.
//
// WHAT THIS MAP IS FOR: completeness. The two failed rounds of this defect were
// not wrong about any endpoint they looked at — they were wrong about which
// endpoints existed. A hand-maintained list in a comment cannot fail;
// TestEveryClassificationHandlerHasABehaviouralHandlerTest reads the same fact
// out of the source and fails when they disagree, so a seventh handler that
// starts calling classificationFilterFromRequest cannot ship with only a
// validation test the way GroupedTimeseries did.
//
// The paired validation-only tests (an unsupported value must 400 before any DB
// work) live in classification_filter_test.go and are deliberately NOT what is
// recorded here: passing validation while ignoring the band is precisely the
// mutant this map exists to keep uncoverable.
var f01BandHandlerCoverage = map[string]string{
	// GET /api/v1/campaigns/{id}/engagement
	"EngagementPanel": "TestEngagementPanelHandlerAppliesTheQueryParameterDB",
	// GET /api/v1/analytics/timeseries
	"GroupedTimeseries": "TestGroupedTimeseriesHandlerAppliesTheClassificationBandDB",
	// GET /api/v1/campaigns/{id}/link-report
	"LinkReport": "TestLinkReportHandlerAppliesTheClassificationBandDB",
	// GET /api/v1/analytics/campaigns/compare
	"Compare": "TestCompareHandlerAppliesTheClassificationBandDB",
	// GET /api/v1/campaigns/{id}/geography
	"Geography": "TestGeographyHandlerAppliesTheClassificationBandDB",
	// GET /api/v1/campaigns/{id}/devices
	"Devices": "TestDevicesHandlerAppliesTheClassificationBandDB",
}

// f01ParsePackage parses the package's Go source, splitting production files
// from test files. Reading the AST rather than grepping is what makes the
// enumeration robust: a call inside a comment, a string literal or a
// commented-out handler cannot fake coverage, and a renamed handler is a
// failure rather than a silent gap.
func f01ParsePackage(t *testing.T) (prod, tests []*ast.File) {
	t.Helper()
	// Parse every .go file in the directory and keep those declaring package
	// analytics (external _test packages are skipped the way ParseDir grouped
	// them). Build tags are deliberately ignored: a handler behind a tag still
	// accepts the band and must still be enumerated.
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	fset := token.NewFileSet()
	packagesSeen := map[string]struct{}{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse package source %s: %v", name, err)
		}
		packagesSeen[file.Name.Name] = struct{}{}
		if file.Name.Name != "analytics" {
			continue
		}
		if strings.HasSuffix(name, "_test.go") {
			tests = append(tests, file)
			continue
		}
		prod = append(prod, file)
	}
	if _, ok := packagesSeen["analytics"]; !ok {
		t.Fatalf("package analytics not found in the parsed directory (found %d packages)",
			len(packagesSeen))
	}
	if len(prod) == 0 {
		t.Fatal("parsed no non-test files; the enumeration below would be vacuously empty")
	}
	return prod, tests
}

// f01HandlersAcceptingTheBand returns the names of every method — on ANY
// receiver — whose body calls classificationFilterFromRequest, i.e. every
// handler that accepts ?classification= from a customer.
//
// Receiver-agnostic ON PURPOSE. This guard first inspected only *ExtendedDeps,
// which is the receiver the handlers happened to live on when it was written.
// The package has at least three others that host mounted routes — *Deps,
// *StreamDeps, *LiveDeps — so a handler added to any of them could start
// accepting the band and this enumeration would stay silent about it.
//
// That is the same mistake one level up: the endpoint gap this file exists to
// close was itself found because the previous round fixed the four handlers a
// verifier happened to NAME rather than sweeping the class. A guard that pins
// the class must not itself be scoped to today's instances.
func f01HandlersAcceptingTheBand(t *testing.T, prod []*ast.File) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, file := range prod {
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || len(fn.Recv.List) != 1 || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if id, ok := call.Fun.(*ast.Ident); ok &&
					id.Name == "classificationFilterFromRequest" {
					out[fn.Name.Name] = true
				}
				return true
			})
		}
	}
	return out
}

// TestEveryClassificationHandlerHasABehaviouralHandlerTest is the guard on the
// enumeration.
//
// It answers exactly one question — "is any handler that accepts the parameter
// missing from f01BandHandlerCoverage?" — because that is the question both
// previous rounds got wrong. It does not, and cannot, judge whether the named
// tests assert anything; that is what the mutation exercise on each of them is
// for.
func TestEveryClassificationHandlerHasABehaviouralHandlerTest(t *testing.T) {
	prod, testFiles := f01ParsePackage(t)
	handlers := f01HandlersAcceptingTheBand(t, prod)

	// Guard the guard: if the AST walk found nothing, an empty result would
	// agree with any coverage map at all and this test would pass forever.
	if len(handlers) == 0 {
		t.Fatal("found no *ExtendedDeps handler calling classificationFilterFromRequest; " +
			"the detector is broken, and a broken detector reports full coverage")
	}

	var missing, stale []string
	for name := range handlers {
		if f01BandHandlerCoverage[name] == "" {
			missing = append(missing, name)
		}
	}
	for name := range f01BandHandlerCoverage {
		if !handlers[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)

	if len(missing) > 0 {
		t.Errorf("these handlers accept ?classification= but are absent from "+
			"f01BandHandlerCoverage: %v.\nEach needs a DB-backed test that drives the "+
			"HANDLER with ?classification=human and asserts that only the "+
			"human-classified interaction comes back. A validation-only test (400 on a "+
			"bad value) does NOT cover this: a handler that parses the parameter, "+
			"rejects garbage and then passes ClassificationAll to the Service passes "+
			"every validation test while returning the blend under a human label.",
			missing)
	}
	if len(stale) > 0 {
		t.Errorf("f01BandHandlerCoverage names handlers that no longer accept "+
			"?classification=: %v. Either they were renamed — in which case the test "+
			"named here is now guarding nothing — or the parameter was dropped from an "+
			"endpoint that still advertises it.", stale)
	}

	// Every named test must exist. This is bookkeeping, not a behavioural
	// assertion: it only catches a coverage entry that points at a test which
	// was renamed or deleted, which would otherwise leave a green row in the
	// enumeration with nothing behind it.
	declared := map[string]bool{}
	for _, file := range testFiles {
		for _, decl := range file.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil {
				declared[fn.Name.Name] = true
			}
		}
	}
	for handler, testName := range f01BandHandlerCoverage {
		if !declared[testName] {
			t.Errorf("f01BandHandlerCoverage[%q] names %s, which does not exist in this "+
				"package — the enumeration claims coverage that was renamed or deleted",
				handler, testName)
		}
	}
}
