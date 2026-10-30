// SPDX-License-Identifier: AGPL-3.0-only

package zerocopy_triggers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/snowflakedb/gosnowflake"
)

func TestTemplateQuery(t *testing.T) {
	q, args := templateQuery("SELECT id, email FROM e WHERE updated_at > :last_seen_cursor", "2026-01-01", 100)
	if !strings.Contains(q, "$1") {
		t.Fatalf("cursor not substituted: %q", q)
	}
	if len(args) != 1 || args[0] != "2026-01-01" {
		t.Fatalf("cursor arg wrong: %v", args)
	}
	if !strings.Contains(strings.ToUpper(q), "LIMIT 100") {
		t.Fatalf("limit not applied: %q", q)
	}
	// No cursor token → no args; an outer hard limit is always applied even
	// when the operator query has its own smaller limit.
	q2, args2 := templateQuery("SELECT 1 LIMIT 5", "x", 100)
	if len(args2) != 0 {
		t.Fatalf("unexpected args: %v", args2)
	}
	if strings.Count(strings.ToUpper(q2), "LIMIT") != 2 {
		t.Fatalf("hard outer limit missing: %q", q2)
	}
}

func TestTemplateQueryUsesProviderPlaceholders(t *testing.T) {
	query := "SELECT * FROM events WHERE a > :last_seen_cursor OR b > :last_seen_cursor"
	postgres, postgresArgs := templateQueryForProvider("postgres", query, "cursor", 10)
	if strings.Count(postgres, "$1") != 2 || len(postgresArgs) != 1 {
		t.Fatalf("postgres binding = %q args=%v", postgres, postgresArgs)
	}
	snowflake, snowflakeArgs := templateQueryForProvider("snowflake", query, "cursor", 10)
	if strings.Count(snowflake, "?") != 2 || len(snowflakeArgs) != 2 {
		t.Fatalf("snowflake binding = %q args=%v", snowflake, snowflakeArgs)
	}
}

func TestBuildDSN_Postgres(t *testing.T) {
	dsn, err := buildDSN("postgres",
		map[string]any{"host": "wh.example.com", "database": "analytics", "sslmode": "verify-full"},
		map[string]any{"user": "svc", "password": "p@ss word"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dsn, "postgres://svc:") || !strings.Contains(dsn, "wh.example.com:5432/analytics") {
		t.Fatalf("bad postgres dsn: %q", dsn)
	}
	if !strings.Contains(dsn, "sslmode=verify-full") {
		t.Fatalf("sslmode missing: %q", dsn)
	}
}

func TestBuildDSN_RedshiftDefaultPort(t *testing.T) {
	dsn, err := buildDSN("redshift", map[string]any{"host": "rs.example.com", "database": "dw"}, map[string]any{"user": "u", "password": "p"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, ":5439/dw") {
		t.Fatalf("redshift default port not 5439: %q", dsn)
	}
}

func TestBuildDSN_VerbatimDSNEscapeHatch(t *testing.T) {
	dsn, err := buildDSN("postgres", nil, map[string]any{"dsn": "postgres://verbatim/x"})
	if err != nil || !strings.HasPrefix(dsn, "postgres://verbatim/x?") ||
		!strings.Contains(dsn, "sslmode=verify-full") || !strings.Contains(dsn, "default_transaction_read_only=on") {
		t.Fatalf("verbatim dsn was not hardened: %q %v", dsn, err)
	}
	if _, err := buildDSN("postgres", nil, map[string]any{"dsn": "postgres://verbatim/x?sslmode=disable"}); err == nil {
		t.Fatal("plaintext postgres DSN accepted")
	}
	if _, err := buildDSN("postgres", nil, map[string]any{"dsn": "postgres://verbatim/x?sslmode=require"}); err == nil {
		t.Fatal("TLS without certificate/hostname verification accepted")
	}
}

func TestBuildDSN_SnowflakeUsesHTTPSAndFailClosedOCSP(t *testing.T) {
	dsn, dsnErr := buildDSN("snowflake",
		map[string]any{
			"account": "acme.us-east-1", "database": "ANALYTICS", "schema": "PUBLIC",
			"warehouse": "COMPUTE_WH", "role": "POSTWAVE_READER",
		},
		map[string]any{"user": "reader", "password": "p@ss:word"})
	if dsnErr != nil {
		t.Fatal(dsnErr)
	}
	cfg, dsnErr := gosnowflake.ParseDSN(dsn)
	if dsnErr != nil {
		t.Fatal(dsnErr)
	}
	if cfg.Password != "p@ss:word" || !strings.EqualFold(cfg.Protocol, "https") || cfg.OCSPFailOpen != gosnowflake.OCSPFailOpenFalse {
		t.Fatalf("snowflake DSN was not safely normalized: protocol=%q ocsp=%v", cfg.Protocol, cfg.OCSPFailOpen)
	}
	if _, err := validateReadOnlyDSN("snowflake", "reader:pass@acme/db/schema?insecureMode=true"); err == nil {
		t.Fatal("insecure Snowflake DSN accepted")
	}
	if _, err := validateReadOnlyDSN("snowflake", "reader:pass@acme/db/schema?InsecureMode=TRUE"); err == nil {
		t.Fatal("case-varied insecure Snowflake DSN accepted")
	}
	unsafeFileDSN, dsnErr := gosnowflake.DSN(&gosnowflake.Config{
		Account: "acme", User: "reader", Password: "p", TokenFilePath: "/etc/postwave/secret",
	})
	if dsnErr != nil {
		t.Fatal(dsnErr)
	}
	if _, err := validateReadOnlyDSN("snowflake", unsafeFileDSN); err == nil {
		t.Fatal("Snowflake DSN with a process-local token file accepted")
	}
}

func TestStringifyCell(t *testing.T) {
	cases := map[any]string{
		"hello":   "hello",
		int64(42): "42",
		nil:       "",
	}
	for in, want := range cases {
		if got := stringifyCell(in); got != want {
			t.Errorf("stringifyCell(%v)=%q want %q", in, got, want)
		}
	}
	if got := stringifyCell([]byte("bytes")); got != "bytes" {
		t.Errorf("[]byte not stringified: %q", got)
	}
}

// --- BigQuery driver: fully exercised over httptest ---

type fakeLookup struct{ ci ConnInfo }

func (f fakeLookup) LookupConnection(_ context.Context, _, _ string) (ConnInfo, error) {
	return f.ci, nil
}

type fakeResolver struct{ m map[string]any }

func (f fakeResolver) Resolve(_ context.Context, _, _ string) (map[string]any, error) {
	return f.m, nil
}

type captureRuntimeSecrets struct {
	name  string
	raw   string
	calls int
}

func (f *captureRuntimeSecrets) Get(_ context.Context, name string) (string, error) {
	f.name = name
	f.calls++
	return f.raw, nil
}

func TestBigQueryDriver_Poll(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		gotBody = string(b)
		_, _ = w.Write([]byte(`{
		  "jobComplete": true,
		  "schema": {"fields": [{"name":"email"},{"name":"updated_at"}]},
		  "rows": [
		    {"f": [{"v":"a@b.com"},{"v":"2026-02-02T00:00:00Z"}]},
		    {"f": [{"v":"c@d.com"},{"v":"2026-02-03T00:00:00Z"}]}
		  ]
		}`))
	}))
	defer srv.Close()

	d := &BigQueryDriver{
		Lookup:   fakeLookup{ci: ConnInfo{Provider: "bigquery", Direction: "import", Status: "active", CredentialsRef: "ref", Config: map[string]any{"project": "proj-1"}}},
		Resolver: fakeResolver{m: map[string]any{"access_token": "tok-123", "read_only": true}},
		BaseURL:  srv.URL,
	}
	tr := Trigger{
		TenantID:         "00000000-0000-0000-0000-000000000001",
		Provider:         "bigquery",
		ConnectionID:     "c1",
		Query:            "SELECT email, updated_at FROM `d.events` WHERE updated_at > :last_seen_cursor",
		CursorColumn:     "updated_at",
		ProfileKeyColumn: "email",
		LastSeenCursor:   "2026-02-01T00:00:00Z",
	}
	rows, err := d.Poll(context.Background(), tr, 10)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].ProfileKey != "a@b.com" || rows[0].CursorValue != "2026-02-02T00:00:00Z" {
		t.Fatalf("row0 wrong: %+v", rows[0])
	}
	if gotAuth != "Bearer tok-123" {
		t.Fatalf("auth header: %q", gotAuth)
	}
	// The :last_seen_cursor token must be rewritten to the BQ named form + bound.
	if !strings.Contains(gotBody, "@last_seen_cursor") {
		t.Fatalf("cursor not rewritten to BQ form: %s", gotBody)
	}
	var req bqQueryRequest
	if err := json.Unmarshal([]byte(gotBody), &req); err == nil {
		if req.ParameterMode != "NAMED" || len(req.QueryParameters) != 1 || req.QueryParameters[0].ParameterValue.Value != "2026-02-01T00:00:00Z" {
			t.Fatalf("cursor param not bound: %+v", req)
		}
		if req.MaximumBytesBilled != strconv.FormatInt(hardMaxBigQueryBytesBilled, 10) || req.JobTimeoutMs == "" {
			t.Fatalf("BigQuery resource bounds missing: %+v", req)
		}
	}
}

func TestBigQueryDriver_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"denied"}`))
	}))
	defer srv.Close()
	d := &BigQueryDriver{
		Lookup:   fakeLookup{ci: ConnInfo{Provider: "bigquery", Direction: "import", Status: "active", CredentialsRef: "ref", Config: map[string]any{"project": "p"}}},
		Resolver: fakeResolver{m: map[string]any{"access_token": "t", "read_only": true}},
		BaseURL:  srv.URL,
	}
	if _, err := d.Poll(context.Background(), Trigger{
		TenantID: "00000000-0000-0000-0000-000000000001", Provider: "bigquery",
		ConnectionID: "c", Query: "SELECT 1",
	}, 1); err == nil {
		t.Fatal("expected error on 403")
	}
}

func TestBigQueryDriverRejectsIncompleteJob(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jobComplete":false}`))
	}))
	defer srv.Close()
	d := &BigQueryDriver{
		Lookup: fakeLookup{ci: ConnInfo{
			Provider: "bigquery", Direction: "import", Status: "active",
			CredentialsRef: "ref", Config: map[string]any{"project": "p"},
		}},
		Resolver: fakeResolver{m: map[string]any{"access_token": "t", "read_only": true}},
		BaseURL:  srv.URL,
	}
	_, err := d.Poll(context.Background(), Trigger{
		TenantID: "00000000-0000-0000-0000-000000000001", Provider: "bigquery",
		ConnectionID: "c", Query: "SELECT 1",
	}, 1)
	if err == nil || !strings.Contains(err.Error(), "did not complete") {
		t.Fatalf("incomplete job error = %v", err)
	}
}

func TestEnvCredentialResolver(t *testing.T) {
	r := NewEnvCredentialResolver()
	const tenantID = "00000000-0000-0000-0000-000000000001"
	name, err := tenantCredentialSecretName(tenantID, "TEST")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(tenantCredentialEnvName(name), `{"user":"u","password":"p","read_only":true}`)
	m, err := r.Resolve(context.Background(), tenantID, "TEST")
	if err != nil || m["user"] != "u" {
		t.Fatalf("resolve json: %v %v", m, err)
	}
	// A canonical reference for another tenant never reaches its env var.
	other := "00000000-0000-0000-0000-000000000002"
	if _, err := r.Resolve(context.Background(), tenantID,
		"postwave/tenants/"+other+"/warehouse/read-only/TEST"); err == nil {
		t.Fatal("cross-tenant secret reference accepted")
	}
	badName, _ := tenantCredentialSecretName(tenantID, "BAD")
	t.Setenv(tenantCredentialEnvName(badName), "postgres://x/y")
	if _, err := r.Resolve(context.Background(), tenantID, "BAD"); err == nil {
		t.Fatal("non-JSON credential payload accepted")
	}
	if _, err := parseTenantCredentialPayload(strings.Repeat("x", hardMaxCredentialPayloadBytes+1)); err == nil {
		t.Fatal("oversized credential payload accepted")
	}
}

func TestTenantSecretsResolverAlwaysDerivesRequestTenantNamespace(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000001"
	backend := &captureRuntimeSecrets{raw: `{"read_only":true,"user":"reader"}`}
	r := NewTenantSecretsCredentialResolver(backend)
	payload, err := r.Resolve(context.Background(), tenantID, "primary")
	if err != nil || payload["user"] != "reader" {
		t.Fatalf("resolve = %v, %v", payload, err)
	}
	want := "postwave/tenants/" + tenantID + "/warehouse/read-only/primary"
	if backend.name != want || backend.calls != 1 {
		t.Fatalf("secret lookup = %q calls=%d, want %q/1", backend.name, backend.calls, want)
	}
	_, err = r.Resolve(context.Background(), tenantID,
		"postwave/tenants/00000000-0000-0000-0000-000000000002/warehouse/read-only/primary")
	if err == nil || backend.calls != 1 {
		t.Fatalf("cross-tenant reference reached backend: err=%v calls=%d", err, backend.calls)
	}
}

func TestSQLDriver_NotConfigured(t *testing.T) {
	d := &SQLDriver{}
	if _, err := d.Poll(context.Background(), Trigger{Provider: "postgres", ConnectionID: "c"}, 1); err == nil {
		t.Fatal("expected not-configured error")
	}
}

func TestValidateReadOnlyQuery(t *testing.T) {
	accepted := []string{
		"SELECT id, email FROM events WHERE updated_at > :last_seen_cursor",
		"WITH recent AS (SELECT id FROM events) SELECT * FROM recent",
		"SELECT '; not a statement' AS value",
		"SELECT 1;",
	}
	for _, query := range accepted {
		if err := validateReadOnlyQuery(query); err != nil {
			t.Errorf("valid query %q rejected: %v", query, err)
		}
	}
	rejected := []string{
		"UPDATE events SET email = 'x'",
		"WITH changed AS (DELETE FROM events RETURNING *) SELECT * FROM changed",
		"SELECT * INTO backup FROM events",
		"SELECT 1; DROP TABLE events",
		"SELECT 1 -- hidden mutation",
		"SELECT pg_sleep(1); SELECT 2",
		"SELECT 1 /* hidden mutation */",
	}
	for _, query := range rejected {
		if err := validateReadOnlyQuery(query); err == nil {
			t.Errorf("unsafe query %q accepted", query)
		}
	}
}

func TestReadOnlyCredentialAndResourceCaps(t *testing.T) {
	if err := requireReadOnlyCredential(map[string]any{"read_only": true}); err != nil {
		t.Fatal(err)
	}
	if err := requireReadOnlyCredential(map[string]any{"read_only": false}); err == nil {
		t.Fatal("writable credential accepted")
	}
	if got := effectivePollLimit(hardMaxRowsPerPoll + 1); got != hardMaxRowsPerPoll {
		t.Fatalf("poll limit = %d", got)
	}
	if _, err := addSerializedPayloadBytes(map[string]any{"large": strings.Repeat("x", hardMaxSerializedRowBytes+1)}, 0); err == nil {
		t.Fatal("oversized serialized row accepted")
	}
	if got := boundedProviderError([]byte(strings.Repeat("x", hardMaxProviderErrorBytes+100))); len(got) != hardMaxProviderErrorBytes {
		t.Fatalf("provider error length = %d", len(got))
	}
}

func TestSQLPoolsAreTenantAndConnectionScoped(t *testing.T) {
	d := &SQLDriver{}
	dsn := "postgres://user:pass@warehouse.example/db?sslmode=verify-full"
	a, err := d.dbFor("postgres", "00000000-0000-0000-0000-000000000001", "same-connection-id", dsn)
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.dbFor("postgres", "00000000-0000-0000-0000-000000000002", "same-connection-id", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})
	if a == b || len(d.pools) != 2 {
		t.Fatalf("cross-tenant pool alias: same=%v pool_count=%d", a == b, len(d.pools))
	}
}

func TestSQLPoolCacheIsGloballyBounded(t *testing.T) {
	d := &SQLDriver{}
	tenantID := "00000000-0000-0000-0000-000000000001"
	for i := 0; i < hardMaxSQLPools+3; i++ {
		db, err := d.dbFor("postgres", tenantID, fmt.Sprintf("connection-%d", i),
			"postgres://user:pass@warehouse.example/db?sslmode=verify-full")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
	}
	if len(d.pools) != hardMaxSQLPools {
		t.Fatalf("pool cache size = %d, want %d", len(d.pools), hardMaxSQLPools)
	}
}
