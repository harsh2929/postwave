// SPDX-License-Identifier: AGPL-3.0-only
//
// snowflake_otlp_test.go — unit tests for the snowflake_shareback and
// otlp_logs sink kinds. Both delivery paths are exercised via a
// captured http.RoundTripper so we don't need a live Snowflake/OTLP
// collector.

package auditsink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureTripper records every request the worker issues so test
// assertions can read it back. Returns 200 unless StatusCode is set.
type captureTripper struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   [][]byte

	StatusCode int
}

func (c *captureTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	c.requests = append(c.requests, r)
	c.bodies = append(c.bodies, body)
	c.mu.Unlock()
	status := c.StatusCode
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewReader([]byte("ok"))),
		Header:     make(http.Header),
		Request:    r,
	}, nil
}

func (c *captureTripper) last() (*http.Request, []byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.requests) == 0 {
		return nil, nil, false
	}
	return c.requests[len(c.requests)-1], c.bodies[len(c.bodies)-1], true
}

func newCaptureDeps() (*Deps, *captureTripper) {
	rt := &captureTripper{}
	return &Deps{
		HTTP:               &http.Client{Transport: rt, Timeout: 5 * time.Second},
		httpClientHardened: true,
	}, rt
}

func sampleRows() []AuditRow {
	return []AuditRow{{
		ID: 42, TenantID: "11111111-1111-1111-1111-111111111111",
		UserID: "u-1", Action: "subscriber.create",
		ResourceType: "subscriber", ResourceID: "s-1",
		Metadata:  map[string]any{"reason": "test"},
		IP:        "203.0.113.10",
		ActorType: "human", ActorLabel: "alice@example.com",
		At:      time.Unix(1_700_000_000, 0).UTC(),
		RowHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		EventID: "evt-1",
	}}
}

// --- Snowflake Shareback ------------------------------------------------

func TestParseSnowflakeSharebackConfig(t *testing.T) {
	cases := []struct {
		name    string
		cfg     map[string]any
		wantErr bool
	}{
		{
			name: "happy_path",
			cfg: map[string]any{
				"account_locator": "xy12345.eu-central-1.aws",
				"share_name":      "postwave_audit_share",
				"bucket":          "postwave-shareback",
				"region":          "eu-central-1",
				"prefix":          "audit/",
			},
		},
		{
			name:    "missing_account_locator",
			cfg:     map[string]any{"share_name": "s", "bucket": "b", "region": "r"},
			wantErr: true,
		},
		{
			name: "invalid_locator_format",
			cfg: map[string]any{
				"account_locator": "??not valid??",
				"share_name":      "s",
				"bucket":          "b",
				"region":          "r",
			},
			wantErr: true,
		},
		{
			name: "missing_bucket",
			cfg: map[string]any{
				"account_locator": "xy12345.eu-central-1.aws",
				"share_name":      "s",
				"region":          "r",
			},
			wantErr: true,
		},
		{
			name: "underscore_legacy_locator",
			cfg: map[string]any{
				"account_locator": "xy12345_us-west-2_aws",
				"share_name":      "s",
				"bucket":          "b",
				"region":          "r",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseSnowflakeSharebackConfig(tc.cfg)
			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestSnowflakeShareKey(t *testing.T) {
	got := SnowflakeShareKey("audit/", "xy12345.eu-central-1.aws",
		"share1", "tenant-uuid", 100, 200, true)
	want := "audit/xy12345.eu-central-1.aws/share1/tenant-uuid/100-200.ocsf.jsonl"
	if got != want {
		t.Errorf("key = %q, want %q", got, want)
	}
	// Empty prefix
	got = SnowflakeShareKey("", "xy12345.eu-central-1.aws",
		"share1", "tenant-uuid", 1, 2, false)
	want = "xy12345.eu-central-1.aws/share1/tenant-uuid/1-2.jsonl"
	if got != want {
		t.Errorf("empty-prefix key = %q, want %q", got, want)
	}
}

func TestDeliverSnowflakeShareback_MissingCreds(t *testing.T) {
	d, _ := newCaptureDeps()
	s := Sink{
		Kind: "snowflake_shareback", TenantID: "t-1",
		Config: map[string]any{
			"account_locator": "xy12345.eu-central-1.aws",
			"share_name":      "share1",
			"bucket":          "postwave-shareback",
			"region":          "us-east-1",
		},
	}
	err := d.deliverSnowflakeShareback(context.Background(), s, sampleRows(), map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "aws_access_key_id") {
		t.Fatalf("expected creds-missing error, got %v", err)
	}
}

func TestDeliverSnowflakeShareback_InvalidConfig(t *testing.T) {
	d, _ := newCaptureDeps()
	s := Sink{Kind: "snowflake_shareback", Config: map[string]any{}}
	if err := d.deliverSnowflakeShareback(context.Background(), s, sampleRows(),
		map[string]string{"aws_access_key_id": "AK", "aws_secret_access_key": "SK"}); err == nil {
		t.Fatal("expected config error")
	}
}

func TestDeliverSnowflakeShareback_PutsToS3(t *testing.T) {
	d, rt := newCaptureDeps()
	s := Sink{
		Kind: "snowflake_shareback", TenantID: "tenant-uuid",
		Name:         "main",
		OutputFormat: FormatOCSF18,
		Config: map[string]any{
			"account_locator": "xy12345.eu-central-1.aws",
			"share_name":      "share1",
			"bucket":          "postwave-shareback",
			"region":          "us-east-1",
			"prefix":          "audit",
		},
	}
	if err := d.deliverSnowflakeShareback(context.Background(), s, sampleRows(),
		map[string]string{
			"aws_access_key_id":     "AKIATESTKEY",
			"aws_secret_access_key": "secretsecretsecret",
		}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	req, body, ok := rt.last()
	if !ok {
		t.Fatal("no request captured")
	}
	if req.Method != http.MethodPut {
		t.Errorf("method = %s, want PUT", req.Method)
	}
	if !strings.Contains(req.URL.Path, "/audit/xy12345.eu-central-1.aws/share1/tenant-uuid/42-42.ocsf.jsonl") {
		t.Errorf("path = %s, want shareback key with locator + share + tenant + range", req.URL.Path)
	}
	if !strings.Contains(req.URL.Host, "postwave-shareback") {
		t.Errorf("host = %s, want bucket-prefixed S3 host", req.URL.Host)
	}
	if !bytes.Contains(body, []byte("subscriber.create")) {
		t.Error("body did not include OCSF mapping of action")
	}
}

// --- OTLP Logs ----------------------------------------------------------

func TestMapAuditRowToOTLPLogRecord(t *testing.T) {
	r := sampleRows()[0]
	rec := mapAuditRowToOTLPLogRecord(r)
	if rec.SeverityNumber != 9 {
		t.Errorf("severityNumber = %d, want 9 (INFO)", rec.SeverityNumber)
	}
	if rec.Body.StringValue == "" {
		t.Error("body empty")
	}
	wantKeys := map[string]string{
		"postwave.audit.id":     "42",
		"postwave.tenant_id":    r.TenantID,
		"postwave.audit.action": "subscriber.create",
		"user.id":               "u-1",
		"user.name":             "alice@example.com",
		"client.address":        "203.0.113.10",
	}
	got := map[string]string{}
	for _, kv := range rec.Attributes {
		got[kv.Key] = kv.Value.StringValue
	}
	for k, v := range wantKeys {
		if got[k] != v {
			t.Errorf("attr %s = %q, want %q", k, got[k], v)
		}
	}
}

func TestDeliverOTLPLogs_MissingEndpoint(t *testing.T) {
	d, _ := newCaptureDeps()
	s := Sink{Kind: "otlp_logs", Config: map[string]any{}}
	if err := d.deliverOTLPLogs(context.Background(), s, sampleRows(), nil); err == nil {
		t.Fatal("expected endpoint-required error")
	}
}

func TestDeliverOTLPLogs_InvalidEndpointScheme(t *testing.T) {
	d, _ := newCaptureDeps()
	s := Sink{Kind: "otlp_logs", Config: map[string]any{"endpoint": "tcp://otel:4318"}}
	if err := d.deliverOTLPLogs(context.Background(), s, sampleRows(), nil); err == nil {
		t.Fatal("expected scheme error")
	}
}

func TestDeliverOTLPLogs_UnsupportedCompression(t *testing.T) {
	d, _ := newCaptureDeps()
	s := Sink{Kind: "otlp_logs", Config: map[string]any{
		"endpoint":    "https://otel.example.com",
		"compression": "zstd",
	}}
	if err := d.deliverOTLPLogs(context.Background(), s, sampleRows(), nil); err == nil {
		t.Fatal("expected unsupported-compression error")
	}
}

func TestDeliverOTLPLogs_PostsJSONToV1Logs(t *testing.T) {
	d, rt := newCaptureDeps()
	s := Sink{
		Kind: "otlp_logs", TenantID: "t-1",
		Config: map[string]any{
			"endpoint":     "https://otel.example.com",
			"service_name": "postwave-test",
			"headers":      "X-Org-ID: acme\nX-Region: eu",
		},
	}
	err := d.deliverOTLPLogs(context.Background(), s, sampleRows(),
		map[string]string{"bearer_token": "tok"})
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	req, body, ok := rt.last()
	if !ok {
		t.Fatal("no request captured")
	}
	if req.URL.String() != "https://otel.example.com/v1/logs" {
		t.Errorf("url = %s, want .../v1/logs", req.URL.String())
	}
	if got := req.Header.Get("Authorization"); got != "Bearer tok" {
		t.Errorf("authorization = %q, want Bearer tok", got)
	}
	if got := req.Header.Get("X-Org-ID"); got != "acme" {
		t.Errorf("X-Org-ID = %q, want acme", got)
	}
	if got := req.Header.Get("X-Region"); got != "eu" {
		t.Errorf("X-Region = %q, want eu", got)
	}
	// Body must be parseable as the OTLP JSON envelope.
	var parsed otlpLogsRequest
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("body parse: %v", err)
	}
	if len(parsed.ResourceLogs) != 1 || len(parsed.ResourceLogs[0].ScopeLogs) != 1 ||
		len(parsed.ResourceLogs[0].ScopeLogs[0].LogRecords) != 1 {
		t.Fatalf("unexpected envelope shape: %+v", parsed)
	}
	res := parsed.ResourceLogs[0].Resource
	foundService := false
	for _, kv := range res.Attributes {
		if kv.Key == "service.name" && kv.Value.StringValue == "postwave-test" {
			foundService = true
		}
	}
	if !foundService {
		t.Error("service.name attribute not set on resource")
	}
}

func TestDeliverOTLPLogs_GzipCompression(t *testing.T) {
	d, rt := newCaptureDeps()
	s := Sink{
		Kind: "otlp_logs", TenantID: "t-1",
		Config: map[string]any{
			"endpoint":    "https://otel.example.com",
			"compression": "gzip",
		},
	}
	if err := d.deliverOTLPLogs(context.Background(), s, sampleRows(), nil); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	req, body, ok := rt.last()
	if !ok {
		t.Fatal("no request captured")
	}
	if got := req.Header.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("content-encoding = %q, want gzip", got)
	}
	// Body must round-trip through gzip back to OTLP JSON.
	r, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	plain, _ := io.ReadAll(r)
	var parsed otlpLogsRequest
	if err := json.Unmarshal(plain, &parsed); err != nil {
		t.Fatalf("decompressed body parse: %v", err)
	}
}

func TestDeliverOTLPLogs_4xxBubblesError(t *testing.T) {
	d, rt := newCaptureDeps()
	rt.StatusCode = http.StatusUnauthorized
	s := Sink{Kind: "otlp_logs", Config: map[string]any{"endpoint": "https://otel.example.com"}}
	err := d.deliverOTLPLogs(context.Background(), s, sampleRows(), nil)
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error = %v, want to contain 401", err)
	}
}

// --- deliver() dispatcher routes new kinds -----------------------------

func TestDeliver_RoutesNewKinds(t *testing.T) {
	d, rt := newCaptureDeps()
	d.Cipher = passthroughCipher{}
	creds, _ := json.Marshal(map[string]string{"bearer_token": "tok"})

	// otlp_logs route.
	otlpSink := Sink{
		Kind: "otlp_logs", TenantID: "t-1",
		CredentialsEnvelope: creds,
		Config:              map[string]any{"endpoint": "https://otel.example.com"},
	}
	if err := d.deliver(context.Background(), otlpSink, sampleRows()); err != nil {
		t.Fatalf("otlp_logs deliver: %v", err)
	}
	req, _, _ := rt.last()
	if !strings.HasSuffix(req.URL.Path, "/v1/logs") {
		t.Errorf("otlp deliver target = %s, want /v1/logs suffix", req.URL.Path)
	}

	// snowflake_shareback route.
	sfCreds, _ := json.Marshal(map[string]string{
		"aws_access_key_id":     "AK",
		"aws_secret_access_key": "SK",
	})
	sfSink := Sink{
		Kind: "snowflake_shareback", TenantID: "tenant-uuid",
		CredentialsEnvelope: sfCreds,
		Config: map[string]any{
			"account_locator": "xy12345.eu-central-1.aws",
			"share_name":      "share1",
			"bucket":          "postwave-shareback",
			"region":          "us-east-1",
		},
	}
	if err := d.deliver(context.Background(), sfSink, sampleRows()); err != nil {
		t.Fatalf("snowflake_shareback deliver: %v", err)
	}
	req2, _, _ := rt.last()
	if req2.Method != http.MethodPut {
		t.Errorf("shareback deliver method = %s, want PUT", req2.Method)
	}
}

func TestOtlpTraceIDFromHash(t *testing.T) {
	full := "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	id := otlpTraceIDFromHash(full)
	if id == "" {
		t.Fatal("expected non-empty trace id from valid hex hash")
	}
	if otlpTraceIDFromHash("too-short") != "" {
		t.Error("expected empty trace id for short hash")
	}
}

// keep errors import alive for future negative-path tests
var _ = errors.New
