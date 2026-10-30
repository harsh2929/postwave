// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_alerts_test.go — table-driven unit tests for operator
// evaluation, channel-config validation, and SOC-channel HTTP shapes.
// Database-backed paths (countWindow, rateAndBaseline) are exercised
// in integration tests; here we cover the pure helpers + the HTTP
// surfaces using httptest.Server.

package audit_alerts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateOperatorConfig(t *testing.T) {
	tests := []struct {
		name    string
		kind    string
		config  map[string]any
		wantErr bool
	}{
		{"empty defaults to glob", "", nil, false},
		{"glob is always ok", "glob", nil, false},
		{"threshold_window happy path", "threshold_window",
			map[string]any{"count": 5, "window_min": 5}, false},
		{"threshold_window zero count rejected", "threshold_window",
			map[string]any{"count": 0, "window_min": 5}, true},
		{"threshold_window oversize window rejected", "threshold_window",
			map[string]any{"count": 5, "window_min": 5000}, true},
		{"threshold_window bad group_by rejected", "threshold_window",
			map[string]any{"count": 5, "window_min": 5, "group_by": "actor_ip"}, true},
		{"rate_deviation happy path", "rate_deviation",
			map[string]any{"deviation_pct": 50.0, "baseline_days": 7}, false},
		{"rate_deviation zero pct rejected", "rate_deviation",
			map[string]any{"deviation_pct": 0.0, "baseline_days": 7}, true},
		{"rate_deviation baseline too long rejected", "rate_deviation",
			map[string]any{"deviation_pct": 50.0, "baseline_days": 365}, true},
		{"outlier off_hours ok", "outlier",
			map[string]any{"kind": "off_hours"}, false},
		{"outlier impossible_travel ok", "outlier",
			map[string]any{"kind": "impossible_travel"}, false},
		{"outlier unknown kind rejected", "outlier",
			map[string]any{"kind": "weekend_login"}, true},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := validateOperatorConfig(tc.kind, tc.config)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestValidateChannelConfig(t *testing.T) {
	tests := []struct {
		name    string
		kind    string
		config  map[string]any
		wantErr bool
	}{
		{"email needs to", "email", map[string]any{}, true},
		{"email ok", "email", map[string]any{"to": "sec@acme.com"}, false},
		{"slack bad host", "slack", map[string]any{"webhook_url": "https://evil.example.com/x"}, true},
		{"slack ok", "slack", map[string]any{"webhook_url": "https://hooks.slack.com/services/AAA/BBB/CCC"}, false},
		{"webhook needs https", "webhook", map[string]any{"url": "http://acme.com/hook"}, true},
		{"webhook ok", "webhook", map[string]any{"url": "https://acme.com/hook"}, false},
		{"servicenow needs creds", "servicenow",
			map[string]any{"instance_url": "https://acme.service-now.com"}, true},
		{"servicenow ok with basic", "servicenow",
			map[string]any{
				"instance_url": "https://acme.service-now.com",
				"username":     "u",
				"password":     "p",
			}, false},
		{"jira needs project_key", "jira",
			map[string]any{
				"site_url":  "https://acme.atlassian.net",
				"email":     "e@a.com",
				"api_token": "x",
			}, true},
		{"jira ok", "jira",
			map[string]any{
				"site_url":    "https://acme.atlassian.net",
				"email":       "e@a.com",
				"api_token":   "x",
				"project_key": "SEC",
			}, false},
		{"pagerduty needs routing_key", "pagerduty", map[string]any{}, true},
		{"pagerduty ok", "pagerduty",
			map[string]any{"routing_key": "abcdef1234567890abcdef1234567890"}, false},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := validateChannelConfig(tc.kind, tc.config)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestNormaliseServiceNowState(t *testing.T) {
	cases := map[string]string{
		"1": "open", "2": "in_progress", "3": "in_progress",
		"6": "resolved", "7": "closed", "8": "closed", "99": "",
	}
	for in, want := range cases {
		if got := normaliseServiceNowState(in); got != want {
			t.Errorf("normaliseServiceNowState(%q) = %q want %q", in, got, want)
		}
	}
}

func TestNormaliseJiraCategory(t *testing.T) {
	cases := map[string]string{
		"new": "open", "indeterminate": "in_progress", "done": "resolved",
		"weird": "",
	}
	for in, want := range cases {
		if got := normaliseJiraCategory(in); got != want {
			t.Errorf("normaliseJiraCategory(%q) = %q want %q", in, got, want)
		}
	}
}

func TestGlobToLike(t *testing.T) {
	cases := map[string]string{
		"":                "%",
		"*":               "%",
		"impersonation.*": "impersonation.%",
		"*.deleted":       "%.deleted",
		"foo_bar":         "foo\\_bar",
		"100%":            "100\\%",
		"a*b*c":           "a%b%c",
	}
	for in, want := range cases {
		if got := globToLike(in); got != want {
			t.Errorf("globToLike(%q) = %q want %q", in, got, want)
		}
	}
}

func TestCreatePagerDutyIncident(t *testing.T) {
	var received pagerDutyEvent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &received); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":    "success",
			"dedup_key": received.DedupKey,
		})
	}))
	defer srv.Close()

	// Patch the URL: createPagerDutyIncident hard-codes the events
	// endpoint, so we round-trip through a custom RoundTripper that
	// rewrites the host.
	client := &http.Client{Transport: rewriteTransport{target: srv.URL}}
	env := fireEnvelope{
		RuleID: "rule-1", RuleName: "Failed logins", AuditID: 42,
		Action: "auth.failed", ActorLabel: "alice", ResourceType: "session",
		At: "2026-06-01T00:00:00Z",
	}
	cfg := map[string]any{"routing_key": "rk-test", "severity": "warning"}
	extID, url, err := createPagerDutyIncident(context.Background(), client, cfg, env, "5 events in 5m")
	if err != nil {
		t.Fatalf("createPagerDutyIncident: %v", err)
	}
	if !strings.HasPrefix(extID, "postwave-rule-rule-1-audit-42") {
		t.Errorf("dedup_key=%q lacks expected prefix", extID)
	}
	if !strings.Contains(url, extID) {
		t.Errorf("deep link %q does not contain dedup_key %q", url, extID)
	}
	if received.RoutingKey != "rk-test" {
		t.Errorf("routing_key=%q want rk-test", received.RoutingKey)
	}
	if received.EventAction != "trigger" {
		t.Errorf("event_action=%q want trigger", received.EventAction)
	}
	if received.Payload.Severity != "warning" {
		t.Errorf("severity=%q want warning", received.Payload.Severity)
	}
}

func TestCreateServiceNowIncident(t *testing.T) {
	var gotAuth string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"sys_id": "abc123",
				"number": "INC0010001",
			},
		})
	}))
	defer srv.Close()
	env := fireEnvelope{
		RuleID: "rule-2", RuleName: "Off hours", AuditID: 7,
		Action: "admin.export", ActorLabel: "bob", ResourceType: "tenant",
		At: "2026-06-01T00:00:00Z",
	}
	cfg := map[string]any{
		"instance_url": srv.URL,
		"username":     "svc",
		"password":     "pwd",
	}
	extID, url, err := createServiceNowIncident(context.Background(),
		srv.Client(), cfg, env, "off-hours")
	if err != nil {
		t.Fatalf("createServiceNowIncident: %v", err)
	}
	if extID != "abc123" {
		t.Errorf("extID=%q want abc123", extID)
	}
	if !strings.Contains(url, "incident.do?sys_id=abc123") {
		t.Errorf("deep link missing sys_id: %q", url)
	}
	if !strings.HasPrefix(gotAuth, "Basic ") {
		t.Errorf("expected Basic auth header, got %q", gotAuth)
	}
}

func TestCreateJiraIssue(t *testing.T) {
	var payload map[string]any
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "10001", "key": "SEC-42",
		})
	}))
	defer srv.Close()
	env := fireEnvelope{
		RuleID: "rule-3", RuleName: "Impossible travel", AuditID: 9,
		Action: "auth.login", ActorLabel: "carol",
		At: "2026-06-01T00:00:00Z",
	}
	cfg := map[string]any{
		"site_url":    srv.URL,
		"email":       "e@a.com",
		"api_token":   "tok",
		"project_key": "SEC",
		"issue_type":  "Incident",
	}
	key, url, err := createJiraIssue(context.Background(), srv.Client(), cfg, env, "impossible travel: US,RU")
	if err != nil {
		t.Fatalf("createJiraIssue: %v", err)
	}
	if key != "SEC-42" {
		t.Errorf("key=%q want SEC-42", key)
	}
	if !strings.HasSuffix(url, "/browse/SEC-42") {
		t.Errorf("deep link %q does not end with /browse/SEC-42", url)
	}
	fields, _ := payload["fields"].(map[string]any)
	if fields == nil {
		t.Fatalf("missing fields in payload")
	}
	proj, _ := fields["project"].(map[string]any)
	if proj["key"] != "SEC" {
		t.Errorf("project.key=%v want SEC", proj["key"])
	}
}

func TestEvaluateOperatorGlob(t *testing.T) {
	d := evaluateOperator(context.Background(), nil, "t",
		"impersonation.*", "alice", "glob", nil, time.Now())
	if !d.Fire {
		t.Fatalf("glob operator should always fire when called: %+v", d)
	}
}

func TestEvaluateOperatorOutlierOffHours(t *testing.T) {
	// 03:00 UTC — should fire as off-hours
	d := evaluateOperator(context.Background(), nil, "t",
		"*", "alice", "outlier", map[string]any{"kind": "off_hours"},
		time.Date(2026, 6, 1, 3, 0, 0, 0, time.UTC))
	if !d.Fire {
		t.Fatalf("expected off-hours fire, got %+v", d)
	}
	// 12:00 UTC — should not fire
	d = evaluateOperator(context.Background(), nil, "t",
		"*", "alice", "outlier", map[string]any{"kind": "off_hours"},
		time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC))
	if d.Fire {
		t.Fatalf("expected business-hours no-fire, got %+v", d)
	}
}

func TestEvaluateOperatorUnknown(t *testing.T) {
	d := evaluateOperator(context.Background(), nil, "t",
		"*", "alice", "weird_kind", nil, time.Now())
	if d.Fire {
		t.Fatalf("unknown operator must not fire: %+v", d)
	}
}

func TestHmacSHA256Hex(t *testing.T) {
	// Computed via:
	//   python3 -c "import hmac,hashlib;print(hmac.new(b'topsecret',b'hello',hashlib.sha256).hexdigest())"
	got := hmacSHA256Hex("topsecret", []byte("hello"))
	want := "ed76fd36523b8becda5a3b36d0e3737e8ae5111f55e26c7c3a455a3ce29636d2"
	if got != want {
		t.Errorf("hmac=%q want %q", got, want)
	}
}

// rewriteTransport reroutes any outgoing request to a fixed base URL
// (for hitting the local httptest.Server in place of the hardcoded
// events.pagerduty.com endpoint).
type rewriteTransport struct{ target string }

func (rt rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	parsed, err := http.NewRequest(req.Method, rt.target, req.Body)
	if err != nil {
		return nil, err
	}
	parsed.Header = req.Header
	return http.DefaultTransport.RoundTrip(parsed)
}
