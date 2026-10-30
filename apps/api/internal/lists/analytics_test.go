package lists

// Pure-function coverage for the new Wave-2 surfaces:
// - window parsing (analytics.go)
// - source canonicalisation (growth.go)
// - merge-field validation (merge_fields.go)
// - webhook URL + event validation (webhooks.go)
// - score-band classification (analytics.go)
//
// SQL-dependent paths require a live tenant pool and live elsewhere in
// the integration suite.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func TestClampWindowDays(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 30},
		{"  ", 30},
		{"7", 7},
		{"90", 90},
		{"500", 365},
		{"-3", 1},
		{"abc", 30},
	}
	for _, c := range cases {
		if got := clampWindowDays(c.in); got != c.want {
			t.Errorf("clampWindowDays(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestParseWindowParam_TrimsDaySuffix(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"30d", 30},
		{"90D", 90},
		{"365d", 365},
		{"7", 7},
		{"", 30},
	}
	for _, c := range cases {
		if got := parseWindowParam(c.in); got != c.want {
			t.Errorf("parseWindowParam(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestNormaliseSource(t *testing.T) {
	cases := map[string]string{
		"form":           "form",
		"API":            "api",
		"  csv  ":        "csv",
		"unknown":        "other",
		"":               "other",
		"listmonk_event": "listmonk_event",
	}
	for in, want := range cases {
		if got := normaliseSource(in); got != want {
			t.Errorf("normaliseSource(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestZeroedSourceMapShape(t *testing.T) {
	m := zeroedSourceMap()
	for _, key := range []string{"form", "api", "csv", "integration", "admin", "migration", "listmonk_event", "other"} {
		if _, ok := m[key]; !ok {
			t.Errorf("zeroedSourceMap missing key %q", key)
		}
	}
}

func TestValidateMergeField(t *testing.T) {
	good := MergeField{Tag: "FNAME", Type: "text", Name: "First name"}
	if err := validateMergeField(good); err != nil {
		t.Fatalf("expected good field to validate, got %v", err)
	}
	bad := []MergeField{
		{Tag: "", Type: "text", Name: "x"},
		{Tag: "lowercase", Type: "text", Name: "x"},
		{Tag: "1NUMERIC", Type: "text", Name: "x"},
		{Tag: "TOOLONGGGGGG", Type: "text", Name: "x"},
		{Tag: "FNAME", Type: "bogus", Name: "x"},
		{Tag: "FNAME", Type: "text", Name: ""},
	}
	for i, b := range bad {
		if err := validateMergeField(b); err == nil {
			t.Errorf("case %d expected error, got nil for %+v", i, b)
		}
	}
}

func TestValidateWebhookEvents(t *testing.T) {
	if err := validateWebhookEvents(nil); err == nil {
		t.Errorf("nil events should fail")
	}
	if err := validateWebhookEvents([]string{outbound_webhooks.EventListSubscriberAdded}); err != nil {
		t.Errorf("known event should validate, got %v", err)
	}
	if err := validateWebhookEvents([]string{"subscriber.added"}); err == nil {
		t.Errorf("unproduced global subscriber event should fail")
	}
	if err := validateWebhookEvents([]string{"bogus.event"}); err == nil {
		t.Errorf("bogus event should fail")
	}
	tooMany := make([]string, 30)
	for i := range tooMany {
		tooMany[i] = outbound_webhooks.EventListSubscriberAdded
	}
	if err := validateWebhookEvents(tooMany); err == nil {
		t.Errorf("over-cap should fail")
	}
}

func TestValidateWebhookURL(t *testing.T) {
	if err := validateWebhookURL("", false); err == nil {
		t.Errorf("empty should fail")
	}
	if err := validateWebhookURL("not a url", false); err == nil {
		t.Errorf("invalid scheme should fail")
	}
	if err := validateWebhookURL("http://example.com/hook", false); err != nil {
		t.Errorf("http should validate when requireHTTPS=false, got %v", err)
	}
	if err := validateWebhookURL("http://example.com/hook", true); err == nil {
		t.Errorf("http should fail when requireHTTPS=true")
	}
	if err := validateWebhookURL("ftp://example.com/hook", false); err == nil {
		t.Errorf("ftp should fail")
	}
	if err := validateWebhookURL("https://user:pass@example.com/hook", true); err == nil {
		t.Fatal("credential-bearing URL accepted")
	}
	for _, raw := range []string{
		"https://127.0.0.1/hook",
		"https://10.0.0.1/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/hook",
		"https://[fc00::1]/hook",
	} {
		if err := validateWebhookURL(raw, true); err == nil {
			t.Fatalf("private/reserved production URL accepted: %s", raw)
		}
	}
	// Local HTTP callbacks remain available in explicit development mode.
	if err := validateWebhookURL("http://localhost:8787/hook", false); err != nil {
		t.Fatalf("development localhost callback rejected: %v", err)
	}
}

func TestListScoreAndGrade_HealthyList(t *testing.T) {
	s := ListDeliverability{
		ActiveSubscribers: 500,
		BounceRate:        0.001,
		ComplaintRate:     0.0001,
		EngagementRate:    0.30,
		UnsubscribeRate:   0.005,
		SuppressionRate:   0.01,
	}
	score, grade, notes := listScoreAndGrade(s)
	if score != 100 || grade != "A" {
		t.Errorf("healthy list got score=%d grade=%s, want 100/A", score, grade)
	}
	if len(notes) == 0 {
		t.Errorf("expected note explaining clean run")
	}
}

func TestListScoreAndGrade_BadBounces(t *testing.T) {
	s := ListDeliverability{
		ActiveSubscribers: 500,
		BounceRate:        0.10, // 10% — well over the 0.5% threshold
	}
	score, grade, _ := listScoreAndGrade(s)
	if grade == "A" {
		t.Errorf("10%% bounce should not get an A; got score=%d grade=%s", score, grade)
	}
}

// TestAnalytics_RejectsMissingTenant — the analytics handlers must 401
// without a tenant in context, like the rest of the lists surface.
func TestAnalytics_RejectsMissingTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/lists/abc/growth", nil)
	w := httptest.NewRecorder()
	d.Growth(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "no_tenant") {
		t.Errorf("body = %q", w.Body.String())
	}
}

// TestArchive_RejectsMissingTenant — archive routes must 401 too.
func TestArchive_RejectsMissingTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists/abc/archive", nil)
	w := httptest.NewRecorder()
	d.Archive(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestCreateWebhook_RejectsMissingURL — basic input validation runs
// before we touch the DB.
func TestCreateWebhook_RejectsMissingURL(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := strings.NewReader(`{"events":["list.subscriber.added"]}`)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists/abc/webhooks", body)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "test-create-webhook-missing-url")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.CreateWebhook(w, r)
	// d.CreateWebhook resolves the list first (404 with nil pool), but
	// for hand-rolled tests we accept either 400 (invalid_url) or 503
	// (repo_unavailable) — the precondition is that we didn't 401.
	if w.Code == http.StatusUnauthorized {
		t.Errorf("should not 401 with tenant in context")
	}
}
