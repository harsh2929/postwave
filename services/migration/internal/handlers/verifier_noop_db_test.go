package handlers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"testing"
)

const verifierNoopDriverName = "postwave-verifier-noop"

func init() {
	sql.Register(verifierNoopDriverName, verifierNoopDriver{})
}

// newVerifierNoopDB gives worker-control tests a valid database/sql handle.
// The tests block in the source adapter before any destination persistence;
// only the verifier's empty checkpoint transaction is exercised.
func newVerifierNoopDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open(verifierNoopDriverName, "")
	if err != nil {
		t.Fatalf("open verifier no-op DB: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

type verifierNoopDriver struct{}

func (verifierNoopDriver) Open(string) (driver.Conn, error) {
	return verifierNoopConn{}, nil
}

type verifierNoopConn struct{}

func (verifierNoopConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (verifierNoopConn) Close() error { return nil }

func (verifierNoopConn) Begin() (driver.Tx, error) { return verifierNoopTx{}, nil }

func (verifierNoopConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return verifierNoopTx{}, nil
}

func (verifierNoopConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (verifierNoopConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(query, "pg_try_advisory_lock") || strings.Contains(query, "pg_advisory_unlock") {
		return &verifierNoopBoolRows{}, nil
	}
	return verifierNoopRows{}, nil
}

type verifierNoopTx struct{}

func (verifierNoopTx) Commit() error   { return nil }
func (verifierNoopTx) Rollback() error { return nil }

type verifierNoopRows struct{}

func (verifierNoopRows) Columns() []string { return []string{"subscriber"} }
func (verifierNoopRows) Close() error      { return nil }
func (verifierNoopRows) Next([]driver.Value) error {
	return io.EOF
}

type verifierNoopBoolRows struct {
	read bool
}

func (*verifierNoopBoolRows) Columns() []string { return []string{"locked"} }
func (*verifierNoopBoolRows) Close() error      { return nil }
func (r *verifierNoopBoolRows) Next(dst []driver.Value) error {
	if r.read {
		return io.EOF
	}
	r.read = true
	dst[0] = true
	return nil
}
