// SPDX-License-Identifier: AGPL-3.0-only
package dmarc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInsightsRequiresTenantAndDisablesCaching(t *testing.T) {
	d := &Deps{}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/dmarc-insights", nil)
	response := httptest.NewRecorder()

	d.Insights(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	assertSensitiveResponseHeaders(t, response)
}

func TestInsightsRejectsInvalidScopeBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name string
		url  string
		code string
	}{
		{name: "zero days", url: "?days=0", code: "invalid_days"},
		{name: "too many days", url: "?days=366", code: "invalid_days"},
		{name: "signed days", url: "?days=%2B30", code: "invalid_days"},
		{name: "decimal days", url: "?days=30.0", code: "invalid_days"},
		{name: "invalid domain", url: "?domain=bad..example", code: "invalid_domain"},
		{name: "unknown parameter", url: "?offset=1", code: "invalid_query"},
		{name: "repeated days", url: "?days=7&days=30", code: "invalid_query"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &Deps{Pool: nil}
			request := withTestTenant(httptest.NewRequest(
				http.MethodGet,
				"/api/v1/deliverability/dmarc-insights"+test.url,
				nil,
			))
			response := httptest.NewRecorder()

			d.Insights(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
			}
			if got := responseErrorCode(t, response); got != test.code {
				t.Errorf("error code = %q, want %q", got, test.code)
			}
			assertSensitiveResponseHeaders(t, response)
		})
	}
}

func TestSourceDetailRejectsInvalidScopeBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name string
		url  string
		code string
	}{
		{name: "missing IP", url: "?days=30", code: "invalid_ip"},
		{name: "invalid IP", url: "?ip=999.1.1.1", code: "invalid_ip"},
		{name: "invalid domain", url: "?ip=192.0.2.1&domain=bad..example", code: "invalid_domain"},
		{name: "zero days", url: "?ip=192.0.2.1&days=0", code: "invalid_days"},
		{name: "too many days", url: "?ip=192.0.2.1&days=366", code: "invalid_days"},
		{name: "non integer days", url: "?ip=192.0.2.1&days=month", code: "invalid_days"},
		{name: "unknown parameter", url: "?ip=192.0.2.1&page=2", code: "invalid_query"},
		{name: "repeated IP", url: "?ip=192.0.2.1&ip=192.0.2.2", code: "invalid_query"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &Deps{Pool: nil}
			request := withTestTenant(httptest.NewRequest(
				http.MethodGet,
				"/api/v1/deliverability/dmarc-sources"+test.url,
				nil,
			))
			response := httptest.NewRecorder()

			d.SourceDetail(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
			}
			if got := responseErrorCode(t, response); got != test.code {
				t.Errorf("error code = %q, want %q", got, test.code)
			}
			assertSensitiveResponseHeaders(t, response)
		})
	}
}

func TestParseDaysStrictDecimalRange(t *testing.T) {
	tests := []struct {
		input string
		want  int
		ok    bool
	}{
		{input: "", want: 30, ok: true},
		{input: "1", want: 1, ok: true},
		{input: "030", want: 30, ok: true},
		{input: "365", want: 365, ok: true},
		{input: "0"},
		{input: "366"},
		{input: "+30"},
		{input: " 30"},
		{input: "30.0"},
	}
	for _, test := range tests {
		got, err := parseDays(test.input)
		if (err == nil) != test.ok || got != test.want {
			t.Errorf("parseDays(%q) = (%d, %v), want (%d, ok=%v)", test.input, got, err, test.want, test.ok)
		}
	}
}

func TestBuildSuggestionsDistinguishesNoReportsFromEmptyReports(t *testing.T) {
	noReports := buildSuggestions(&InsightsResponse{})
	if len(noReports) != 1 || noReports[0].Code != "no_reports" || noReports[0].Severity != "info" {
		t.Fatalf("no-report suggestion = %+v", noReports)
	}

	emptyReports := buildSuggestions(&InsightsResponse{ReportCount: 2})
	if len(emptyReports) != 1 || emptyReports[0].Code != "no_observed_messages" || emptyReports[0].Severity != "warning" {
		t.Fatalf("empty-report suggestion = %+v", emptyReports)
	}
}

func TestBuildSuggestionsUsesEvidenceSafeSemantics(t *testing.T) {
	response := &InsightsResponse{
		ReportCount:   3,
		TotalMessages: 1000,
		PeriodDays:    30,
		Alignment: AlignmentSummary{
			BothPass: 700, NeitherPass: 300, AlignedPct: 0.70,
		},
		Disposition:  DispositionSummary{None: 799, Quarantine: 151, Reject: 50},
		LatestPolicy: "none",
	}
	got := buildSuggestions(response)
	if !hasSuggestionCode(got, "alignment_low") {
		t.Fatalf("missing alignment_low: %+v", got)
	}
	if !hasSuggestionCode(got, "policy_action_volume_high") {
		t.Fatalf("missing high policy-action suggestion: %+v", got)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal suggestions: %v", err)
	}
	text := strings.ToLower(string(encoded))
	for _, forbidden := range []string{"policyrecord", "v=dmarc1", "p=quarantine", "blocked", "delivered"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("suggestion made unsafe claim %q: %s", forbidden, text)
		}
	}
}

func TestBuildSuggestionsPolicyActionThresholdIsDeterministic(t *testing.T) {
	base := InsightsResponse{
		ReportCount:   1,
		TotalMessages: 1000,
		PeriodDays:    30,
		Alignment:     AlignmentSummary{BothPass: 950, NeitherPass: 50, AlignedPct: 0.95},
	}
	base.Disposition = DispositionSummary{None: 900, Quarantine: 100}
	if got := buildSuggestions(&base); !hasSuggestionCode(got, "policy_action_volume_low") {
		t.Fatalf("10%% should use low code: %+v", got)
	}
	base.Disposition = DispositionSummary{None: 899, Quarantine: 101}
	if got := buildSuggestions(&base); !hasSuggestionCode(got, "policy_action_volume_high") {
		t.Fatalf(">10%% should use high code: %+v", got)
	}
}

func TestBuildSuggestionsDKIMCoverageRequiresMeaningfulSample(t *testing.T) {
	response := &InsightsResponse{
		ReportCount:   10,
		TotalMessages: 1000,
		PeriodDays:    30,
		ReportingDays: 6,
		Alignment: AlignmentSummary{
			BothPass: 200, SPFOnlyPass: 790, NeitherPass: 10, AlignedPct: 0.99,
		},
		Disposition: DispositionSummary{None: 1000},
	}
	if got := buildSuggestions(response); hasSuggestionCode(got, "spf_only_alignment") {
		t.Fatalf("short observation window produced DKIM coverage advice: %+v", got)
	}
	response.ReportingDays = 7
	if got := buildSuggestions(response); !hasSuggestionCode(got, "spf_only_alignment") {
		t.Fatalf("meaningful sample did not produce DKIM coverage review: %+v", got)
	}
}

func TestBuildSuggestionsHealthyResponseIsANonNilEmptySlice(t *testing.T) {
	got := buildSuggestions(&InsightsResponse{
		ReportCount:   1,
		TotalMessages: 100,
		PeriodDays:    30,
		Alignment:     AlignmentSummary{BothPass: 100, AlignedPct: 1},
		Disposition:   DispositionSummary{None: 100},
	})
	if got == nil || len(got) != 0 {
		t.Fatalf("healthy suggestions = %#v, want non-nil empty slice", got)
	}
}

func TestDispositionAndVolumeTieBreaksAreDeterministic(t *testing.T) {
	if got := pickDisposition(map[string]int64{"none": 100, "quarantine": 100, "reject": 100}); got != "reject" {
		t.Errorf("disposition tie = %q, want reject", got)
	}
	if got := pickDisposition(map[string]int64{"none": 1, "unknown": 10}); got != "unknown" {
		t.Errorf("unknown majority = %q, want unknown", got)
	}
	if got := pickDisposition(map[string]int64{"pass": 10}); got != "unknown" {
		t.Errorf("unrecognised disposition = %q, want unknown", got)
	}
	for i := 0; i < 100; i++ {
		if got := pickByVolume(map[string]int64{"z.example": 5, "a.example": 5}); got != "a.example" {
			t.Fatalf("volume tie = %q, want lexical winner", got)
		}
	}
}

func TestCanonicalEnvelopeFromDomainNeverExposesMailboxLocalParts(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{
			name:  "VERP mailbox",
			input: "bounce+customer=recipient.example@Mailer.EXAMPLE.com",
			want:  "mailer.example.com",
			ok:    true,
		},
		{
			name:  "angle wrapped mailbox",
			input: "<sender@example.com>",
			want:  "example.com",
			ok:    true,
		},
		{
			name:  "canonical hostname",
			input: "mx.example.com",
			want:  "mx.example.com",
			ok:    true,
		},
		{name: "malformed", input: "not a mailbox"},
		{name: "control character", input: "sender@example.com\x00evil"},
		{name: "empty", input: "   "},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := canonicalEnvelopeFromDomain(test.input)
			if got != test.want || ok != test.ok {
				t.Fatalf("canonicalEnvelopeFromDomain(%q) = (%q, %v), want (%q, %v)", test.input, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestAlignedMessageCountIsBounded(t *testing.T) {
	if got := alignedMessageCount(SourceRow{Messages: 10, DKIMPass: 8, SPFPass: 7, BothPass: 6}); got != 9 {
		t.Errorf("aligned = %d, want 9", got)
	}
	if got := alignedMessageCount(SourceRow{Messages: 10, DKIMPass: 20, SPFPass: 20}); got != 10 {
		t.Errorf("over-count = %d, want clamp to 10", got)
	}
	if got := alignedMessageCount(SourceRow{Messages: 10, BothPass: 1}); got != 0 {
		t.Errorf("negative count = %d, want clamp to 0", got)
	}
}

func TestTopNPreservesOrderAndNeverReturnsNil(t *testing.T) {
	rows := []SourceRow{{SourceIP: "192.0.2.1", Messages: 10}, {SourceIP: "192.0.2.2", Messages: 5}}
	if got := topN(rows, 1); len(got) != 1 || got[0].SourceIP != "192.0.2.1" {
		t.Errorf("topN(1) = %+v", got)
	}
	if got := topN(nil, 5); got == nil || len(got) != 0 {
		t.Errorf("topN(nil) = %#v, want empty slice", got)
	}
}

func TestInsightsAndSourceJSONShapesUseNonNilCollections(t *testing.T) {
	now := time.Date(2026, 8, 3, 3, 0, 0, 0, time.UTC)
	insights := InsightsResponse{
		Domain:      "example.com",
		PeriodDays:  30,
		GeneratedAt: now,
		WindowStart: now.Add(-30 * 24 * time.Hour),
		WindowEnd:   now,
		TopSources:  []SourceRow{},
		TopFailing:  []SourceRow{},
		Suggestions: []Suggestion{},
		Series:      []DailyPoint{},
	}
	source := SourceDetailResponse{
		SourceIP:    "192.0.2.1",
		PeriodDays:  30,
		GeneratedAt: now,
		WindowStart: now.Add(-30 * 24 * time.Hour),
		WindowEnd:   now,
		Summary:     SourceRow{SourceIP: "192.0.2.1", Disposition: "none"},
		PerReport:   []SourcePerReport{},
	}

	for name, payload := range map[string]any{"insights": insights, "source": source} {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		text := string(encoded)
		if strings.Contains(text, ":null") {
			t.Errorf("%s response contains null: %s", name, text)
		}
		if strings.Contains(text, "policyRecord") || strings.Contains(text, "ackedCodes") {
			t.Errorf("%s response retained unsafe/obsolete fields: %s", name, text)
		}
	}
}

func hasSuggestionCode(suggestions []Suggestion, code string) bool {
	for _, suggestion := range suggestions {
		if suggestion.Code == code {
			return true
		}
	}
	return false
}
