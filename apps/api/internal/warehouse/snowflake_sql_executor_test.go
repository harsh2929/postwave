package warehouse

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

const testSnowflakeSQLDriverName = "postwave_snowflake_sql_executor_test"

var testSnowflakeSQL = &testSnowflakeSQLState{}

func init() {
	sql.Register(testSnowflakeSQLDriverName, testSnowflakeSQLDriver{})
}

func TestSnowflakeSQLDriverIsLinked(t *testing.T) {
	for _, name := range sql.Drivers() {
		if name == "snowflake" {
			return
		}
	}
	t.Fatalf("snowflake database/sql driver is not linked; drivers=%v", sql.Drivers())
}

type testSnowflakeSQLState struct {
	mu       sync.Mutex
	dsn      string
	opens    int
	execs    []string
	queries  []string
	execErr  error
	queryErr error
}

func (s *testSnowflakeSQLState) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dsn = ""
	s.opens = 0
	s.execs = nil
	s.queries = nil
	s.execErr = nil
	s.queryErr = nil
}

func (s *testSnowflakeSQLState) snapshot() (string, []string, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dsn, append([]string(nil), s.execs...), append([]string(nil), s.queries...)
}

func (s *testSnowflakeSQLState) openCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.opens
}

type testSnowflakeSQLDriver struct{}

func (testSnowflakeSQLDriver) Open(dsn string) (driver.Conn, error) {
	testSnowflakeSQL.mu.Lock()
	testSnowflakeSQL.dsn = dsn
	testSnowflakeSQL.opens++
	testSnowflakeSQL.mu.Unlock()
	return testSnowflakeSQLConn{}, nil
}

type testSnowflakeSQLConn struct{}

func (testSnowflakeSQLConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not used")
}

func (testSnowflakeSQLConn) Close() error {
	return nil
}

func (testSnowflakeSQLConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not used")
}

func (testSnowflakeSQLConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	testSnowflakeSQL.mu.Lock()
	defer testSnowflakeSQL.mu.Unlock()
	if testSnowflakeSQL.execErr != nil {
		return nil, testSnowflakeSQL.execErr
	}
	testSnowflakeSQL.execs = append(testSnowflakeSQL.execs, query)
	if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(query)), "COPY ") {
		return driver.RowsAffected(5), nil
	}
	return driver.RowsAffected(0), nil
}

func (testSnowflakeSQLConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	testSnowflakeSQL.mu.Lock()
	defer testSnowflakeSQL.mu.Unlock()
	if testSnowflakeSQL.queryErr != nil {
		return nil, testSnowflakeSQL.queryErr
	}
	testSnowflakeSQL.queries = append(testSnowflakeSQL.queries, query)
	return &testSnowflakeSQLRows{
		cols: []string{"one"},
		rows: [][]driver.Value{{int64(1)}},
	}, nil
}

type testSnowflakeSQLRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *testSnowflakeSQLRows) Columns() []string {
	return r.cols
}

func (r *testSnowflakeSQLRows) Close() error {
	return nil
}

func (r *testSnowflakeSQLRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

type testSnowflakeCredentialResolver struct {
	creds map[string]any
	err   error
}

func (r testSnowflakeCredentialResolver) ResolveSnowflake(context.Context, string) (map[string]any, error) {
	return r.creds, r.err
}

func TestBuildSnowflakeSQLDSNUsesSecretAndConfig(t *testing.T) {
	dsn, err := buildSnowflakeSQLDSN(Connection{
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"role":      "POSTWAVE_ROLE",
		},
	}, map[string]any{"user": "svc user", "password": "p@ss"})
	if err != nil {
		t.Fatalf("build dsn: %v", err)
	}
	if !strings.Contains(dsn, "svc+user:p%40ss@xy12345/POSTWAVE/PUBLIC") ||
		!strings.Contains(dsn, "warehouse=COMPUTE_WH") ||
		!strings.Contains(dsn, "role=POSTWAVE_ROLE") {
		t.Fatalf("dsn = %q", dsn)
	}
}

func TestBuildSnowflakeSQLDSNHonorsVerbatimDSN(t *testing.T) {
	dsn, err := buildSnowflakeSQLDSN(Connection{}, map[string]any{"dsn": "user:pass@acct/db/schema?warehouse=wh"})
	if err != nil || dsn != "user:pass@acct/db/schema?warehouse=wh" {
		t.Fatalf("dsn = %q err=%v", dsn, err)
	}
}

func TestSnowflakeSQLExecutorExecutesHealthCheck(t *testing.T) {
	testSnowflakeSQL.reset()
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	job := snowflakeHealthCheckJob(conn)
	executor := &SnowflakeSQLExecutor{
		Resolver:   testSnowflakeCredentialResolver{creds: map[string]any{"user": "svc", "password": "pw"}},
		DriverName: testSnowflakeSQLDriverName,
	}
	defer func() { _ = executor.Close() }()
	result, err := executor.ExecuteSnowflakeJob(context.Background(), SnowflakeJobExecutionRequest{
		Connection: conn,
		Job:        job,
		Statements: executableSnowflakeJobStatements(job.Statements),
	})
	if err != nil {
		t.Fatalf("execute health: %v", err)
	}
	dsn, execs, queries := testSnowflakeSQL.snapshot()
	if !strings.Contains(dsn, "svc:pw@xy12345/POSTWAVE/PUBLIC") || len(execs) != 0 || len(queries) != 1 || queries[0] != "SELECT 1" {
		t.Fatalf("dsn=%q execs=%v queries=%v", dsn, execs, queries)
	}
	if result.LiveState != "executed" ||
		result.ExecutionMode != "snowflake_database_sql" ||
		result.ExecutionState != "provider_executed" ||
		result.StatementsExecuted != 1 ||
		result.RowsLoaded != 0 ||
		result.Metrics["query_rows_sampled"] != int64(1) {
		t.Fatalf("result = %+v", result)
	}
}

func TestSnowflakeSQLExecutorExecutesOrderedExportPlan(t *testing.T) {
	testSnowflakeSQL.reset()
	conn := Connection{
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
			"stage":     "POSTWAVE_STAGE",
		},
	}
	plan := BuildSnowflakeLoadPlan(conn, "run-1", []snowflakeExportEntry{{
		Object: "profiles",
		Rows:   5,
	}}, []SnowflakeLoadArtifact{{
		Object: "profiles",
		Rest:   "warehouse/runs/run-1/profiles.jsonl",
		Rows:   5,
	}})
	executor := &SnowflakeSQLExecutor{
		Resolver:   testSnowflakeCredentialResolver{creds: map[string]any{"dsn": "snowflake-dsn"}},
		DriverName: testSnowflakeSQLDriverName,
	}
	defer func() { _ = executor.Close() }()
	result, err := executor.ExecuteSnowflakeJob(context.Background(), SnowflakeJobExecutionRequest{
		Connection: conn,
		Job:        *plan.ProviderJob,
		Statements: executableSnowflakeJobStatements(plan.ProviderJob.Statements),
	})
	if err != nil {
		t.Fatalf("execute export plan: %v", err)
	}
	dsn, execs, queries := testSnowflakeSQL.snapshot()
	if dsn != "snowflake-dsn" || len(execs) != 2 || len(queries) != 1 {
		t.Fatalf("dsn=%q execs=%v queries=%v", dsn, execs, queries)
	}
	if !strings.HasPrefix(execs[0], "CREATE TABLE IF NOT EXISTS") ||
		!strings.Contains(queries[0], "INFORMATION_SCHEMA.COLUMNS") ||
		!strings.HasPrefix(execs[1], "COPY INTO") {
		t.Fatalf("execs=%v queries=%v", execs, queries)
	}
	if result.StatementsExecuted != 3 || result.TablesLoaded != 1 || result.RowsLoaded != 5 ||
		result.Metrics["exec_statements"] != 2 ||
		result.Metrics["query_statements"] != 1 {
		t.Fatalf("result = %+v", result)
	}
}

func TestSnowflakeSQLExecutorPoolsByConnectionAndReopensOnRotation(t *testing.T) {
	testSnowflakeSQL.reset()
	conn := Connection{
		ID:             "warehouse-1",
		Provider:       ProviderSnowflake,
		CredentialsRef: "vault://snowflake",
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "COMPUTE_WH",
			"database":  "POSTWAVE",
			"schema":    "PUBLIC",
		},
	}
	job := snowflakeHealthCheckJob(conn)
	resolver := testSnowflakeCredentialResolver{creds: map[string]any{"dsn": "snowflake-dsn-1"}}
	executor := &SnowflakeSQLExecutor{Resolver: resolver, DriverName: testSnowflakeSQLDriverName}
	defer func() { _ = executor.Close() }()
	req := SnowflakeJobExecutionRequest{Connection: conn, Job: job, Statements: executableSnowflakeJobStatements(job.Statements)}
	if _, err := executor.ExecuteSnowflakeJob(context.Background(), req); err != nil {
		t.Fatalf("execute first: %v", err)
	}
	if _, err := executor.ExecuteSnowflakeJob(context.Background(), req); err != nil {
		t.Fatalf("execute second: %v", err)
	}
	if opens := testSnowflakeSQL.openCount(); opens != 1 {
		t.Fatalf("opens before rotation = %d, want 1", opens)
	}
	resolver.creds = map[string]any{"dsn": "snowflake-dsn-2"}
	executor.Resolver = resolver
	if _, err := executor.ExecuteSnowflakeJob(context.Background(), req); err != nil {
		t.Fatalf("execute after rotation: %v", err)
	}
	if opens := testSnowflakeSQL.openCount(); opens != 2 {
		t.Fatalf("opens after rotation = %d, want 2", opens)
	}
	dsn, _, _ := testSnowflakeSQL.snapshot()
	if dsn != "snowflake-dsn-2" {
		t.Fatalf("dsn after rotation = %q", dsn)
	}
}

type testSnowflakeRuntimeSecrets struct {
	raw string
}

func (s testSnowflakeRuntimeSecrets) Get(_ context.Context, _ string) (string, error) {
	return s.raw, nil
}

func (s testSnowflakeRuntimeSecrets) GetJSON(_ context.Context, _ string, out any) error {
	return json.Unmarshal([]byte(s.raw), out)
}

func TestSnowflakeSecretsCredentialResolverFallsBackToRawDSN(t *testing.T) {
	creds, err := NewSnowflakeSecretsCredentialResolver(testSnowflakeRuntimeSecrets{raw: "user:pass@acct/db/schema"}).ResolveSnowflake(context.Background(), "vault://snowflake")
	if err != nil {
		t.Fatalf("resolve raw dsn: %v", err)
	}
	if creds["dsn"] != "user:pass@acct/db/schema" {
		t.Fatalf("creds = %+v", creds)
	}
}

func TestSnowflakeSecretsCredentialResolverParsesKeyValueSecret(t *testing.T) {
	creds, err := NewSnowflakeSecretsCredentialResolver(testSnowflakeRuntimeSecrets{raw: "user=svc\npassword=pw\nwarehouse=COMPUTE_WH"}).ResolveSnowflake(context.Background(), "vault://snowflake")
	if err != nil {
		t.Fatalf("resolve key-value secret: %v", err)
	}
	if creds["user"] != "svc" || creds["password"] != "pw" || creds["warehouse"] != "COMPUTE_WH" {
		t.Fatalf("creds = %+v", creds)
	}
}
