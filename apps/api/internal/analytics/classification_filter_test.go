// SPDX-License-Identifier: AGPL-3.0-only
//
// classification_filter_test.go — pure tests for the F01 band parser and the
// SQL fragments it emits. No database: these pin the parsing contract and the
// shape of the generated predicate. The BEHAVIOUR (that the predicate actually
// changes which rows are counted) is proven against live Postgres in
// classification_filter_db_test.go — a shape test alone would pass against a
// predicate that is generated and then never used.
package analytics

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

func TestParseClassificationFilter(t *testing.T) {
	cases := []struct {
		raw     string
		want    ClassificationFilter
		wantErr bool
	}{
		{"", ClassificationAll, false},
		{"   ", ClassificationAll, false},
		{"human", ClassificationHuman, false},
		{"HUMAN", ClassificationHuman, false},
		{" Machine ", ClassificationMachine, false},
		{"unknown", ClassificationUnknown, false},
		// Rejected, never silently downgraded to the blend: a caller who
		// believes they filtered and did not is worse off than one who never
		// asked.
		{"humans", ClassificationAll, true},
		{"bot", ClassificationAll, true},
		{"all", ClassificationAll, true},
		{"null", ClassificationAll, true},
	}
	for _, tc := range cases {
		got, err := ParseClassificationFilter(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseClassificationFilter(%q) = %q, want error", tc.raw, got)
			} else if !errors.Is(err, ErrUnsupportedClassification) {
				t.Errorf("ParseClassificationFilter(%q) err = %v, want ErrUnsupportedClassification", tc.raw, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseClassificationFilter(%q): %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseClassificationFilter(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// The unset filter must emit NOTHING. This is the structural half of "unset
// keeps today's numbers": if the fragment is empty, the query string handed to
// Postgres is byte-identical to the one that shipped before this feature.
func TestUnsetClassificationEmitsNoSQL(t *testing.T) {
	for _, got := range []string{
		ClassificationAll.subscriberEventExpr("se"),
		ClassificationAll.campaignReportEventExpr("cre"),
		andWhere(ClassificationAll.subscriberEventExpr("se")),
		interactionOnly("se", ClassificationAll.subscriberEventExpr("se")),
	} {
		if got != "" {
			t.Errorf("unset filter emitted SQL %q; the default query text must be unchanged", got)
		}
	}
	if got := ClassificationAll.Wire(); got != "all" {
		t.Errorf("unset Wire() = %q, want \"all\" — a blank value is indistinguishable from a missing key", got)
	}
}

// The unknown band must be a NEGATION. EXISTS(classification = 'unknown') would
// silently drop every event that has no decision row at all — exactly the rows
// that predate the classifier — and those rows would then be missing from all
// three bands instead of appearing in the honest one.
func TestUnknownBandIsANegationSoUnclassifiedRowsCannotEscape(t *testing.T) {
	for name, expr := range map[string]string{
		"subscriber_events":      ClassificationUnknown.subscriberEventExpr("se"),
		"campaign_report_events": ClassificationUnknown.campaignReportEventExpr("cre"),
	} {
		if !strings.HasPrefix(expr, "NOT EXISTS (") {
			t.Errorf("%s unknown band = %q; want a NOT EXISTS negation", name, expr)
		}
		if !strings.Contains(expr, "IN ('human','machine')") {
			t.Errorf("%s unknown band %q does not exclude both settled bands", name, expr)
		}
		if strings.Contains(expr, "= 'unknown'") {
			t.Errorf("%s unknown band %q tests for an explicit 'unknown' row; "+
				"never-classified events have no row and would be lost", name, expr)
		}
	}
}

// The three bands must partition the space. If human and machine were not
// mutually exclusive with unknown, the bands could double-count or lose rows
// and no arithmetic check downstream would notice.
func TestBandsAreMutuallyExclusiveByConstruction(t *testing.T) {
	human := ClassificationHuman.subscriberEventExpr("se")
	machine := ClassificationMachine.subscriberEventExpr("se")
	unknown := ClassificationUnknown.subscriberEventExpr("se")
	if !strings.Contains(human, "= 'human'") || strings.Contains(human, "machine") {
		t.Errorf("human band = %q", human)
	}
	if !strings.Contains(machine, "= 'machine'") || strings.Contains(machine, "'human'") {
		t.Errorf("machine band = %q", machine)
	}
	if human == machine || machine == unknown || human == unknown {
		t.Fatal("two bands generate identical SQL; one of them cannot be answering its question")
	}
}

// The campaign_report_events bridge — that it correlates on the FULL event
// identity and is a semi-join rather than a multiplying join — is proven
// behaviourally against live Postgres in
// TestCampaignReportBridgeDoesNotBleedAcrossCollidingEventsDB.
//
// It used to be checked here, with strings.Contains over the generated SQL.
// That catches deletion of an identity term and nothing else: it passes
// against a bridge whose terms are all present and whose predicate is never
// applied, and it cannot tell a correct join key from a wrong one. A guard
// that survives `if false &&` is not a guard.

// interactionOnly is what stops a band from zeroing a denominator.
func TestInteractionOnlyLeavesUnclassifiableEventTypesAlone(t *testing.T) {
	got := interactionOnly("cre", ClassificationHuman.campaignReportEventExpr("cre"))
	if !strings.HasPrefix(got, "cre.event_type NOT IN ('opened','clicked','replied') OR (") {
		t.Fatalf("interactionOnly = %q; deliveries and bounces must pass through unfiltered", got)
	}
	if interactionOnly("cre", "") != "" {
		t.Error("interactionOnly must stay empty for the unset filter")
	}
}

// The reply mapping must SELECT among the shared internal/replies constants,
// never restate them. A sixth hand-written copy of "which reply is engagement"
// is a sixth chance to write it five times correctly.
func TestRepliesPredicateReusesTheSharedConstants(t *testing.T) {
	// Unset does NOT emit nothing here, unlike the opens/clicks predicates, and
	// the asymmetry is the decision this test exists to pin.
	//
	// The panel reports ONE reply figure with no unclassified bucket beside it,
	// so the two obvious defaults are each wrong in an opposite direction: the
	// empty string counts out-of-office notices as engagement (and this figure
	// feeds AISurfacingScore, where ReplyRate is weighted 0.5), while the
	// human-only predicate excludes NULL and would delete every pre-classifier
	// reply from every historical report. The default therefore excludes what is
	// KNOWN machine and retains what was never classified.
	if got := ClassificationAll.repliesPredicate(); got != replies.NotKnownMachinePredicate {
		t.Errorf("unset replies predicate = %q, want replies.NotKnownMachinePredicate", got)
	}
	// The two endpoints it must NOT be, named explicitly so a future edit toward
	// either one fails here rather than silently moving a customer's numbers.
	if got := ClassificationAll.repliesPredicate(); got == "" {
		t.Error("unset counts every reply, including known auto-replies and " +
			"out-of-office notices")
	}
	if got := ClassificationAll.repliesPredicate(); got == replies.HumanEngagementPredicate {
		t.Error("unset excludes NULL, so every pre-classifier reply disappears " +
			"from historical reports")
	}
	// The retained-NULL half of the rule, asserted rather than assumed.
	if !strings.Contains(replies.NotKnownMachinePredicate, "IS NULL") {
		t.Error("the default reply predicate drops unclassified replies")
	}
	if got := ClassificationHuman.repliesPredicate(); got != replies.HumanEngagementPredicate {
		t.Errorf("human replies predicate = %q", got)
	}
	if got := ClassificationMachine.repliesPredicate(); got != replies.ExcludedPredicate {
		t.Errorf("machine replies predicate = %q", got)
	}
	if got := ClassificationUnknown.repliesPredicate(); got != replies.UnclassifiedPredicate {
		t.Errorf("unknown replies predicate = %q", got)
	}
	// NULL must not reach the human bucket through this door either.
	if strings.Contains(replies.HumanEngagementPredicate, "IS NULL") {
		t.Error("the human reply predicate admits NULL classifications")
	}
}

// mustSQLAlias is the reason "can request data reach this concatenation" is
// answerable in five lines.
func TestClassificationAliasRejectsAnythingButAnIdentifier(t *testing.T) {
	for _, bad := range []string{"se; drop table campaigns", "SE", "", "1se", "se-1", "se "} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("alias %q was accepted", bad)
				}
			}()
			_ = ClassificationHuman.subscriberEventExpr(bad)
		}()
	}
}

// ---------------------------------------------------------------------
// Handler-level validation (no DB: rejection happens before the Service)
// ---------------------------------------------------------------------

// classificationHandlerRequest drives one handler with a Service whose pool is
// nil ON PURPOSE: every rejection asserted below must happen before any
// database work, so a handler that reaches the pool has already failed.
//
// The recover is load-bearing. Without it the regression signal for "the
// validation is gone" is a nil-pointer panic, which aborts the whole test
// binary and blames runtime internals rather than the handler — a crash is not
// an assertion. Converting it into a named failure, and then still asserting
// the status and the error code below, is what makes these tests tests.
func classificationHandlerRequest(t *testing.T, path string, call func(*ExtendedDeps, http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	d := &ExtendedDeps{Service: &Service{}}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000001",
	}))
	rec := httptest.NewRecorder()
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("GET %s reached the database instead of rejecting the request "+
					"up front (panic: %v) — the validation that must run before any "+
					"query is gone", path, r)
			}
		}()
		call(d, rec, req)
	}()
	return rec
}

func TestHandlersRejectAnUnknownClassificationValue(t *testing.T) {
	cases := map[string]struct {
		path string
		call func(*ExtendedDeps, http.ResponseWriter, *http.Request)
	}{
		"engagement": {"/api/v1/campaigns/x/engagement?classification=humans",
			(*ExtendedDeps).EngagementPanel},
		"timeseries": {"/api/v1/analytics/timeseries?group_by=campaign&classification=humans",
			(*ExtendedDeps).GroupedTimeseries},
		"geography": {"/api/v1/campaigns/x/geography?classification=robot",
			(*ExtendedDeps).Geography},
		"devices": {"/api/v1/campaigns/x/devices?classification=robot",
			(*ExtendedDeps).Devices},
		"link report": {"/api/v1/campaigns/x/link-report?classification=robot",
			(*ExtendedDeps).LinkReport},
		"compare": {"/api/v1/analytics/campaigns/compare?ids=x&classification=robot",
			(*ExtendedDeps).Compare},
	}
	for name, tc := range cases {
		rec := classificationHandlerRequest(t, tc.path, tc.call)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (body=%s)", name, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), "bad_classification") {
			t.Errorf("%s: body = %s, want bad_classification", name, rec.Body.String())
		}
	}
}

// Bounces carry no engagement classification. Answering with an empty series
// would be read as "this campaign had no bounces", which is a worse lie than
// the blend.
func TestGroupedTimeseriesRefusesAClassificationBandForBounces(t *testing.T) {
	rec := classificationHandlerRequest(t,
		"/api/v1/analytics/timeseries?group_by=campaign&metric=bounces&classification=human",
		(*ExtendedDeps).GroupedTimeseries)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "classification_not_applicable") {
		t.Fatalf("body = %s, want classification_not_applicable", rec.Body.String())
	}
}

// The panel must always say what it measured.
func TestComputeEngagementPanelEchoesTheBand(t *testing.T) {
	for filter, want := range map[ClassificationFilter]string{
		ClassificationAll:     "all",
		ClassificationHuman:   "human",
		ClassificationMachine: "machine",
		ClassificationUnknown: "unknown",
	} {
		got := computeEngagementPanel(engagementInputs{
			CampaignID: "c", Classification: filter, Delivered: 10, RawUniqueOpens: 4,
		})
		if got.ClassificationFilter != want {
			t.Errorf("panel filter for %q = %q, want %q", filter, got.ClassificationFilter, want)
		}
		// The band must never touch the arithmetic.
		if got.RawOpenRate != 0.4 {
			t.Errorf("band %q changed the raw open rate to %v", filter, got.RawOpenRate)
		}
	}
}
