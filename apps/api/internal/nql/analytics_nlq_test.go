// SPDX-License-Identifier: AGPL-3.0-only
package nql

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fakeLLM returns a canned completion.
type fakeLLM struct {
	text  string
	err   error
	calls []string // user prompts
}

func (f *fakeLLM) Complete(_ context.Context, _, user string) (string, int, int, error) {
	f.calls = append(f.calls, user)
	if f.err != nil {
		return "", 0, 0, f.err
	}
	return f.text, 100, 50, nil
}

// ---- whitelist enforcement -------------------------------------------------

func TestTranslate_RejectsTemplatesOutsideWhitelist(t *testing.T) {
	hostile := []string{
		`{"template":"drop_all_tables","params":{"window_days":7,"limit":5},"reasoning":"x"}`,
		`{"template":"SELECT * FROM subscribers","params":{},"reasoning":"x"}`,
		`{"template":"top_campaigns_by_opens; DELETE FROM campaigns","params":{},"reasoning":"x"}`,
		`{"template":"","params":{},"reasoning":"x"}`,
	}
	for _, resp := range hostile {
		out, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{text: resp}, "what happened?")
		if !errors.Is(err, ErrUnknownTemplate) {
			t.Errorf("response %q: err = %v, want ErrUnknownTemplate", resp, err)
		}
		if out != nil && out.Template != nil {
			t.Errorf("response %q: template leaked through: %v", resp, out.Template.ID)
		}
	}
}

func TestTranslate_AcceptsEveryWhitelistedTemplate(t *testing.T) {
	for _, id := range TemplateIDs() {
		resp := `{"template":"` + id + `","params":{"window_days":14,"limit":5},"reasoning":"r"}`
		out, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{text: resp}, "q")
		if err != nil {
			t.Fatalf("template %s: %v", id, err)
		}
		if out.Template.ID != id {
			t.Fatalf("template %s: got %s", id, out.Template.ID)
		}
	}
}

func TestTranslate_ClampsParams(t *testing.T) {
	resp := `{"template":"top_campaigns_by_opens","params":{"window_days":5000,"limit":-3},"reasoning":"r"}`
	out, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{text: resp}, "q")
	if err != nil {
		t.Fatal(err)
	}
	if out.Params.WindowDays != maxWindowDays {
		t.Fatalf("window_days = %d, want clamped to %d", out.Params.WindowDays, maxWindowDays)
	}
	if out.Params.Limit != defaultRowLimit {
		t.Fatalf("limit = %d, want default %d", out.Params.Limit, defaultRowLimit)
	}
}

func TestTranslate_StripsJSONFences(t *testing.T) {
	resp := "```json\n{\"template\":\"engagement_overview\",\"params\":{},\"reasoning\":\"r\"}\n```"
	out, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{text: resp}, "q")
	if err != nil {
		t.Fatal(err)
	}
	if out.Template.ID != "engagement_overview" {
		t.Fatalf("template = %s", out.Template.ID)
	}
	// Defaults applied when params absent.
	if out.Params.WindowDays != defaultWindowDays || out.Params.Limit != defaultRowLimit {
		t.Fatalf("params = %+v", out.Params)
	}
}

func TestTranslate_MalformedJSON(t *testing.T) {
	_, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{text: "Sure! The best template is opens."}, "q")
	if err == nil || !strings.Contains(err.Error(), "malformed llm json") {
		t.Fatalf("err = %v, want malformed llm json", err)
	}
}

func TestTranslate_EmptyQuestionAndNilLLM(t *testing.T) {
	if _, err := TranslateAnalyticsQuestion(context.Background(), &fakeLLM{}, "   "); err == nil {
		t.Fatal("empty question should error")
	}
	if _, err := TranslateAnalyticsQuestion(context.Background(), nil, "q"); err == nil {
		t.Fatal("nil llm should error")
	}
}

// ---- registry invariants ----------------------------------------------------

func TestTemplateRegistry_Invariants(t *testing.T) {
	if len(analyticsTemplates) < 8 {
		t.Fatalf("registry has %d templates, want >= 8", len(analyticsTemplates))
	}
	seen := map[string]bool{}
	for _, tpl := range analyticsTemplates {
		if seen[tpl.ID] {
			t.Errorf("duplicate template id %s", tpl.ID)
		}
		seen[tpl.ID] = true
		if tpl.AnswerKind != "table" && tpl.AnswerKind != "summary" {
			t.Errorf("%s: answer kind %q", tpl.ID, tpl.AnswerKind)
		}
		// Every template is tenant-scoped and window-bounded.
		if !strings.Contains(tpl.SQL, "$1::uuid") {
			t.Errorf("%s: missing tenant parameter", tpl.ID)
		}
		if !strings.Contains(tpl.SQL, "$2") {
			t.Errorf("%s: missing window parameter", tpl.ID)
		}
		if tpl.NeedsLimit != strings.Contains(tpl.SQL, "$3") {
			t.Errorf("%s: NeedsLimit=%v inconsistent with SQL params", tpl.ID, tpl.NeedsLimit)
		}
	}
}

func TestRevenueTemplatesKeepCurrenciesSeparate(t *testing.T) {
	for _, id := range []string{"top_campaigns_by_revenue", "revenue_summary"} {
		tpl := templateByID(id)
		if tpl == nil {
			t.Fatalf("missing template %s", id)
		}
		sql := strings.ToLower(tpl.SQL)
		if !strings.Contains(sql, "currency") ||
			!strings.Contains(sql, "group by") {
			t.Fatalf("%s can combine currencies: %s", id, tpl.SQL)
		}
	}
	if templateByID("revenue_summary").AnswerKind != "table" {
		t.Fatal("currency-separated revenue summary must render as a table")
	}
}

func TestDeliverabilityTemplateOnlyPromisesReturnedEvidence(t *testing.T) {
	tpl := templateByID("deliverability_summary")
	if tpl == nil {
		t.Fatal("missing deliverability_summary template")
	}
	description := strings.ToLower(tpl.Description)
	for _, unavailable := range []string{"rate", "delivered"} {
		if strings.Contains(description, unavailable) {
			t.Errorf(
				"description promises unavailable %q evidence: %q",
				unavailable,
				tpl.Description,
			)
		}
	}
	sql := strings.ToLower(tpl.SQL)
	for _, returned := range []string{
		"as bounces",
		"as complaints",
		"as opens",
		"as campaigns_with_events",
	} {
		if !strings.Contains(sql, returned) {
			t.Errorf("deliverability SQL does not return %q: %s", returned, tpl.SQL)
		}
	}

	summary := strings.ToLower(summarizeAnalyticsRows(
		tpl,
		AnalyticsParams{WindowDays: 30},
		[]map[string]any{{
			"bounces":               int64(2),
			"complaints":            int64(1),
			"opens":                 int64(8),
			"campaigns_with_events": int64(3),
		}},
	))
	for _, unavailable := range []string{"rate", "delivered"} {
		if strings.Contains(summary, unavailable) {
			t.Errorf("summary promises unavailable %q evidence: %q", unavailable, summary)
		}
	}
}

func TestSummarizeAnalyticsRowsIsLocalAndDataMinimized(t *testing.T) {
	params := AnalyticsParams{WindowDays: 30, Limit: 10}
	summary := summarizeAnalyticsRows(
		templateByID("top_campaigns_by_revenue"),
		params,
		[]map[string]any{{
			"campaign_name": "client-secret-campaign",
			"currency":      "USD",
			"revenue_cents": int64(12_345),
		}},
	)
	if strings.Contains(summary, "client-secret-campaign") ||
		strings.Contains(summary, "12345") {
		t.Fatalf("row evidence leaked into summary: %q", summary)
	}
	if !strings.Contains(summary, "separated by currency") {
		t.Fatalf("currency boundary missing from summary: %q", summary)
	}
	if got := summarizeAnalyticsRows(
		templateByID("engagement_overview"),
		params,
		nil,
	); !strings.Contains(got, "No data matched") {
		t.Fatalf("empty summary = %q", got)
	}
}

func TestTemplateByID_NormalizesAndRejects(t *testing.T) {
	if tpl := templateByID("  Top_Campaigns_By_Opens "); tpl == nil || tpl.ID != "top_campaigns_by_opens" {
		t.Fatal("case/space-insensitive lookup failed")
	}
	if templateByID("nope") != nil {
		t.Fatal("unknown id must return nil")
	}
}

// ---- handler validation -------------------------------------------------------

func nlqRequest(t *testing.T, body string, withTenant bool) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/nlq", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if withTenant {
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	}
	return req
}

func TestQueryNLQ_RequiresTenant(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	rec := httptest.NewRecorder()
	d.queryNLQ(rec, nlqRequest(t, `{"question":"q"}`, false))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestQueryNLQ_503WithoutLLM(t *testing.T) {
	d := &AnalyticsDeps{}
	rec := httptest.NewRecorder()
	d.queryNLQ(rec, nlqRequest(t, `{"question":"q"}`, true))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestQueryNLQ_ValidatesQuestion(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{}}
	cases := map[string]string{
		"empty":    `{"question":"  "}`,
		"too long": `{"question":"` + strings.Repeat("a", questionMaxLen+1) + `"}`,
		"bad json": `{"question":`,
	}
	for name, body := range cases {
		rec := httptest.NewRecorder()
		d.queryNLQ(rec, nlqRequest(t, body, true))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rec.Code)
		}
	}
}

func TestQueryNLQ_LimitsUnicodeCodePointsNotUTF8Bytes(t *testing.T) {
	withinLimitLLM := &fakeLLM{
		text: `{"template":"made_up","params":{},"reasoning":"r"}`,
	}
	withinLimit := strings.Repeat("界", questionMaxLen)
	rec := httptest.NewRecorder()
	(&AnalyticsDeps{LLM: withinLimitLLM}).queryNLQ(
		rec,
		nlqRequest(t, `{"question":"`+withinLimit+`"}`, true),
	)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf(
			"%d multibyte characters: status = %d, want 422 after validation; body=%s",
			questionMaxLen,
			rec.Code,
			rec.Body.String(),
		)
	}
	if len(withinLimitLLM.calls) != 1 {
		t.Fatalf(
			"%d multibyte characters: LLM calls = %d, want 1",
			questionMaxLen,
			len(withinLimitLLM.calls),
		)
	}

	overLimitLLM := &fakeLLM{
		text: `{"template":"made_up","params":{},"reasoning":"r"}`,
	}
	overLimit := strings.Repeat("界", questionMaxLen+1)
	rec = httptest.NewRecorder()
	(&AnalyticsDeps{LLM: overLimitLLM}).queryNLQ(
		rec,
		nlqRequest(t, `{"question":"`+overLimit+`"}`, true),
	)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf(
			"%d multibyte characters: status = %d, want 400; body=%s",
			questionMaxLen+1,
			rec.Code,
			rec.Body.String(),
		)
	}
	if !strings.Contains(rec.Body.String(), "question_too_long") {
		t.Fatalf("over-limit response lacks stable code: %s", rec.Body.String())
	}
	if len(overLimitLLM.calls) != 0 {
		t.Fatalf("over-limit question reached LLM %d time(s)", len(overLimitLLM.calls))
	}
}

// TestQueryNLQ_InvalidTemplate422: a hallucinated template id is
// refused with 422 invalid_template — and crucially, before any SQL
// would run (Pool is nil here; reaching the DB would panic).
func TestQueryNLQ_InvalidTemplate422(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{text: `{"template":"made_up","params":{},"reasoning":"r"}`}}
	rec := httptest.NewRecorder()
	d.queryNLQ(rec, nlqRequest(t, `{"question":"how are my campaigns?"}`, true))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_template") {
		t.Fatalf("body = %s, want invalid_template code", rec.Body.String())
	}
}

// TestQueryNLQ_LLMErrorNotEchoed: upstream LLM failures route through
// the safe-echo gate — non-allowlisted codes become the generic 500
// envelope and never leak the raw upstream error text.
func TestQueryNLQ_LLMErrorNotEchoed(t *testing.T) {
	d := &AnalyticsDeps{LLM: &fakeLLM{err: errors.New("anthropic: 429 secret-internal-detail")}}
	rec := httptest.NewRecorder()
	d.queryNLQ(rec, nlqRequest(t, `{"question":"q"}`, true))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secret-internal-detail") {
		t.Fatalf("upstream error leaked: %s", rec.Body.String())
	}
}
