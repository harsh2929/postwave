// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-function tests for the apikeycalls package. The DB-touching
// paths (Insert / List / GetStats) live in a separate _db_test.go
// guarded by DATABASE_URL skip; this file covers everything we can
// exercise without a Postgres connection.

package apikeycalls

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type countingQuotaChecker struct{ calls int }

func (q *countingQuotaChecker) CheckQuota(context.Context, string, string) (bool, int, int, error) {
	q.calls++
	return true, 1, 1, nil
}

func TestLegacyHTTPQuotaMiddlewareCannotBlockOrConsultStaleRows(t *testing.T) {
	checker := &countingQuotaChecker{}
	called := false
	handler := QuotaMiddleware(checker)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/campaigns", http.NoBody))
	if !called || response.Code != http.StatusNoContent {
		t.Fatalf("held quota middleware blocked request: called=%v status=%d", called, response.Code)
	}
	if checker.calls != 0 {
		t.Fatalf("held quota middleware consulted advisory rows %d times", checker.calls)
	}
}

func TestIsMCP(t *testing.T) {
	cases := []struct {
		name string
		ua   string
		want bool
	}{
		{"empty", "", false},
		{"unknown agent", "curl/8.0", false},
		{"mcp lowercase exact prefix", "postwave-mcp-server/0.1.0", true},
		{"mcp with extra suffix", "postwave-mcp-server/1.2.3 (claude-code/0.5)", true},
		{"mcp uppercase variant", "POSTWAVE-MCP-SERVER/0.1.0", true},
		{"mcp mixed case", "Moosewave-MCP-Server/0.1.0", true},
		{"close but not quite — missing slash", "postwave-mcp-server", false},
		{"different prefix entirely", "postwave/0.1.0", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsMCP(tc.ua); got != tc.want {
				t.Errorf("IsMCP(%q) = %v, want %v", tc.ua, got, tc.want)
			}
		})
	}
}

func TestDeriveToolName(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		want   string
	}{
		{"empty path", "GET", "", ""},
		{"root path", "GET", "/", ""},
		{"api/v1 prefix stripped", "GET", "/api/v1/subscribers", "get:subscribers"},
		{"api/public prefix stripped", "POST", "/api/public/forms/abc", "post:forms"},
		{"api/ generic prefix stripped", "GET", "/api/healthz", "get:healthz"},
		{"first segment kept, rest dropped", "PATCH", "/api/v1/campaigns/123/queue", "patch:campaigns"},
		{"no method downcased", "DELETE", "/api/v1/sequences/abc", "delete:sequences"},
		{"method whitespace tolerated", "  POST  ", "/api/v1/subscribers", "post:subscribers"},
		{"empty method falls through to path only", "", "/api/v1/forms", "forms"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DeriveToolName(tc.method, tc.path); got != tc.want {
				t.Errorf("DeriveToolName(%q,%q) = %q, want %q", tc.method, tc.path, got, tc.want)
			}
		})
	}
}

func TestStatusWriter_DefaultsTo200(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{ResponseWriter: rec, status: 200}
	if _, err := sw.Write([]byte("ok")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if sw.status != 200 {
		t.Errorf("status = %d, want 200 (implicit)", sw.status)
	}
}

func TestStatusWriter_CapturesExplicitWriteHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{ResponseWriter: rec, status: 200}
	sw.WriteHeader(418)
	if sw.status != 418 {
		t.Errorf("status = %d, want 418", sw.status)
	}
}

func TestStatusWriter_IgnoresSecondHeader(t *testing.T) {
	// A double WriteHeader is the standard Go "superfluous response.WriteHeader"
	// warning; the wrapper must NOT silently update the status the second time
	// either — the dashboard would lie about what the upstream actually sent.
	rec := httptest.NewRecorder()
	sw := &statusWriter{ResponseWriter: rec, status: 200}
	sw.WriteHeader(503)
	sw.WriteHeader(200)
	if sw.status != 503 {
		t.Errorf("status = %d, want 503 (first write wins)", sw.status)
	}
}

func TestCapLen(t *testing.T) {
	if got := capLen("abc", 5); got != "abc" {
		t.Errorf("under-cap: got %q", got)
	}
	if got := capLen("abcdef", 3); got != "abc" {
		t.Errorf("over-cap: got %q want %q", got, "abc")
	}
	if got := capLen("", 5); got != "" {
		t.Errorf("empty: got %q", got)
	}
}

func TestClientIP(t *testing.T) {
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	_ = middleware.SetTrustedProxyCIDRs(nil)
	mk := func(remote, xff string) string {
		r := httptest.NewRequest("GET", "/x", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return clientIP(r)
	}
	if got := mk("1.2.3.4:5678", ""); got != "1.2.3.4" {
		t.Errorf("remote: got %q want %q", got, "1.2.3.4")
	}
	if got := mk("1.2.3.4:5678", "5.6.7.8, 9.10.11.12"); got != "1.2.3.4" {
		t.Errorf("untrusted xff: got %q want peer %q", got, "1.2.3.4")
	}
	if err := middleware.SetTrustedProxyCIDRs([]string{"1.2.3.4/32", "9.10.11.12/32"}); err != nil {
		t.Fatal(err)
	}
	if got := mk("1.2.3.4:5678", "5.6.7.8, 9.10.11.12"); got != "5.6.7.8" {
		t.Errorf("trusted proxy chain: got %q want %q", got, "5.6.7.8")
	}
	if got := mk("", ""); got != "" {
		t.Errorf("no info: got %q", got)
	}
}

func TestParseWindow(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // string form to avoid time.Duration formatting noise
	}{
		{"empty falls back", "", "168h0m0s"}, // 7d default
		{"7d shorthand", "7d", "168h0m0s"},
		{"24h shorthand", "24h", "24h0m0s"},
		{"30d shorthand", "30d", "720h0m0s"},
		{"too short clamps to fallback", "1m", "168h0m0s"},
		{"too long clamps high", "365d", "2160h0m0s"}, // 90d max
		{"garbage falls back", "purple", "168h0m0s"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseWindow(tc.raw, fallback168h()).String()
			if got != tc.want {
				t.Errorf("parseWindow(%q) = %s, want %s", tc.raw, got, tc.want)
			}
		})
	}
}

func TestParseExecutionListFilterUntilUsesStrictRFC3339AndLimitPlusOne(t *testing.T) {
	until := "2026-08-20T10:30:00Z"
	filter, pageLimit, err := parseExecutionListFilter("tenant-1", url.Values{
		"until": {until},
		"limit": {"17"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if filter.Until == nil || filter.Until.UTC().Format(time.RFC3339) != until || pageLimit != 17 || filter.Limit != 18 {
		t.Fatalf("filter=%+v pageLimit=%d", filter, pageLimit)
	}
	for _, invalid := range []string{"tomorrow", "2026-08-20", ""} {
		values := url.Values{"until": {invalid}}
		if invalid == "" {
			values = url.Values{"until": {"", "2026-08-20T10:30:00Z"}}
		}
		if _, _, err := parseExecutionListFilter("tenant-1", values); err == nil {
			t.Fatalf("invalid until %q accepted", invalid)
		}
	}
}

// fallback168h returns the canonical 7d fallback used by parseWindow
// callers. Defined inline so the test doesn't need to import time.
func fallback168h() time.Duration { return 168 * time.Hour }

func TestIsTruthyHeader(t *testing.T) {
	truthy := []string{"1", "true", "yes", "on", "True", "TRUE", " 1 ", "Yes"}
	falsy := []string{"", "0", "false", "no", "off", "2", "tru", "foo"}
	for _, v := range truthy {
		if !isTruthyHeader(v) {
			t.Errorf("isTruthyHeader(%q) = false, want true", v)
		}
	}
	for _, v := range falsy {
		if isTruthyHeader(v) {
			t.Errorf("isTruthyHeader(%q) = true, want false", v)
		}
	}
}

func TestRedactSecretKeys(t *testing.T) {
	obj := map[string]any{
		"email":    "alice@example.com",
		"password": "hunter2",
		"api_key":  "pw_abc",
		"nested": map[string]any{
			"signing_key": "ssk_xyz",
			"name":        "Alice",
		},
		"creds_list": []any{
			map[string]any{"token": "t1", "label": "ci"},
		},
	}
	redactSecretKeys(obj)
	if obj["password"] != "***redacted***" {
		t.Errorf("password not redacted: %v", obj["password"])
	}
	if obj["api_key"] != "***redacted***" {
		t.Errorf("api_key not redacted: %v", obj["api_key"])
	}
	if obj["email"] != "alice@example.com" {
		t.Errorf("email accidentally redacted: %v", obj["email"])
	}
	if nested, ok := obj["nested"].(map[string]any); ok {
		if nested["signing_key"] != "***redacted***" {
			t.Errorf("nested signing_key not redacted: %v", nested["signing_key"])
		}
		if nested["name"] != "Alice" {
			t.Errorf("nested name accidentally redacted: %v", nested["name"])
		}
	} else {
		t.Fatal("nested not map")
	}
	if list, ok := obj["creds_list"].([]any); ok && len(list) > 0 {
		if inner, ok := list[0].(map[string]any); ok {
			if inner["token"] != "***redacted***" {
				t.Errorf("array-nested token not redacted: %v", inner["token"])
			}
			if inner["label"] != "ci" {
				t.Errorf("array-nested label accidentally redacted: %v", inner["label"])
			}
		}
	}
}

func TestCaptureJSONBodyRetainsShapeOnly(t *testing.T) {
	body := `{"email":"a@x.com","password":"hunter2","subject":"hi"}`
	r := httptest.NewRequest("POST", "/api/v1/foo", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.ContentLength = int64(len(body))
	capture := attachJSONBodyCapture(r)
	echoed, _ := io.ReadAll(r.Body)
	got := capture.Result()
	if got == nil {
		t.Fatal("captureJSONBody returned nil for a valid JSON body")
	}
	for _, value := range []string{"hunter2", "a@x.com", "hi"} {
		if strings.Contains(string(got), value) {
			t.Errorf("caller value %q leaked into shape-only capture: %s", value, string(got))
		}
	}
	for _, key := range []string{"email", "password", "subject"} {
		if strings.Contains(string(got), key) {
			t.Errorf("shape summary leaked arbitrary key %q: %s", key, string(got))
		}
	}
	if !strings.Contains(string(got), `"key_count":3`) {
		t.Errorf("shape summary omitted safe key count: %s", string(got))
	}
	// And the request body must still be readable by the downstream
	// handler — we replaced r.Body with a fresh reader.
	if string(echoed) != body {
		t.Errorf("downstream body altered: got %q want %q", echoed, body)
	}
}

func TestCaptureJSONBodyNeverPersistsRootArrayOrScalarValues(t *testing.T) {
	for _, body := range []string{`["secret-value",{"token":"nested-secret"}]`, `"root-secret"`, `42`, `true`} {
		r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		capture := attachJSONBodyCapture(r)
		_, _ = io.ReadAll(r.Body)
		got := capture.Result()
		if len(got) == 0 || strings.Contains(string(got), "secret") || strings.Contains(string(got), "42") {
			t.Fatalf("body %s produced unsafe summary %s", body, got)
		}
	}
}

func TestCaptureJSONBodyNeverPersistsValuesEncodedAsObjectKeys(t *testing.T) {
	body := `{"person@example.test":"value","550e8400-e29b-41d4-a716-446655440000":"value","+15551234567":"value"}`
	r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	capture := attachJSONBodyCapture(r)
	_, _ = io.ReadAll(r.Body)
	got := string(capture.Result())
	for _, forbidden := range []string{"person@example.test", "550e8400", "+1555"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("shape summary leaked value-as-key %q: %s", forbidden, got)
		}
	}
	if !strings.Contains(got, `"key_count":3`) {
		t.Fatalf("shape summary=%s", got)
	}
}

func TestQuerySummaryStoresCountNotCallerControlledNames(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/x?person%40example.test=1&550e8400-e29b-41d4-a716-446655440000=2", nil)
	if got := queryKeySummary(r); got != "key_count=2" {
		t.Fatalf("query summary=%q", got)
	}
}

func TestUserAgentProductAndCallerToolLabelHaveClosedCardinality(t *testing.T) {
	if got := userAgentProduct("postwave-mcp-server/1.2.3 private-fingerprint"); got != "postwave-mcp-server/1.2.3" {
		t.Fatalf("official UA=%q", got)
	}
	for _, ua := range []string{"curl/person@example.test", "postwave-mcp-server/private-id", "postwave-mcp-server/1.2.3.4"} {
		if got := userAgentProduct(ua); got != "other" {
			t.Fatalf("untrusted UA %q persisted as %q", ua, got)
		}
	}
	for _, tool := range []string{"person@example.test", "550e8400-e29b-41d4-a716-446655440000", "999999999999"} {
		if got := safeCallerToolLabel(tool); got != "" {
			t.Fatalf("untrusted tool %q persisted as %q", tool, got)
		}
	}
}

func TestCaptureJSONBody_SkipsNonJSON(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", strings.NewReader("just text"))
	r.Header.Set("Content-Type", "text/plain")
	r.ContentLength = 9
	if got := attachJSONBodyCapture(r); got != nil {
		t.Errorf("non-JSON body should not be captured")
	}
}

func TestCaptureJSONBody_EmptyBody(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	if got := attachJSONBodyCapture(r); got != nil {
		t.Errorf("empty body should be nil")
	}
}

func TestJSONBodyCaptureStreamsOversizedBodyWithoutRetainingPrefix(t *testing.T) {
	body := `{"password":"` + strings.Repeat("x", MaxRequestBodyCapture) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	capture := attachJSONBodyCapture(r)
	echoed, err := io.ReadAll(r.Body)
	if err != nil || string(echoed) != body {
		t.Fatalf("downstream body changed: err=%v len=%d", err, len(echoed))
	}
	got := capture.Result()
	if !strings.Contains(string(got), `"_truncated":true`) {
		t.Fatalf("capture = %s, want truncated summary", got)
	}
	if strings.Contains(string(got), strings.Repeat("x", 16)) {
		t.Fatalf("oversized secret prefix leaked: %s", got)
	}
}

// Ensure the catalog JSON the handler serves is valid.
func TestCatalogJSONIsParseable(t *testing.T) {
	if len(CatalogJSON) == 0 {
		t.Fatal("CatalogJSON empty — was tool-catalog.json bundled?")
	}
	// Cheap structural check: the catalog is a JSON array.
	first := strings.TrimSpace(string(CatalogJSON[:min(len(CatalogJSON), 4)]))
	if !strings.HasPrefix(first, "[") {
		t.Errorf("catalog does not start with '[': %q", first)
	}
}

func TestCatalogHandlerLabelsBuildCandidateProvenance(t *testing.T) {
	response := httptest.NewRecorder()
	(&Deps{}).GetCatalog(response, httptest.NewRequest(http.MethodGet, "/api/v1/mcp/catalog", http.NoBody))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("X-Postwave-Catalog-Provenance"); got != "api-build-candidate" {
		t.Fatalf("provenance=%q", got)
	}
	if got := response.Header().Get("X-Postwave-Catalog-Digest"); !strings.HasPrefix(got, "sha256:") || len(got) != len("sha256:")+64 {
		t.Fatalf("digest=%q", got)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if got := response.Header().Get("X-Postwave-Catalog-Tool-Count"); got != strconv.Itoa(len(entries)) || len(entries) == 0 {
		t.Fatalf("header count=%q decoded=%d", got, len(entries))
	}
	if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("cache control=%q", got)
	}
}

func TestMinimizeStoredPathNeverReturnsHistoricalIdentifiers(t *testing.T) {
	tests := map[string]string{
		"/resource/550e8400-e29b-41d4-a716-446655440000":           "/resource/*",
		"/resource/pw_live_secret-token":                           "/resource/*",
		"/api/v1/subscribers/550e8400-e29b-41d4-a716-446655440000": "/api/v1/subscribers/*",
		"/api/public/forms/private-slug/submit":                    "/api/public/forms/*",
		"/api/v1/subscribers/{id}":                                 "/api/v1/subscribers/*",
		"/api/v1/foo/{person@example.test}":                        "/api/v1/foo/*",
		"/api/v1/{pw_secret}":                                      "/api/v1/*",
		"/healthz":                                                 "/healthz",
	}
	for input, want := range tests {
		if got := minimizeStoredPath(input); got != want {
			t.Errorf("minimizeStoredPath(%q)=%q want=%q", input, got, want)
		}
	}
}

func TestHistoricalCallProjectionDropsUnsafeDiagnosticAndToolLabels(t *testing.T) {
	call := &Call{
		Path:         "/api/v1/foo/{person@example.test}",
		ToolName:     "550e8400-e29b-41d4-a716-446655440000",
		ErrorCode:    "person@example.test Authorization: Bearer pw_secret",
		APIKeyPrefix: "pw_live_abcd_full-secret-tail",
		UserAgent:    "postwave-mcp-server/garbage",
		RemoteIP:     "203.0.113.8",
	}
	minimizeCallForResponse(call)
	if call.Path != "/api/v1/foo/*" || call.ToolName != "" || call.ErrorCode != "" || call.APIKeyPrefix != "" || call.UserAgent != "other" || call.RemoteIP != "" {
		t.Fatalf("unsafe historical projection=%+v", call)
	}
	if got := safeDiagnosticCode("invalid_query"); got != "invalid_query" {
		t.Fatalf("stable diagnostic code removed: %q", got)
	}
	if got := safeAPIKeyPrefix("pw_live_abcd"); got != "pw_live_abcd" {
		t.Fatalf("valid visible key prefix removed: %q", got)
	}
}

func TestNormalizedKeyFrequencyDerivesOnlySafeDisplayIdentity(t *testing.T) {
	id := "550e8400-e29b-41d4-a716-446655440000"
	tests := []struct {
		name   string
		id     *string
		prefix string
		keep   bool
		wantID bool
		want   string
	}{
		{name: "live joined prefix", id: &id, prefix: "pw_live_a1b2", keep: true, wantID: true, want: "pw_live_a1b2"},
		{name: "id-only anomaly omitted", id: &id, keep: false, wantID: true},
		{name: "legacy frozen prefix", prefix: "pw_live_c3d4", keep: true, want: "pw_live_c3d4"},
		{name: "unsafe prefix with id", id: &id, prefix: "pw_live_a1b2_private_tail", keep: false, wantID: true},
		{name: "no safe identity", prefix: "private", keep: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := normalizedKeyFrequency(tc.id, tc.prefix, 7)
			if ok != tc.keep || (got.APIKeyID != nil) != tc.wantID || got.APIKeyPrefix != tc.want || got.Calls != 7 {
				t.Fatalf("normalized=%+v keep=%v", got, ok)
			}
		})
	}
}

func TestTenantBoundAggregateEnvelopesIncludeCanonicalIdentity(t *testing.T) {
	executions, err := json.Marshal(ExecutionListResponse{TenantID: "tenant-1", Rows: []Call{}})
	if err != nil || !strings.Contains(string(executions), `"tenantId":"tenant-1"`) || !strings.Contains(string(executions), `"rows":[]`) {
		t.Fatalf("executions tenant binding: err=%v json=%s", err, executions)
	}
	stats, err := json.Marshal(Stats{TenantID: "tenant-1"})
	if err != nil || !strings.Contains(string(stats), `"tenantId":"tenant-1"`) {
		t.Fatalf("stats tenant binding: err=%v json=%s", err, stats)
	}
	trend, err := json.Marshal(TrendResponse{TenantID: "tenant-1", Points: []TrendPoint{}})
	if err != nil || !strings.Contains(string(trend), `"tenantId":"tenant-1"`) {
		t.Fatalf("trend tenant binding: err=%v json=%s", err, trend)
	}
	quotas, err := json.Marshal(QuotaResponse{TenantID: "tenant-1", Quotas: []ToolQuota{}})
	if err != nil || !strings.Contains(string(quotas), `"tenantId":"tenant-1"`) {
		t.Fatalf("quotas tenant binding: err=%v json=%s", err, quotas)
	}
}

func TestStreamReadFailureEmitsTypedTerminalEvent(t *testing.T) {
	var output strings.Builder
	if _, err := writeStreamUnavailable(&output); err != nil {
		t.Fatal(err)
	}
	want := "event: unavailable\ndata: {\"code\":\"stream_read_unavailable\",\"retryable\":true}\n\n"
	if output.String() != want {
		t.Fatalf("event=%q want=%q", output.String(), want)
	}
}

func TestExecutionStreamDeadlineCannotOutliveURLCredential(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	now := time.Now().UTC().Truncate(time.Second)
	token, err := apikeys.IssueStreamToken(secret, apikeys.StreamTokenClaims{
		TenantID: "tenant-1", Scopes: []apikeys.Scope{apikeys.ScopeAdmin},
	}, now, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var gotDeadline time.Time
	var gotReason string
	handler := apikeys.MiddlewareWithOptions(nil, nil, apikeys.MiddlewareOptions{StreamTokenSecret: secret})(
		http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
			gotDeadline, gotReason = executionStreamDeadline(request.Context(), now)
		}),
	)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(
		http.MethodGet, "/api/v1/mcp/executions/stream?stream_token="+url.QueryEscape(token), http.NoBody,
	))
	if want := now.Add(30 * time.Second); !gotDeadline.Equal(want) || gotReason != "credential_expired" {
		t.Fatalf("deadline=%s reason=%q want=%s credential_expired", gotDeadline, gotReason, want)
	}
	var event strings.Builder
	if _, err := writeStreamClosed(&event, gotReason); err != nil {
		t.Fatal(err)
	}
	if event.String() != "event: closed\ndata: {\"reason\":\"credential_expired\"}\n\n" {
		t.Fatalf("terminal event=%q", event.String())
	}
}

func TestExecutionStreamDeadlineBoundsEveryAuthenticationMode(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	deadline, reason := executionStreamDeadline(context.Background(), now)
	if want := now.Add(StreamMaxDuration); !deadline.Equal(want) || reason != "max_duration" {
		t.Fatalf("deadline=%s reason=%q want=%s max_duration", deadline, reason, want)
	}
}

func TestExecutionStreamRejectsUnknownOrUnsafeFiltersBeforeStorage(t *testing.T) {
	for _, rawQuery := range []string{
		"unknown=value",
		"tool=550e8400-e29b-41d4-a716-446655440000",
		"tool=reports_list&tool=campaigns_list",
		"include=everything",
	} {
		t.Run(rawQuery, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/mcp/executions/stream?"+rawQuery, http.NoBody)
			request = request.WithContext(middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"}))
			response := httptest.NewRecorder()
			new(Deps).StreamExecutions(response, request)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_query"`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Fatalf("cache control=%q", got)
			}
		})
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
