package warehouse

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type SnowflakeRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SnowflakeCredentialResolver interface {
	ResolveSnowflake(context.Context, string) (map[string]any, error)
}

type SnowflakeSecretsCredentialResolver struct {
	Secrets SnowflakeRuntimeSecretResolver
}

func NewSnowflakeSecretsCredentialResolver(secrets SnowflakeRuntimeSecretResolver) *SnowflakeSecretsCredentialResolver {
	return &SnowflakeSecretsCredentialResolver{Secrets: secrets}
}

func (r *SnowflakeSecretsCredentialResolver) ResolveSnowflake(ctx context.Context, ref string) (map[string]any, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("snowflake credentials_ref is required")
	}
	if r == nil || r.Secrets == nil {
		return nil, fmt.Errorf("snowflake credential resolver is not configured")
	}
	var payload map[string]any
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload, nil
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return nil, fmt.Errorf("resolve snowflake credentials %q: %w", ref, err)
		}
		return snowflakeCredentialPayload(raw), nil
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return nil, fmt.Errorf("resolve snowflake credentials %q: %w", ref, err)
	}
	return snowflakeCredentialPayload(raw), nil
}

type SnowflakeSQLOpener func(driverName, dsn string) (*sql.DB, error)

type SnowflakeSQLExecutor struct {
	Resolver     SnowflakeCredentialResolver
	DriverName   string
	Open         SnowflakeSQLOpener
	MaxOpenConns int
	MaxQueryRows int

	mu    sync.Mutex
	pools map[string]*snowflakeSQLPool
}

type snowflakeSQLPool struct {
	dsn string
	db  *sql.DB
}

func NewSnowflakeSQLExecutor(resolver SnowflakeCredentialResolver) *SnowflakeSQLExecutor {
	return &SnowflakeSQLExecutor{Resolver: resolver}
}

func (e *SnowflakeSQLExecutor) ExecuteSnowflakeJob(ctx context.Context, req SnowflakeJobExecutionRequest) (SnowflakeJobExecutionResult, error) {
	if e == nil || e.Resolver == nil {
		return SnowflakeJobExecutionResult{}, fmt.Errorf("snowflake SQL executor is not configured")
	}
	if req.Connection.Provider != ProviderSnowflake {
		return SnowflakeJobExecutionResult{}, fmt.Errorf("snowflake SQL executor requires a Snowflake connection")
	}
	creds, err := e.Resolver.ResolveSnowflake(ctx, firstNonEmpty(req.Connection.CredentialsRef, configString(req.Connection.Config, "credentials_ref"), configString(req.Connection.Config, "credential_ref")))
	if err != nil {
		return SnowflakeJobExecutionResult{}, err
	}
	dsn, err := buildSnowflakeSQLDSN(req.Connection, creds)
	if err != nil {
		return SnowflakeJobExecutionResult{}, err
	}
	driverName := strings.TrimSpace(e.DriverName)
	if driverName == "" {
		driverName = "snowflake"
	}
	db, err := e.dbFor(req.Connection, driverName, dsn)
	if err != nil {
		return SnowflakeJobExecutionResult{}, err
	}

	var statementsExecuted int
	var queryStatements int
	var execStatements int
	var copyStatements int
	var queryRowsSampled int64
	var rowsAffected int64
	for _, statement := range req.Statements {
		if !statement.Executable || strings.TrimSpace(statement.SQL) == "" {
			continue
		}
		if snowflakeStatementIsQuery(statement) {
			count, err := countSnowflakeSQLRows(ctx, db, statement.SQL, e.maxQueryRows())
			if err != nil {
				return SnowflakeJobExecutionResult{}, fmt.Errorf("execute snowflake %s statement: %w", statement.Phase, err)
			}
			queryRowsSampled += count
			queryStatements++
		} else {
			result, err := db.ExecContext(ctx, statement.SQL)
			if err != nil {
				return SnowflakeJobExecutionResult{}, fmt.Errorf("execute snowflake %s statement: %w", statement.Phase, err)
			}
			if affected, err := result.RowsAffected(); err == nil && affected > 0 {
				rowsAffected += affected
			}
			execStatements++
			if statement.Phase == "copy_into" {
				copyStatements++
			}
		}
		statementsExecuted++
	}
	return SnowflakeJobExecutionResult{
		LiveState:          "executed",
		ExecutionMode:      "snowflake_database_sql",
		ExecutionState:     "provider_executed",
		StatementsExecuted: statementsExecuted,
		TablesLoaded:       copyStatements,
		RowsLoaded:         rowsAffected,
		Metrics: map[string]any{
			"driver_name":        driverName,
			"request_kind":       req.Job.RequestKind,
			"query_statements":   queryStatements,
			"exec_statements":    execStatements,
			"query_rows_sampled": queryRowsSampled,
		},
	}, nil
}

func (e *SnowflakeSQLExecutor) dbFor(conn Connection, driverName, dsn string) (*sql.DB, error) {
	open := e.Open
	if open == nil {
		open = sql.Open
	}
	key := strings.TrimSpace(conn.ID)
	if key == "" {
		key = dsn
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pools == nil {
		e.pools = map[string]*snowflakeSQLPool{}
	}
	if pool, ok := e.pools[key]; ok {
		if pool.dsn == dsn {
			return pool.db, nil
		}
		_ = pool.db.Close()
		delete(e.pools, key)
	}
	db, err := open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("open snowflake SQL driver: %w", err)
	}
	maxOpen := e.MaxOpenConns
	if maxOpen <= 0 {
		maxOpen = 4
	}
	db.SetMaxOpenConns(maxOpen)
	e.pools[key] = &snowflakeSQLPool{dsn: dsn, db: db}
	return db, nil
}

func (e *SnowflakeSQLExecutor) maxQueryRows() int {
	if e != nil && e.MaxQueryRows > 0 {
		return e.MaxQueryRows
	}
	return 1
}

func (e *SnowflakeSQLExecutor) Close() error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	var out error
	for key, pool := range e.pools {
		if err := pool.db.Close(); err != nil && out == nil {
			out = err
		}
		delete(e.pools, key)
	}
	return out
}

func buildSnowflakeSQLDSN(conn Connection, secret map[string]any) (string, error) {
	if dsn := snowflakeMapString(secret, "dsn"); dsn != "" {
		return dsn, nil
	}
	account := firstNonEmpty(configString(conn.Config, "account"), snowflakeMapString(secret, "account"))
	user := firstNonEmpty(snowflakeMapString(secret, "user"), snowflakeMapString(secret, "username"), configString(conn.Config, "user"))
	password := firstNonEmpty(snowflakeMapString(secret, "password"), snowflakeMapString(secret, "passcode"))
	if account == "" || user == "" {
		return "", fmt.Errorf("snowflake SQL executor: account and user are required unless a DSN is supplied")
	}
	database := firstNonEmpty(configString(conn.Config, "database"), snowflakeMapString(secret, "database"))
	schema := firstNonEmpty(configString(conn.Config, "schema"), snowflakeMapString(secret, "schema"), "PUBLIC")
	var b strings.Builder
	fmt.Fprintf(&b, "%s:%s@%s/%s/%s", url.QueryEscape(user), url.QueryEscape(password), account, database, schema)
	q := url.Values{}
	if warehouse := firstNonEmpty(configString(conn.Config, "warehouse"), snowflakeMapString(secret, "warehouse")); warehouse != "" {
		q.Set("warehouse", warehouse)
	}
	if role := firstNonEmpty(configString(conn.Config, "role"), snowflakeMapString(secret, "role")); role != "" {
		q.Set("role", role)
	}
	if authenticator := snowflakeMapString(secret, "authenticator"); authenticator != "" {
		q.Set("authenticator", authenticator)
	}
	if token := firstNonEmpty(snowflakeMapString(secret, "token"), snowflakeMapString(secret, "access_token")); token != "" {
		q.Set("token", token)
	}
	if privateKeyPath := snowflakeMapString(secret, "private_key_path"); privateKeyPath != "" {
		q.Set("privateKeyPath", privateKeyPath)
	}
	if len(q) > 0 {
		b.WriteString("?" + q.Encode())
	}
	return b.String(), nil
}

func snowflakeCredentialPayload(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err == nil {
		return payload
	}
	if kv, ok := snowflakeCredentialKeyValuePayload(raw); ok {
		return kv
	}
	return map[string]any{"dsn": raw}
}

func snowflakeStatementIsQuery(statement SnowflakeProviderJobStatement) bool {
	phase := strings.TrimSpace(statement.Phase)
	if phase == "query" || phase == "validate_table" || phase == "health_check" {
		return true
	}
	sql := strings.ToUpper(strings.TrimSpace(statement.SQL))
	return strings.HasPrefix(sql, "SELECT ") || strings.HasPrefix(sql, "WITH ")
}

func countSnowflakeSQLRows(ctx context.Context, db *sql.DB, query string, limit int) (int64, error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	cols, err := rows.Columns()
	if err != nil {
		return 0, err
	}
	values := make([]any, len(cols))
	for i := range values {
		values[i] = new(any)
	}
	var count int64
	for rows.Next() {
		if err := rows.Scan(values...); err != nil {
			return count, err
		}
		count++
		if limit > 0 && count >= int64(limit) {
			break
		}
	}
	return count, rows.Err()
}

func snowflakeMapString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	value, ok := m[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []byte:
		return strings.TrimSpace(string(typed))
	default:
		out, err := json.Marshal(typed)
		if err != nil {
			return strings.TrimSpace(fmt.Sprint(typed))
		}
		return strings.Trim(strings.TrimSpace(string(out)), `"`)
	}
}

func snowflakeCredentialKeyValuePayload(raw string) (map[string]any, bool) {
	lines := strings.FieldsFunc(raw, func(r rune) bool {
		return r == '\n' || r == ';'
	})
	out := map[string]any{}
	recognized := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, false
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if !snowflakeCredentialKeyRecognized(key) {
			return nil, false
		}
		out[key] = value
		recognized = true
	}
	return out, recognized
}

func snowflakeCredentialKeyRecognized(key string) bool {
	switch key {
	case "dsn", "account", "user", "username", "password", "passcode", "database", "schema", "warehouse", "role", "authenticator", "token", "access_token", "private_key_path":
		return true
	default:
		return false
	}
}
