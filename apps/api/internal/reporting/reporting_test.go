package reporting

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateRejectsUnknownAndTooManyMetrics(t *testing.T) {
	metrics := make([]MetricSpec, 0, 11)
	for i := 0; i < 11; i++ {
		metrics = append(metrics, MetricSpec{Key: "campaign.opened"})
	}
	metrics[10] = MetricSpec{Key: "unknown.metric"}

	out := Validate(ReportRequest{Metrics: metrics}, registryMap(BuiltinMetricRegistry()))
	if out.Valid {
		t.Fatal("expected validation failure")
	}
	joined := strings.Join(out.Errors, "\n")
	if !strings.Contains(joined, "at most ten metrics") {
		t.Fatalf("errors = %v, want ten metric cap", out.Errors)
	}
	if !strings.Contains(joined, "unknown.metric") {
		t.Fatalf("errors = %v, want unknown metric", out.Errors)
	}
	if !strings.Contains(joined, "duplicated") {
		t.Fatalf("errors = %v, want duplicate metric warning as error", out.Errors)
	}
}

func TestReportExportsAreNeverCacheableEvenOnAuthorizationFailure(t *testing.T) {
	for _, handler := range []struct {
		name string
		run  func(http.ResponseWriter, *http.Request)
	}{
		{name: "csv", run: (&Deps{}).ExportRunCSV},
		{name: "json", run: (&Deps{}).ExportRunJSON},
	} {
		t.Run(handler.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/reporting/runs/run-1/export."+handler.name, nil)
			rec := httptest.NewRecorder()
			handler.run(rec, req)
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
		})
	}
}

func TestValidateAcceptsKlaviyoStyleReport(t *testing.T) {
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{
			{Key: "campaign.opened"},
			{Key: "campaign.clicked"},
			{Key: "form.confirmed"},
		},
		Dimensions:    []string{"day"},
		Visualization: "line",
	}, registryMap(BuiltinMetricRegistry()))
	if !out.Valid {
		t.Fatalf("Validate() errors = %v", out.Errors)
	}
}

func TestValidateRejectsQueryPartsTheExecutorCannotHonor(t *testing.T) {
	registry := registryMap(BuiltinMetricRegistry())
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{{
			Key:         "campaign.opened",
			Alias:       "opens",
			Aggregation: "unique_count",
		}},
		Dimensions: []string{"day", "campaign_id"},
		Filters:    map[string]any{"campaign_id": "campaign-1"},
	}, registry)
	if out.Valid {
		t.Fatal("expected non-executable dimension and filter to fail closed")
	}
	joined := strings.Join(out.Errors, "\n")
	for _, want := range []string{
		`metric "campaign.opened" alias is not executable yet`,
		`metric "campaign.opened" aggregation override is not executable yet`,
		`dimension "campaign_id" is not executable yet`,
		"filters are not executable yet",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("errors = %v, want %q", out.Errors, want)
		}
	}
}

func TestValidateRejectsSupportedCustomMetricWithoutExecutor(t *testing.T) {
	registry := registryMap(BuiltinMetricRegistry())
	registry["custom.orders"] = MetricDefinition{
		Key:           "custom.orders",
		Label:         "Custom orders",
		ProductArea:   "custom",
		RuntimeStatus: "supported",
	}
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{{Key: "custom.orders"}},
	}, registry)
	if out.Valid {
		t.Fatal("expected custom metric without an executor to fail closed")
	}
	if !strings.Contains(strings.Join(out.Errors, "\n"), "has no report executor") {
		t.Fatalf("errors = %v, want executor error", out.Errors)
	}
}

func TestValidateRejectsDatabaseConstraintAndRangeMismatches(t *testing.T) {
	from := mustReportingTime(t, "2026-07-02T00:00:00Z")
	to := mustReportingTime(t, "2026-07-01T00:00:00Z")
	out := Validate(ReportRequest{
		ProductArea: "unregistered-area",
		Status:      "published",
		Metrics:     []MetricSpec{{Key: "campaign.opened"}},
		TimeRange:   TimeRange{Preset: "forever", From: &from, To: &to},
	}, registryMap(BuiltinMetricRegistry()))
	if out.Valid {
		t.Fatal("expected database constraint and invalid range values to fail")
	}
	joined := strings.Join(out.Errors, "\n")
	for _, want := range []string{
		"product_area is not supported",
		"status must be draft|active|archived",
		"time_range must use a supported preset",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("errors = %v, want %q", out.Errors, want)
		}
	}
}

func mustReportingTime(t *testing.T, value string) time.Time {
	t.Helper()
	out, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time: %v", err)
	}
	return out
}

func TestValidateWarnsForPlannedMetrics(t *testing.T) {
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{{Key: "deliverability.provider_breakdown"}},
	}, registryMap(BuiltinMetricRegistry()))
	if !out.Valid {
		t.Fatalf("Validate() errors = %v", out.Errors)
	}
	if len(out.Warnings) == 0 || !strings.Contains(out.Warnings[0], "planned") {
		t.Fatalf("warnings = %v, want planned warning", out.Warnings)
	}
}

func TestBuiltinMetricRegistryCoversProducts(t *testing.T) {
	areas := map[string]bool{}
	keys := map[string]bool{}
	for _, item := range BuiltinMetricRegistry() {
		if keys[item.Key] {
			t.Fatalf("registry contains duplicate metric key %q", item.Key)
		}
		keys[item.Key] = true
		areas[item.ProductArea] = true
	}
	for _, area := range []string{"campaign", "flow", "form", "onsite", "commerce", "deliverability", "sms", "push", "reviews", "helpdesk"} {
		if !areas[area] {
			t.Fatalf("registry missing product area %q", area)
		}
	}
}

func TestValidateRatioMetricsResolveComponents(t *testing.T) {
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{
			{Key: "campaign.open_rate"},
			{Key: "campaign.click_to_open_rate"},
			{Key: "form.confirmation_rate"},
		},
	}, registryMap(BuiltinMetricRegistry()))
	if !out.Valid {
		t.Fatalf("ratio metrics should validate against built-in registry: %v", out.Errors)
	}
}

func TestValidateRejectsRatioMetricWithUnknownComponent(t *testing.T) {
	custom := BuiltinMetricRegistry()
	custom = append(custom, MetricDefinition{
		Key:           "bogus.rate",
		Label:         "Bogus rate",
		ProductArea:   "campaign",
		Aggregation:   "ratio",
		ValueType:     "rate",
		RuntimeStatus: "supported",
		Computation:   "ratio",
		Numerator:     "campaign.opened",
		Denominator:   "campaign.does_not_exist",
	})
	out := Validate(ReportRequest{
		Metrics: []MetricSpec{{Key: "bogus.rate"}},
	}, registryMap(custom))
	if out.Valid {
		t.Fatal("expected validation failure for bogus ratio")
	}
	if !strings.Contains(strings.Join(out.Errors, "\n"), "does_not_exist") {
		t.Fatalf("errors = %v, want denominator reference error", out.Errors)
	}
}

func TestRatioRowFlagsDenominatorZero(t *testing.T) {
	metric := MetricDefinition{
		Key:         "campaign.open_rate",
		ProductArea: "campaign",
		Computation: "ratio",
		Numerator:   "campaign.opened",
		Denominator: "campaign.delivered",
	}
	zero := ratioRow(metric, 5, 0, nil)
	if got, _ := zero["denominator_zero"].(bool); !got {
		t.Fatalf("expected denominator_zero=true, row=%+v", zero)
	}
	if v, _ := zero["value"].(float64); v != 0 {
		t.Fatalf("expected value=0 on zero-denominator, got %v", v)
	}
	normal := ratioRow(metric, 5, 10, nil)
	if v, _ := normal["value"].(float64); v != 0.5 {
		t.Fatalf("expected value=0.5, got %v", v)
	}
	if got, _ := normal["denominator_zero"].(bool); got {
		t.Fatalf("denominator_zero should be false")
	}
}

func TestRunResultToCSVSerializesRowsAndRatesDeterministically(t *testing.T) {
	run := &ReportRun{
		ID:     "run-1",
		Status: "completed",
		Result: map[string]any{
			"rows": []any{
				map[string]any{
					"metric":       "campaign.open_rate",
					"product_area": "campaign",
					"day":          "2026-06-01",
					"value":        0.5,
					"value_type":   "rate",
					"numerator":    float64(5),
					"denominator":  float64(10),
				},
				map[string]any{
					"metric":       "campaign.opened",
					"product_area": "campaign",
					"day":          "2026-06-01",
					"value":        float64(5),
				},
			},
		},
	}
	body, err := RunResultToCSV(run)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	got := string(body)
	wantHeader := "metric,product_area,day,value,value_type,numerator,denominator"
	if !strings.HasPrefix(got, wantHeader) {
		t.Fatalf("csv header = %q, want prefix %q", got, wantHeader)
	}
	if !strings.Contains(got, "campaign.open_rate,campaign,2026-06-01,0.5,rate,5,10") {
		t.Fatalf("missing ratio row, got:\n%s", got)
	}
	if !strings.Contains(got, "campaign.opened,campaign,2026-06-01,5,,,") {
		t.Fatalf("missing count row with blanks for ratio columns, got:\n%s", got)
	}
}

func TestRunResultToCSVRefusesIncompleteRuns(t *testing.T) {
	run := &ReportRun{ID: "run-2", Status: "running", Result: map[string]any{}}
	if _, err := RunResultToCSV(run); err == nil {
		t.Fatal("expected error for non-completed run")
	}
}

func TestRunResultToCSVNeutralizesSpreadsheetFormulaStrings(t *testing.T) {
	run := &ReportRun{
		ID:     "run-formula",
		Status: "completed",
		Result: map[string]any{
			"rows": []any{
				map[string]any{
					"metric":       "campaign.opened",
					"product_area": "=HYPERLINK(\"https://attacker.invalid\")",
					"value":        float64(-5),
				},
			},
		},
	}
	body, err := RunResultToCSV(run)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	got := string(body)
	if !strings.Contains(got, `"'=HYPERLINK(""https://attacker.invalid"")"`) {
		t.Fatalf("formula string was not neutralized:\n%s", got)
	}
	if !strings.Contains(got, ",-5") {
		t.Fatalf("typed negative number should remain numeric:\n%s", got)
	}
}

func TestBlockedProductSummaryGroupsPlannedMetrics(t *testing.T) {
	out := BlockedProductSummary(BuiltinMetricRegistry())
	byArea := map[string]BlockedProduct{}
	for _, item := range out {
		byArea[item.ProductArea] = item
	}
	for _, area := range []string{"flow", "deliverability", "sms", "push", "reviews", "helpdesk"} {
		if _, ok := byArea[area]; !ok {
			t.Fatalf("missing blocked product %q", area)
		}
	}
	for _, area := range []string{"campaign", "form", "onsite", "commerce"} {
		if _, ok := byArea[area]; ok {
			t.Fatalf("product %q is supported and should NOT appear in blocked list", area)
		}
	}
	if !strings.Contains(byArea["reviews"].Initiative, "KLV-11") {
		t.Fatalf("reviews initiative = %q", byArea["reviews"].Initiative)
	}
}
