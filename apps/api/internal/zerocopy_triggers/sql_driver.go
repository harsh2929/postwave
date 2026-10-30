// SPDX-License-Identifier: AGPL-3.0-only
//
// sql_driver.go — a real database/sql-backed warehouse Driver, replacing the
// noop stub for the SQL-wire providers. It supports any provider that speaks a
// database/sql dialect: postgres + redshift today (Redshift is Postgres
// wire-compatible) via the linked pgx stdlib driver, plus the bundled
// gosnowflake driver registered under "snowflake".
//
// The Driver interface only receives the Trigger, so the SQLDriver carries its
// own seams: a ConnectionLookup (resolve t.ConnectionID -> connection record)
// and a CredentialResolver (resolve the connection's credentials_ref -> secret
// material). Both are injected when the driver is registered in main.go, which
// keeps this package decoupled from the warehouse + secret stores.

package zerocopy_triggers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver

	// Turns the Snowflake driver's native minicore loader off. The language
	// initializes this package before the driver, and it has to be: the
	// driver reads SF_DISABLE_MINICORE once, in its own init. This package's
	// test binary does not link internal/warehouse, so this is the only guard
	// import it has. See the package doc, and
	// TestTheSnowflakeDriverStartsWithItsMinicoreLoaderOff.
	_ "github.com/postwave/postwave/apps/api/internal/snowflakeminicore"
	"github.com/snowflakedb/gosnowflake"
)

// cursorPlaceholder is the token operators put in a trigger query where the
// last-seen cursor value should bind, e.g.
//
//	SELECT id, email, updated_at FROM events WHERE updated_at > :last_seen_cursor
const (
	cursorPlaceholder = ":last_seen_cursor"
	hardMaxSQLPools   = 256
)

// ConnInfo is the subset of a warehouse connection the SQL driver needs.
type ConnInfo struct {
	Provider       string
	Direction      string
	Status         string
	CredentialsRef string
	Config         map[string]any
}

// ConnectionLookup resolves a trigger's connection id to its record. The
// warehouse Repo satisfies this via a thin adapter wired in main.go.
type ConnectionLookup interface {
	LookupConnection(ctx context.Context, tenantID, connectionID string) (ConnInfo, error)
}

// CredentialResolver resolves a tenant-bound credentials_ref into secret
// material — e.g. {"password": "...", "read_only": true}. Production wires
// TenantSecretsCredentialResolver, which maps local labels into the canonical
// postwave/tenants/<tenant>/warehouse/read-only/<label> namespace. A resolved
// "dsn" key may be used directly only when it also satisfies the transport and
// read-only policies; otherwise the DSN is built from connection config.
type CredentialResolver interface {
	Resolve(ctx context.Context, tenantID, ref string) (map[string]any, error)
}

// SQLDriver is a database/sql-backed Driver. A registered instance is shared
// across ticks; it pools one *sql.DB per resolved DSN.
type SQLDriver struct {
	Lookup   ConnectionLookup
	Resolver CredentialResolver
	// DriverNames overrides the database/sql driver name per provider. Defaults:
	// postgres + redshift -> "pgx"; snowflake -> "snowflake".
	DriverNames map[string]string
	// MaxOpenPerPool bounds connections per warehouse DSN (default 4).
	MaxOpenPerPool int
	// QueryTimeout may lower the hard 30-second ceiling for tests or a
	// deployment. Values above the ceiling are clamped.
	QueryTimeout time.Duration

	mu    sync.Mutex
	pools map[string]*pooledDB // keyed by tenant id + connection id, NOT the DSN
}

// pooledDB caches a connection's *sql.DB alongside the DSN it was opened with,
// so a credential rotation (same connection, new DSN) reopens rather than
// leaking the old pool. Tenant-bound connection keys prevent cross-tenant pool
// reuse even if two tenants happen to use the same connection UUID.
type pooledDB struct {
	driver   string
	dsn      string
	db       *sql.DB
	lastUsed time.Time
}

func (d *SQLDriver) driverName(provider string) string {
	if d.DriverNames != nil {
		if n, ok := d.DriverNames[strings.ToLower(provider)]; ok {
			return n
		}
	}
	switch strings.ToLower(provider) {
	case "postgres", "redshift":
		return "pgx"
	case "snowflake":
		return "snowflake"
	default:
		return ""
	}
}

// Poll implements Driver. It looks up the connection, resolves credentials,
// builds a DSN, runs the templated query bound to the trigger's last-seen
// cursor, and maps each row to a DriverRow.
func (d *SQLDriver) Poll(ctx context.Context, t Trigger, max int) ([]DriverRow, error) {
	if d.Lookup == nil || d.Resolver == nil {
		return nil, fmt.Errorf("zerocopy sql driver: not configured (nil lookup/resolver)")
	}
	if strings.TrimSpace(t.ConnectionID) == "" {
		return nil, fmt.Errorf("zerocopy sql driver: trigger %q has no connection_id", t.ID)
	}
	if strings.TrimSpace(t.TenantID) == "" {
		return nil, fmt.Errorf("zerocopy sql driver: trigger %q has no tenant_id", t.ID)
	}
	if err := validateReadOnlyQuery(t.Query); err != nil {
		return nil, fmt.Errorf("zerocopy sql driver: query policy: %w", err)
	}
	conn, connectionErr := d.Lookup.LookupConnection(ctx, t.TenantID, t.ConnectionID)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy sql driver: lookup connection: %w", connectionErr)
	}
	if !strings.EqualFold(strings.TrimSpace(conn.Provider), strings.TrimSpace(t.Provider)) {
		return nil, fmt.Errorf("zerocopy sql driver: trigger provider %q does not match connection provider %q", t.Provider, conn.Provider)
	}
	if !strings.EqualFold(strings.TrimSpace(conn.Status), "active") {
		return nil, fmt.Errorf("zerocopy sql driver: warehouse connection must be active")
	}
	if direction := strings.ToLower(strings.TrimSpace(conn.Direction)); direction != "import" && direction != "bidirectional" {
		return nil, fmt.Errorf("zerocopy sql driver: warehouse connection direction must be import or bidirectional")
	}
	secret, connectionErr := d.Resolver.Resolve(ctx, t.TenantID, conn.CredentialsRef)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy sql driver: resolve credentials: %w", connectionErr)
	}
	if err := requireReadOnlyCredential(secret); err != nil {
		return nil, err
	}
	dsn, connectionErr := buildDSN(t.Provider, conn.Config, secret)
	if connectionErr != nil {
		return nil, connectionErr
	}
	db, connectionErr := d.dbFor(t.Provider, t.TenantID, t.ConnectionID, dsn)
	if connectionErr != nil {
		return nil, connectionErr
	}

	limit := effectivePollLimit(max)
	query, args := templateQueryForProvider(t.Provider, t.Query, t.LastSeenCursor, limit)
	timeout := d.QueryTimeout
	if timeout <= 0 || timeout > defaultWarehouseQueryTTL {
		timeout = defaultWarehouseQueryTTL
	}
	queryCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tx, connectionErr := db.BeginTx(queryCtx, &sql.TxOptions{ReadOnly: true})
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy sql driver: begin read-only transaction: %w", connectionErr)
	}
	defer func() { _ = tx.Rollback() }()
	rows, connectionErr := tx.QueryContext(queryCtx, query, args...)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy sql driver: query: %w", connectionErr)
	}
	defer func() { _ = rows.Close() }()

	cols, connectionErr := rows.Columns()
	if connectionErr != nil {
		return nil, connectionErr
	}
	out := make([]DriverRow, 0, limit)
	serializedBytes := 0
	for rows.Next() {
		holders := make([]any, len(cols))
		for i := range holders {
			holders[i] = new(any)
		}
		if err := rows.Scan(holders...); err != nil {
			return nil, err
		}
		payload := make(map[string]any, len(cols))
		for i, c := range cols {
			payload[c] = normalizeSQLValue(*(holders[i].(*any)))
		}
		serializedBytes, connectionErr = addSerializedPayloadBytes(payload, serializedBytes)
		if connectionErr != nil {
			return nil, fmt.Errorf("zerocopy sql driver: %w", connectionErr)
		}
		out = append(out, DriverRow{
			CursorValue: stringifyCell(payload[t.CursorColumn]),
			ProfileKey:  stringifyCell(payload[t.ProfileKeyColumn]),
			Payload:     payload,
		})
		if len(out) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("zerocopy sql driver: commit read-only transaction: %w", err)
	}
	return out, nil
}

// dbFor returns a pooled *sql.DB for the DSN, opening (and caching) one on
// first use. Keys bind tenant plus connection id, so equal connection UUIDs can
// never share a pool across tenants. A credential rotation reopens the same
// tenant/connection slot rather than orphaning the old pool.
func (d *SQLDriver) dbFor(provider, tenantID, connID, dsn string) (*sql.DB, error) {
	driver := d.driverName(provider)
	if driver == "" {
		return nil, fmt.Errorf("zerocopy sql driver: provider %q is not a SQL-wire provider", provider)
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(connID) == "" {
		return nil, fmt.Errorf("zerocopy sql driver: tenant_id and connection_id are required for pool isolation")
	}
	key := tenantID + "\x00" + connID
	d.mu.Lock()
	var stalePools []*sql.DB
	if d.pools == nil {
		d.pools = map[string]*pooledDB{}
	}
	if p, ok := d.pools[key]; ok {
		if p.driver == driver && p.dsn == dsn {
			p.lastUsed = time.Now()
			d.mu.Unlock()
			return p.db, nil
		}
		// DSN changed (credential/host rotation). Remove the stale pool while
		// holding the map lock, then close it after publishing the replacement.
		delete(d.pools, key)
		stalePools = append(stalePools, p.db)
	}
	if len(d.pools) >= hardMaxSQLPools {
		oldestKey := ""
		var oldest time.Time
		for candidateKey, candidate := range d.pools {
			if oldestKey == "" || candidate.lastUsed.Before(oldest) {
				oldestKey, oldest = candidateKey, candidate.lastUsed
			}
		}
		if oldestKey != "" {
			stalePools = append(stalePools, d.pools[oldestKey].db)
			delete(d.pools, oldestKey)
		}
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		d.mu.Unlock()
		for _, stale := range stalePools {
			_ = stale.Close()
		}
		// Some drivers include the submitted DSN in parse errors. Do not wrap
		// that error across the credential boundary where it can reach logs.
		return nil, fmt.Errorf("zerocopy sql driver: %s driver rejected the connection configuration", provider)
	}
	maxOpen := d.MaxOpenPerPool
	if maxOpen <= 0 {
		maxOpen = 4
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(2 * time.Minute)
	db.SetConnMaxLifetime(15 * time.Minute)
	d.pools[key] = &pooledDB{driver: driver, dsn: dsn, db: db, lastUsed: time.Now()}
	d.mu.Unlock()
	for _, stale := range stalePools {
		_ = stale.Close()
	}
	return db, nil
}

// templateQuery substitutes :last_seen_cursor with a positional placeholder and
// wraps it in an outer LIMIT. The cursor
// is passed as a bound parameter (never string-interpolated) so it is injection
// safe even though it is operator-controlled.
func templateQuery(query, cursor string, max int) (string, []any) {
	return templateQueryForProvider("postgres", query, cursor, max)
}

func templateQueryForProvider(provider, query, cursor string, max int) (string, []any) {
	q := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	var args []any
	if count := strings.Count(q, cursorPlaceholder); count > 0 {
		if strings.EqualFold(strings.TrimSpace(provider), "snowflake") {
			q = strings.ReplaceAll(q, cursorPlaceholder, "?")
			for range count {
				args = append(args, cursor)
			}
		} else {
			q = strings.ReplaceAll(q, cursorPlaceholder, "$1")
			args = append(args, cursor)
		}
	}
	if max > 0 {
		q = "SELECT * FROM (" + q + ") AS _zc_sub LIMIT " + strconv.Itoa(max)
	}
	return q, args
}

// buildDSN assembles a connection string from the connection Config + resolved
// secret. A secret "dsn" key is accepted only after provider-specific TLS,
// local-resource, and read-only normalization.
func buildDSN(provider string, config, secret map[string]any) (string, error) {
	if dsn := mapString(secret, "dsn"); dsn != "" {
		return validateReadOnlyDSN(provider, dsn)
	}
	switch strings.ToLower(provider) {
	case "postgres", "redshift":
		host := firstNonEmpty(mapString(config, "host"), mapString(secret, "host"))
		if host == "" {
			return "", fmt.Errorf("zerocopy sql driver: %s connection missing host", provider)
		}
		port := firstNonEmpty(mapString(config, "port"), "5439") // 5439 = Redshift default
		if strings.EqualFold(provider, "postgres") {
			port = firstNonEmpty(mapString(config, "port"), "5432")
		}
		dbName := firstNonEmpty(mapString(config, "database"), mapString(config, "dbname"))
		user := firstNonEmpty(mapString(secret, "user"), mapString(config, "user"))
		pass := mapString(secret, "password")
		sslmode := firstNonEmpty(mapString(config, "sslmode"), "verify-full")
		u := url.URL{
			Scheme: "postgres",
			Host:   host + ":" + port,
			Path:   "/" + dbName,
		}
		if user != "" {
			u.User = url.UserPassword(user, pass)
		}
		q := url.Values{}
		q.Set("sslmode", sslmode)
		q.Set("default_transaction_read_only", "on")
		u.RawQuery = q.Encode()
		return validateReadOnlyDSN(provider, u.String())
	case "snowflake":
		account := mapString(config, "account")
		user := firstNonEmpty(mapString(secret, "user"), mapString(config, "user"))
		pass := mapString(secret, "password")
		if account == "" || user == "" {
			return "", fmt.Errorf("zerocopy sql driver: snowflake connection missing account/user")
		}
		dsn, err := gosnowflake.DSN(&gosnowflake.Config{
			Account: account, User: user, Password: pass,
			Database:  mapString(config, "database"),
			Schema:    firstNonEmpty(mapString(config, "schema"), "PUBLIC"),
			Warehouse: mapString(config, "warehouse"), Role: mapString(config, "role"),
			Protocol: "https", OCSPFailOpen: gosnowflake.OCSPFailOpenFalse,
		})
		if err != nil {
			return "", fmt.Errorf("zerocopy sql driver: build snowflake DSN: %w", err)
		}
		return validateReadOnlyDSN(provider, dsn)
	default:
		return "", fmt.Errorf("zerocopy sql driver: no DSN builder for provider %q", provider)
	}
}

func validateReadOnlyDSN(provider, dsn string) (string, error) {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" || strings.ContainsAny(dsn, "\x00\r\n") {
		return "", fmt.Errorf("zerocopy sql driver: invalid DSN")
	}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "postgres", "redshift":
		u, err := url.Parse(dsn)
		if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" {
			return "", fmt.Errorf("zerocopy sql driver: postgres/redshift DSN must be an absolute postgres URL")
		}
		q := u.Query()
		sslmode := strings.ToLower(strings.TrimSpace(q.Get("sslmode")))
		if sslmode == "" {
			sslmode = "verify-full"
		}
		if sslmode != "verify-full" {
			return "", fmt.Errorf("zerocopy sql driver: postgres/redshift DSN must use sslmode=verify-full")
		}
		q.Set("sslmode", sslmode)
		q.Set("default_transaction_read_only", "on")
		u.RawQuery = q.Encode()
		return u.String(), nil
	case "snowflake":
		cfg, err := gosnowflake.ParseDSN(dsn)
		if err != nil {
			return "", fmt.Errorf("zerocopy sql driver: invalid snowflake DSN: %w", err)
		}
		if snowflakeLegacyInsecureModeEnabled(dsn) || cfg.DisableOCSPChecks || (cfg.Protocol != "" && !strings.EqualFold(cfg.Protocol, "https")) {
			return "", fmt.Errorf("zerocopy sql driver: snowflake DSN must use HTTPS with certificate revocation checks")
		}
		if cfg.TokenFilePath != "" || cfg.ClientConfigFile != "" || cfg.TmpDirPath != "" || cfg.TLSConfigName != "" || cfg.ProxyHost != "" {
			return "", fmt.Errorf("zerocopy sql driver: snowflake DSN cannot reference process-local files, TLS registrations, or a custom proxy")
		}
		cfg.Protocol = "https"
		cfg.DisableOCSPChecks = false
		cfg.OCSPFailOpen = gosnowflake.OCSPFailOpenFalse
		cfg.LogQueryText = false
		cfg.LogQueryParameters = false
		secureDSN, err := gosnowflake.DSN(cfg)
		if err != nil {
			return "", fmt.Errorf("zerocopy sql driver: normalize snowflake DSN: %w", err)
		}
		return secureDSN, nil
	default:
		return "", fmt.Errorf("zerocopy sql driver: no DSN policy for provider %q", provider)
	}
}

// snowflakeLegacyInsecureModeEnabled rejects the driver's deprecated
// insecureMode query parameter without reading its deprecated Config field.
// ParseDSN validates the parameter first; this helper preserves the fail-closed
// behavior while keeping the application on the supported DisableOCSPChecks
// surface.
func snowflakeLegacyInsecureModeEnabled(dsn string) bool {
	queryStart := strings.IndexByte(dsn, '?')
	if queryStart < 0 {
		return false
	}
	values, err := url.ParseQuery(dsn[queryStart+1:])
	if err != nil {
		return true
	}
	for key, candidates := range values {
		if !strings.EqualFold(key, "insecureMode") {
			continue
		}
		for _, candidate := range candidates {
			enabled, parseErr := strconv.ParseBool(candidate)
			if parseErr != nil || enabled {
				return true
			}
		}
	}
	return false
}

// --- small helpers (pure, unit-tested) ---

func mapString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok {
		return stringifyCell(v)
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// normalizeSQLValue makes scanned values JSON-friendly: []byte -> string.
func normalizeSQLValue(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

// stringifyCell renders a scanned cell as the string the cursor/profile-key
// columns expect. []byte and common scalar types are handled directly.
func stringifyCell(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	case fmt.Stringer:
		return t.String()
	default:
		if b, err := json.Marshal(v); err == nil {
			return strings.Trim(string(b), `"`)
		}
		return fmt.Sprintf("%v", v)
	}
}
