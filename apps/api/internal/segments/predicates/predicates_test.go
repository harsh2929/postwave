package predicates

import (
	"strings"
	"testing"
)

func TestCompileAggregateCountWindow(t *testing.T) {
	frag, err := CompileAggregate(AggregateInput{
		EventName:         "Placed Order",
		Aggregation:       "count",
		WindowDays:        90,
		Comparator:        "gte",
		Value:             3,
		PlaceholderOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag.SQL, "count(*)") {
		t.Fatalf("expected count(*) in: %s", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "occurred_at >= now()") {
		t.Fatalf("expected window clause in: %s", frag.SQL)
	}
	if len(frag.Args) != 3 || frag.Args[0] != "Placed Order" || frag.Args[1] != 90 || frag.Args[2] != 3 {
		t.Fatalf("args = %#v", frag.Args)
	}
}

func TestCompileAggregateSumProperty(t *testing.T) {
	frag, err := CompileAggregate(AggregateInput{
		EventName:         "Placed Order",
		Aggregation:       "sum",
		PropertyPath:      "total",
		Comparator:        "gt",
		Value:             10000,
		PlaceholderOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag.SQL, "sum(NULLIF(properties#>>'{total}','')::numeric)") {
		t.Fatalf("expected sum(property) extract: %s", frag.SQL)
	}
}

func TestCompileAggregateRejectsUnknownAggregation(t *testing.T) {
	if _, err := CompileAggregate(AggregateInput{EventName: "x", Aggregation: "median", Comparator: "gt", Value: 0}); err == nil {
		t.Fatal("expected error for unknown aggregation")
	}
}

// TestCompileAggregateScopesBySubscriberID is the SUB-028 regression
// guard: product_events has NO subscriber_email column (it is keyed by
// subscriber_id → subscribers.id). The fragment must correlate by
// subscriber_id, never subscriber_email, or it fails at runtime.
func TestCompileAggregateScopesBySubscriberID(t *testing.T) {
	frag, err := CompileAggregate(AggregateInput{
		EventName:         "Placed Order",
		Aggregation:       "count",
		Comparator:        "gte",
		Value:             1,
		PlaceholderOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(frag.SQL, "subscriber_email") {
		t.Fatalf("fragment must NOT reference the nonexistent subscriber_email column: %s", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "subscriber_id = subscribers.id") {
		t.Fatalf("fragment must correlate by subscriber_id: %s", frag.SQL)
	}
}

func TestCompileChannelConsentEmailTrue(t *testing.T) {
	frag, err := CompileChannelConsent(ChannelConsentInput{Channel: "email", CanReceive: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"subscribers.consent_email_marketing_at IS NOT NULL",
		"FROM subscriber_emails AS channel_email",
		"channel_email.tenant_id = subscribers.tenant_id",
		"channel_email.subscriber_id = subscribers.id",
		"lower(channel_email.email::text) = lower(subscribers.email::text)",
		"channel_email.consent_status = 'subscribed'",
		"channel_email.suppressed = false",
	} {
		if !strings.Contains(frag.SQL, required) {
			t.Fatalf("email gate missing %q: %s", required, frag.SQL)
		}
	}
}

func TestCompileChannelConsentEmailFalseNegatesWholeEligibilityInvariant(t *testing.T) {
	frag, err := CompileChannelConsent(ChannelConsentInput{Channel: "email", CanReceive: false})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag.SQL, "NOT (") || !strings.Contains(frag.SQL, "subscriber_emails") {
		t.Fatalf("cannot-receive gate must negate the combined projection: %s", frag.SQL)
	}
}

func TestCompileChannelConsentPushIsExplicitFalse(t *testing.T) {
	frag, err := CompileChannelConsent(ChannelConsentInput{Channel: "push", CanReceive: true})
	if err != nil {
		t.Fatal(err)
	}
	if frag.SQL != "FALSE" {
		t.Fatalf("push without writer must return FALSE; got %q", frag.SQL)
	}
}

func TestCompileLocationRadiusZipMode(t *testing.T) {
	frag, err := CompileLocationRadius(LocationRadiusInput{Mode: "zip", Zip: "94110", PlaceholderOffset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag.SQL, "subscribers.custom_fields->>'zip'") {
		t.Fatalf("frag = %s", frag.SQL)
	}
	if len(frag.Args) != 1 || frag.Args[0] != "94110" {
		t.Fatalf("args = %#v", frag.Args)
	}
}

func TestCompileLocationRadiusLatLong(t *testing.T) {
	frag, err := CompileLocationRadius(LocationRadiusInput{
		Mode: "lat_long", Latitude: 37.77, Longitude: -122.41, RadiusMiles: 25, PlaceholderOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag.SQL, "haversine") && !strings.Contains(frag.SQL, "asin") {
		t.Fatalf("frag = %s", frag.SQL)
	}
	if len(frag.Args) != 3 {
		t.Fatalf("args = %#v", frag.Args)
	}
}

func TestCompileFunnelDidThenDidNot(t *testing.T) {
	frag, err := CompileFunnel(FunnelInput{
		Steps: []FunnelStep{
			{EventName: "Added to Cart", Mode: "did"},
			{EventName: "Placed Order", Mode: "did_not"},
		},
		PlaceholderOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag.SQL, "EXISTS") || !strings.Contains(frag.SQL, "NOT EXISTS") {
		t.Fatalf("expected EXISTS + NOT EXISTS in funnel: %s", frag.SQL)
	}
	if len(frag.Args) != 2 {
		t.Fatalf("args = %#v", frag.Args)
	}
}

func TestCompileFunnelRejectsExcessSteps(t *testing.T) {
	steps := make([]FunnelStep, MaxFunnelSteps+1)
	for i := range steps {
		steps[i] = FunnelStep{EventName: "X", Mode: "did"}
	}
	if _, err := CompileFunnel(FunnelInput{Steps: steps}); err == nil {
		t.Fatal("expected error for over-deep funnel")
	}
}

func TestCompileComposableInSegment(t *testing.T) {
	frag, err := CompileComposable(ComposableInput{
		SegmentID:         "00000000-0000-0000-0000-000000000001",
		Mode:              "in_segment",
		InnerSQL:          "subscribers.status = $1",
		InnerArgs:         []any{"subscribed"},
		PlaceholderOffset: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag.SQL, "EXISTS") {
		t.Fatalf("frag = %s", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "subscribers.status = $1") {
		t.Fatalf("expected executable placeholder at $1: %s", frag.SQL)
	}
	if len(frag.Args) != 1 || frag.Args[0] != "subscribed" {
		t.Fatalf("args = %#v", frag.Args)
	}
}

func TestCompileComposableNotInSegment(t *testing.T) {
	frag, err := CompileComposable(ComposableInput{
		SegmentID: "00000000-0000-0000-0000-000000000001",
		Mode:      "not_in_segment",
		InnerSQL:  "TRUE",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag.SQL, "NOT EXISTS") {
		t.Fatalf("frag = %s", frag.SQL)
	}
}

func TestPredictiveAllCoversCanonicalKeys(t *testing.T) {
	all := All()
	if len(all) < 5 {
		t.Fatalf("expected >=5 predictive keys, got %d", len(all))
	}
	want := map[string]bool{
		string(PredictivePredictedCLV): false,
		string(PredictiveChurnRisk):    false,
		string(RFMSegmentKey):          false,
	}
	for _, k := range all {
		if _, ok := want[string(k)]; ok {
			want[string(k)] = true
		}
	}
	for k, ok := range want {
		if !ok {
			t.Errorf("missing canonical key %s", k)
		}
	}
}

// EventSlug is the key form the predicate registry gives a tracked event.
func TestEventSlug(t *testing.T) {
	cases := map[string]string{
		"Viewed Product":    "viewed_product",
		"  $Placed-Order! ": "placed_order",
		"order.placed":      "order_placed",
		"Café Visit":        "caf_visit",
		"":                  "event",
		"!!!":               "event",
	}
	for in, want := range cases {
		if got := EventSlug(in); got != want {
			t.Fatalf("EventSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

// A slug-only aggregate compares the slug of each event's name, not the name.
func TestCompileAggregateBySlugMatchesTheSlugOfTheEventName(t *testing.T) {
	frag, err := CompileAggregate(AggregateInput{EventSlug: "Placed Order", Aggregation: "count", Comparator: "gte", Value: 1, PlaceholderOffset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if frag.Args[0] != "placed_order" {
		t.Fatalf("slug arg = %#v, want placed_order", frag.Args[0])
	}
	if !strings.Contains(frag.SQL, eventSlugSQL("event_name")+" = $1") {
		t.Fatalf("slug-only aggregate does not compare slugs: %s", frag.SQL)
	}
	named, err := CompileAggregate(AggregateInput{EventName: "Placed Order", EventSlug: "placed_order", Aggregation: "count", Comparator: "gte", Value: 1, PlaceholderOffset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if named.Args[0] != "Placed Order" || !strings.Contains(named.SQL, "AND event_name = $1") {
		t.Fatalf("a named event is not matched exactly: %#v %s", named.Args, named.SQL)
	}
}
