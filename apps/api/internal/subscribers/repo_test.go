package subscribers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestSubscriberPredictionOmittedWhenNil pins SUB-059: a subscriber the
// predictive worker has not scored serialises with NO "prediction" key (the
// detail GET hydration left Prediction nil), so the slideover can branch on
// presence.
func TestSubscriberPredictionOmittedWhenNil(t *testing.T) {
	b, err := json.Marshal(Subscriber{Email: "x@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "\"prediction\"") {
		t.Fatalf("nil Prediction must be omitted; got %s", b)
	}
}

// TestSubscriberPredictionRoundTrips pins SUB-059/SUB-060: the predictive-CLV
// projection (three CLV figures, churn risk, and ranked churn drivers)
// serialises with the field names the slideover Insights section reads, and
// the churn_drivers jsonb blob the repo reads from profile_predictions.
// churn_drivers decodes into the ranked driver list.
func TestSubscriberPredictionRoundTrips(t *testing.T) {
	// Simulate the jsonb churn_drivers blob the LEFT JOIN returns.
	driversBlob := []byte(`[
	  {"key":"recency","label":"Days since last order","value":"182","impact":"high"},
	  {"key":"frequency_trend","label":"Order cadence","value":"slowing (~150d between orders)","impact":"medium"},
	  {"key":"soft_bounce_trend","label":"Soft-bounce trend","value":"3 in last 30d","impact":"medium"}
	]`)
	var drivers []ChurnDriver
	if err := json.Unmarshal(driversBlob, &drivers); err != nil {
		t.Fatalf("decode churn_drivers blob: %v", err)
	}
	if len(drivers) != 3 || drivers[0].Key != "recency" || drivers[0].Impact != "high" {
		t.Fatalf("unexpected decoded drivers: %+v", drivers)
	}

	sub := Subscriber{
		Email: "buyer@example.com",
		Prediction: &SubscriberPrediction{
			HistoricCLVCents:  30000,
			PredictedCLVCents: 12000,
			TotalCLVCents:     42000,
			ChurnRisk:         0.42,
			Confidence:        0.65,
			DataSufficiency:   "sufficient",
			ChurnDrivers:      drivers,
			CalculatedAt:      time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC),
		},
	}
	b, err := json.Marshal(sub)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"\"prediction\"",
		"\"historic_clv_cents\":30000",
		"\"predicted_clv_cents\":12000",
		"\"total_clv_cents\":42000",
		"\"churn_risk\":0.42",
		"\"data_sufficiency\":\"sufficient\"",
		"\"churn_drivers\"",
		"\"impact\":\"high\"",
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("serialised subscriber missing %q\njson: %s", want, b)
		}
	}
}

// TestSubscriberSortScalarsOmittedWhenNil pins SUB-076: a subscriber that has
// never been scored / is unrated serialises with NO engagement_score /
// churn_score / rating keys, so the desktop sort-affordance headers can branch
// on presence rather than render a misleading 0.
func TestSubscriberSortScalarsOmittedWhenNil(t *testing.T) {
	b, err := json.Marshal(Subscriber{Email: "x@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"\"engagement_score\"", "\"churn_score\"", "\"rating\""} {
		if strings.Contains(string(b), key) {
			t.Fatalf("nil sort scalar %s must be omitted; got %s", key, b)
		}
	}
}

// TestSubscriberSortScalarsRoundTrip pins SUB-076: when populated, the three
// cached sort scalars serialise under the field names the desktop row renderer
// reads (engagement_score / churn_score / rating).
func TestSubscriberSortScalarsRoundTrip(t *testing.T) {
	eng, churn, rating := 87, 42, 5
	sub := Subscriber{
		Email:           "buyer@example.com",
		EngagementScore: &eng,
		ChurnScore:      &churn,
		Rating:          &rating,
	}
	b, err := json.Marshal(sub)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"\"engagement_score\":87",
		"\"churn_score\":42",
		"\"rating\":5",
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("serialised subscriber missing %q\njson: %s", want, b)
		}
	}
}

// TestSubscriberColumnsIncludeSortScalars pins SUB-076 at the SQL layer: the
// shared projection now SELECTs engagement_score / churn_score / rating so the
// header-sort affordance has values to render + server-sort against. Keeps the
// projection in lockstep with the scanSubscriber targets + the struct fields.
func TestSubscriberColumnsIncludeSortScalars(t *testing.T) {
	for _, col := range []string{"engagement_score", "churn_score", "rating"} {
		if !strings.Contains(subscriberColumns, col) {
			t.Fatalf("subscriberColumns missing %q (SUB-076): %s", col, subscriberColumns)
		}
	}
}

// TestDeriveNames covers SUB-004 name-column derivation: explicit input
// fields win, then Mailchimp merge_fields (FNAME/LNAME), then Klaviyo
// custom_fields (first_name/last_name); full/display default sensibly.
func TestDeriveNames(t *testing.T) {
	cases := []struct {
		name                           string
		in                             CreateInput
		first, last, full, displayWant string
	}{
		{
			name:        "explicit fields win",
			in:          CreateInput{FirstName: "Ada", LastName: "Lovelace"},
			first:       "Ada",
			last:        "Lovelace",
			full:        "Ada Lovelace",
			displayWant: "Ada Lovelace",
		},
		{
			name: "mailchimp merge fields",
			in: CreateInput{MergeFields: map[string]any{
				"FNAME": "Grace", "LNAME": "Hopper",
			}},
			first:       "Grace",
			last:        "Hopper",
			full:        "Grace Hopper",
			displayWant: "Grace Hopper",
		},
		{
			name: "klaviyo custom fields",
			in: CreateInput{CustomFields: map[string]any{
				"first_name": "Katherine", "last_name": "Johnson",
			}},
			first:       "Katherine",
			last:        "Johnson",
			full:        "Katherine Johnson",
			displayWant: "Katherine Johnson",
		},
		{
			name: "merge fields take precedence over custom fields",
			in: CreateInput{
				MergeFields:  map[string]any{"FNAME": "Merge"},
				CustomFields: map[string]any{"first_name": "Custom"},
			},
			first:       "Merge",
			last:        "",
			full:        "Merge",
			displayWant: "Merge",
		},
		{
			name:        "explicit display_name overrides derived",
			in:          CreateInput{FirstName: "Ada", LastName: "Lovelace", DisplayName: "Countess"},
			first:       "Ada",
			last:        "Lovelace",
			full:        "Ada Lovelace",
			displayWant: "Countess",
		},
		{
			name:        "no name anywhere",
			in:          CreateInput{},
			first:       "",
			last:        "",
			full:        "",
			displayWant: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deriveNames(tc.in)
			if got.first != tc.first || got.last != tc.last || got.full != tc.full || got.display != tc.displayWant {
				t.Fatalf("deriveNames = %+v; want first=%q last=%q full=%q display=%q",
					got, tc.first, tc.last, tc.full, tc.displayWant)
			}
		})
	}
}

// TestNilIfEmpty covers the localization NULL-write helper (SUB-005).
func TestNilIfEmpty(t *testing.T) {
	if nilIfEmpty("") != nil {
		t.Error("empty string should map to nil")
	}
	if nilIfEmpty("   ") != nil {
		t.Error("whitespace should map to nil")
	}
	if p := nilIfEmpty("  en-US "); p == nil || *p != "en-US" {
		t.Errorf("non-empty should trim+return pointer, got %v", p)
	}
}

// TestSubscriberFreeTextPredicateIsIndexBacked asserts the free-text predicate
// resolves through the GIN search_tsv index and the pg_trgm lower(email) index
// (migration 0242) rather than a per-row scan.
//
// It replaced a ten-column ILIKE whose every term led with '%' — unindexable by
// construction — and which cast custom_fields and merge_fields to text on every
// row. Names are still matched: search_tsv indexes the merge_fields FNAME/LNAME
// and custom_fields first_name/last_name keys the name columns are populated
// from.
func TestSubscriberFreeTextPredicateIsIndexBacked(t *testing.T) {
	clause := subscriberFreeTextPredicate(2)
	for _, want := range []string{
		"search_tsv @@ websearch_to_tsquery('simple', $2)",
		"lower(email::text) LIKE '%' || lower($2) || '%'",
	} {
		if !strings.Contains(clause, want) {
			t.Errorf("free-text predicate missing %q: %s", want, clause)
		}
	}
	for _, unindexable := range []string{
		"custom_fields::text ILIKE",
		"merge_fields::text ILIKE",
		"groups::text ILIKE",
		"unnest(tags)",
	} {
		if strings.Contains(clause, unindexable) {
			t.Errorf("free-text predicate is back on the unindexable scan (%q): %s", unindexable, clause)
		}
	}
}

func TestNormalizeSort(t *testing.T) {
	cases := []struct {
		name      string
		sort      string
		order     string
		wantCol   string
		wantOrder string
	}{
		{"default", "", "", "updated_at", "DESC"},
		{"email asc", "email", "asc", "email", "ASC"},
		{"email upper desc", "EMAIL", "DESC", "email", "DESC"},
		{"status maps to mailchimp_status", "status", "asc", "mailchimp_status", "ASC"},
		{"joined alias", "joined", "desc", "created_at", "DESC"},
		{"created_at direct", "created_at", "asc", "created_at", "ASC"},
		{"engagement", "engagement", "desc", "engagement_score", "DESC"},
		{"engagement_score alias", "engagement_score", "asc", "engagement_score", "ASC"},
		{"first_name asc (SUB-004)", "first_name", "asc", "first_name", "ASC"},
		{"last_name desc (SUB-004)", "last_name", "desc", "last_name", "DESC"},
		{"first_name upper", "FIRST_NAME", "asc", "first_name", "ASC"},
		// SUB-038 — churn/rating are now server-sortable (previously they
		// were NOT in the allow-list and fell back to updated_at).
		{"churn desc (SUB-038)", "churn", "desc", "churn_score", "DESC"},
		{"churn alias churn_score (SUB-038)", "churn_score", "asc", "churn_score", "ASC"},
		{"churn upper (SUB-038)", "CHURN", "desc", "churn_score", "DESC"},
		{"rating asc (SUB-038)", "rating", "asc", "rating", "ASC"},
		{"rating desc (SUB-038)", "rating", "desc", "rating", "DESC"},
		{"rating upper (SUB-038)", "RATING", "asc", "rating", "ASC"},
		{"unknown falls back", "name; DROP TABLE", "asc", "updated_at", "ASC"},
		{"unknown order falls back to desc", "email", "sideways", "email", "DESC"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			col, dir := normalizeSort(tc.sort, tc.order)
			if col != tc.wantCol {
				t.Fatalf("col = %q, want %q", col, tc.wantCol)
			}
			if dir != tc.wantOrder {
				t.Fatalf("dir = %q, want %q", dir, tc.wantOrder)
			}
		})
	}
}

// TestDiffSubscriberAttributes_PIIScalars covers SUB-054: the PII scalar
// columns (email, first/last/full/display name, signup_ip) now participate in
// the attribute-history diff so a PATCH that rotates them produces
// subscriber_attribute_history rows AND feeds the audit_log metadata.
func TestDiffSubscriberAttributes_PIIScalars(t *testing.T) {
	before := &Subscriber{
		Email:     "old@example.com",
		FirstName: "Ada",
		SignupIP:  "1.1.1.1",
		Status:    "enabled",
	}
	after := &Subscriber{
		Email:     "new@example.com",
		FirstName: "Grace",
		SignupIP:  "2.2.2.2",
		Status:    "enabled", // unchanged
	}
	changes := diffSubscriberAttributes(before, after)
	got := map[string]bool{}
	for _, c := range changes {
		got[c.field] = true
	}
	for _, want := range []string{"email", "first_name", "signup_ip"} {
		if !got[want] {
			t.Errorf("expected diff to include %q; got fields %v", want, got)
		}
	}
	if got["status"] {
		t.Error("status was unchanged; must not appear in diff")
	}
}

// TestDiffSubscriberAttributes_CustomFieldDelta covers the combined SUB-054
// scenario: a PATCH that changes both email (scalar PII) and a custom field
// produces both rows.
func TestDiffSubscriberAttributes_EmailAndCustomField(t *testing.T) {
	before := &Subscriber{Email: "a@x.co", CustomFields: map[string]any{"plan": "free"}}
	after := &Subscriber{Email: "b@x.co", CustomFields: map[string]any{"plan": "pro"}}
	changes := diffSubscriberAttributes(before, after)
	got := map[string]bool{}
	for _, c := range changes {
		got[c.field] = true
	}
	if !got["email"] {
		t.Error("expected email change row")
	}
	if !got["custom_fields.plan"] {
		t.Errorf("expected custom_fields.plan change row; got %v", got)
	}
}

// TestIsPIIAuditField covers the SUB-054 audit PII classification: scalar PII
// fields and any custom/merge field key count as PII; localization/status do
// not.
func TestIsPIIAuditField(t *testing.T) {
	pii := []string{"email", "first_name", "last_name", "full_name", "display_name", "signup_ip", "consent_source", "custom_fields.plan", "merge_fields.FNAME"}
	for _, f := range pii {
		if !isPIIAuditField(f) {
			t.Errorf("isPIIAuditField(%q) = false, want true", f)
		}
	}
	notPII := []string{"status", "mailchimp_status", "locale", "language", "country", "region"}
	for _, f := range notPII {
		if isPIIAuditField(f) {
			t.Errorf("isPIIAuditField(%q) = true, want false", f)
		}
	}
}

func TestStatusFilterClause(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		wantCol string
		wantVal string
		wantOK  bool
	}{
		{"empty", "", "", "", false},
		{"all", "all", "", "", false},
		{"subscribed → mailchimp_status", "subscribed", "mailchimp_status", "subscribed", true},
		{"unsubscribed → mailchimp_status", "Unsubscribed", "mailchimp_status", "unsubscribed", true},
		{"bounced alias → cleaned", "bounced", "mailchimp_status", "cleaned", true},
		{"non_subscribed → mailchimp_status", "non_subscribed", "mailchimp_status", "non_subscribed", true},
		{"pending → mailchimp_status", "pending", "mailchimp_status", "pending", true},
		{"transactional → mailchimp_status", "transactional", "mailchimp_status", "transactional", true},
		{"cleaned → mailchimp_status", "cleaned", "mailchimp_status", "cleaned", true},
		{"archived → mailchimp_status", "archived", "mailchimp_status", "archived", true},
		{"deleted → mailchimp_status", "deleted", "mailchimp_status", "deleted", true},
		{"enabled → status", "enabled", "status", "enabled", true},
		{"disabled → status", "disabled", "status", "disabled", true},
		{"blocklisted → status", "blocklisted", "status", "blocklisted", true},
		{"unconfirmed → status", "unconfirmed", "status", "unconfirmed", true},
		{"unconfirmed case-insensitive → status", "Unconfirmed", "status", "unconfirmed", true},
		{"unknown rejected", "garbage", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			col, val, ok := statusFilterClause(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if col != tc.wantCol {
				t.Fatalf("col = %q, want %q", col, tc.wantCol)
			}
			if val != tc.wantVal {
				t.Fatalf("val = %q, want %q", val, tc.wantVal)
			}
		})
	}
}
