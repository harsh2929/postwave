// SPDX-License-Identifier: AGPL-3.0-only
package nql

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---- metric whitelist ---------------------------------------------------

func TestAnomalyMetricWhitelist(t *testing.T) {
	want := []string{"opens", "clicks", "bounces", "complaints", "unsubscribes", "revenue"}
	got := AnomalyMetricIDs()
	if len(got) != len(want) {
		t.Fatalf("metrics = %v, want %v", got, want)
	}
	for _, id := range want {
		if anomalyMetricByID(id) == nil {
			t.Errorf("metric %s missing from whitelist", id)
		}
	}
	if anomalyMetricByID("  OPENS ") == nil {
		t.Error("metric lookup should be case/space-insensitive")
	}
	for _, bad := range []string{"opens; DROP TABLE", "raw_sql", ""} {
		if anomalyMetricByID(bad) != nil {
			t.Errorf("metric %q should be rejected", bad)
		}
	}
}

// ---- window clamping ------------------------------------------------------

func TestClampWindowDays(t *testing.T) {
	cases := []struct {
		windowDays, window, want int
	}{
		{0, 0, anomalyDefaultWindowDays}, // defaults
		{14, 0, 14},                      // canonical field
		{0, 21, 21},                      // alias accepted
		{14, 21, 14},                     // canonical wins
		{500, 0, maxWindowDays},          // clamped high
		{-3, -9, anomalyDefaultWindowDays},
	}
	for _, tc := range cases {
		if got := clampWindowDays(tc.windowDays, tc.window); got != tc.want {
			t.Errorf("clampWindowDays(%d, %d) = %d, want %d", tc.windowDays, tc.window, got, tc.want)
		}
	}
}

func TestValidAnomalyISOCurrency(t *testing.T) {
	for _, value := range []string{"USD", "EUR", "INR", "JPY"} {
		if !validAnomalyISOCurrency(value) {
			t.Errorf("%q should be accepted", value)
		}
	}
	for _, value := range []string{"", "usd", "US", "USDD", "ZZZ", "12A"} {
		if validAnomalyISOCurrency(value) {
			t.Errorf("%q should be rejected", value)
		}
	}
}

// ---- brief parsing ----------------------------------------------------------

func TestParseAnomalyBrief_Valid(t *testing.T) {
	brief, err := parseAnomalyBrief(`{
		"summary": "Bounces doubled vs the prior week.",
		"probable_causes": [" stale list segment ", "", "new sending domain"],
		"suggested_actions": ["pause the affected campaign"]
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if brief.Summary != "Bounces doubled vs the prior week." {
		t.Fatalf("summary = %q", brief.Summary)
	}
	if len(brief.ProbableCauses) != 2 || brief.ProbableCauses[0] != "stale list segment" {
		t.Fatalf("causes = %v (empties must be dropped, entries trimmed)", brief.ProbableCauses)
	}
	if len(brief.SuggestedActions) != 1 {
		t.Fatalf("actions = %v", brief.SuggestedActions)
	}
}

func TestParseAnomalyBrief_Fenced(t *testing.T) {
	brief, err := parseAnomalyBrief("```json\n{\"summary\":\"s\",\"probable_causes\":[],\"suggested_actions\":[]}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if brief.Summary != "s" {
		t.Fatalf("summary = %q", brief.Summary)
	}
}

func TestParseAnomalyBrief_Malformed(t *testing.T) {
	for _, bad := range []string{"", "not json", `{"probable_causes":["x"]}`, `{"summary":"  "}`} {
		if _, err := parseAnomalyBrief(bad); !errors.Is(err, errMalformedBrief) {
			t.Errorf("%q: err = %v, want errMalformedBrief", bad, err)
		}
	}
}

// ---- handler validation -------------------------------------------------------

func briefRequest(t *testing.T, body string, withTenant bool) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/anomaly-brief", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if withTenant {
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	}
	return req
}

func TestAnomalyBrief_RequiresTenant(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	rec := httptest.NewRecorder()
	d.anomalyBrief(rec, briefRequest(t, `{"metric":"opens"}`, false))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAnomalyBrief_503WithoutLLM(t *testing.T) {
	d := &AnalyticsDeps{}
	rec := httptest.NewRecorder()
	d.anomalyBrief(rec, briefRequest(t, `{"metric":"opens"}`, true))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// TestAnomalyBrief_RejectsUnknownMetric: a metric outside the whitelist
// is refused with 422 before any SQL runs (Pool is nil here — reaching
// the DB would panic the test).
func TestAnomalyBrief_RejectsUnknownMetric(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	for _, body := range []string{
		`{"metric":"signups"}`,
		`{"metric":"opens; DROP TABLE campaigns"}`,
		`{}`,
	} {
		rec := httptest.NewRecorder()
		d.anomalyBrief(rec, briefRequest(t, body, true))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "invalid_metric") {
			t.Errorf("%s: body = %s, want invalid_metric", body, rec.Body.String())
		}
	}
}

func TestAnomalyBrief_ContextTooLong(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	rec := httptest.NewRecorder()
	d.anomalyBrief(rec, briefRequest(t,
		`{"metric":"opens","context":"`+strings.Repeat("a", anomalyContextMaxLen+1)+`"}`, true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestAnomalyBrief_BadJSON(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	rec := httptest.NewRecorder()
	d.anomalyBrief(rec, briefRequest(t, `{"metric":`, true))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ---- brief generation -----------------------------------------------------------

func TestGenerateAnomalyBrief_UsesAggregatesAndContext(t *testing.T) {
	llm := &fakeLLM{text: `{"summary":"opens fell 40%","probable_causes":["c"],"suggested_actions":["a"]}`}
	agg := &anomalyAggregates{CurrentTotal: 60, PreviousTotal: 100}
	brief, pin, pout, err := generateAnomalyBrief(t.Context(), llm, anomalyMetricByID("opens"), 7, "we changed ESPs", agg)
	if err != nil {
		t.Fatal(err)
	}
	if brief.Summary != "opens fell 40%" {
		t.Fatalf("summary = %q", brief.Summary)
	}
	if pin != 100 || pout != 50 {
		t.Fatalf("tokens = (%d, %d)", pin, pout)
	}
	if len(llm.calls) != 1 {
		t.Fatalf("llm calls = %d", len(llm.calls))
	}
	prompt := llm.calls[0]
	for _, want := range []string{`"current_total":60`, `"previous_total":100`, "we changed ESPs", "last 7 day(s)"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestAnomalyBriefPrompt_IncludesRevenueCurrencyScope(t *testing.T) {
	eur := "EUR"
	agg := &anomalyAggregates{
		Metric:        "revenue",
		WindowDays:    7,
		CurrentTotal:  12_345,
		PreviousTotal: 5_000,
		RevenueScope: &anomalyRevenueScope{
			Currency:                &eur,
			MonetaryConversionCount: 4,
			ExcludedCurrencyCount:   1,
		},
	}
	_, prompt := anomalyBriefPrompt(anomalyMetricByID("revenue"), 7, "", agg)
	for _, want := range []string{
		`"metric":"revenue"`,
		`"currency":"EUR"`,
		`"monetary_conversion_count":4`,
		`"excluded_currency_count":1`,
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestGenerateAnomalyBrief_MalformedLLMOutput(t *testing.T) {
	llm := &fakeLLM{text: "The metric looks fine to me!"}
	_, pin, pout, err := generateAnomalyBrief(t.Context(), llm, anomalyMetricByID("opens"), 7, "", &anomalyAggregates{})
	if !errors.Is(err, errMalformedBrief) {
		t.Fatalf("err = %v, want errMalformedBrief", err)
	}
	// Tokens still reported so the tracker can charge the failed call.
	if pin != 100 || pout != 50 {
		t.Fatalf("tokens = (%d, %d)", pin, pout)
	}
}
