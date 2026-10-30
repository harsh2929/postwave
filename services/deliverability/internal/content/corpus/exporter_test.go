package corpus

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestExport_NilPool guards against the most common misuse: building
// an Exporter with a nil pool and calling Export. We want a clean
// error rather than a runtime nil-deref deep in pgx.
func TestExport_NilPool(t *testing.T) {
	e := &Exporter{}
	_, err := e.Export(context.Background(), time.Now().Add(-24*time.Hour))
	if err == nil {
		t.Fatal("expected error from Export with nil pool, got nil")
	}
	if !strings.Contains(err.Error(), "nil pool") {
		t.Fatalf("expected 'nil pool' in error, got %v", err)
	}
}

// TestNewExporter_NilPool similarly: constructing with a nil pool
// returns a nil Exporter so callers can detect misconfiguration.
func TestNewExporter_NilPool(t *testing.T) {
	if got := NewExporter(nil); got != nil {
		t.Fatalf("NewExporter(nil) = %v, want nil", got)
	}
}

// TestNewExporter_DefaultThresholds verifies the defaults match the
// values documented in the package comment so a downstream change
// doesn't silently shift label semantics.
func TestNewExporter_DefaultThresholds(t *testing.T) {
	// We need a non-nil pool, but we never actually issue a query.
	// pgxpool.ParseConfig accepts a synthetic DSN; pgxpool.New would
	// dial it. Skip the dial entirely by using a zero-value pool —
	// NewExporter only inspects nil-ness, not connectivity.
	pool := &pgxpool.Pool{} // intentionally non-nil zero value
	e := NewExporter(pool)
	if e == nil {
		t.Fatal("NewExporter returned nil for non-nil pool")
	}
	if e.SpamFolderThreshold != 0.70 {
		t.Errorf("SpamFolderThreshold default = %v, want 0.70", e.SpamFolderThreshold)
	}
	if e.PrimaryFolderThreshold != 0.70 {
		t.Errorf("PrimaryFolderThreshold default = %v, want 0.70", e.PrimaryFolderThreshold)
	}
}

// TestExport_AgainstLiveDatabase is an opt-in integration test: it
// runs only when POSTWAVE_TEST_DATABASE_URL is set. We do NOT
// require any specific schema; the exporter is documented to swallow
// "table does not exist" errors so a fresh DB returns zero rows
// without an error. This test asserts that promise.
func TestExport_AgainstLiveDatabase(t *testing.T) {
	dsn := os.Getenv("POSTWAVE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("POSTWAVE_TEST_DATABASE_URL not set; skipping live-DB exporter test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	e := NewExporter(pool)
	samples, err := e.Export(ctx, time.Now().Add(-30*24*time.Hour))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	// We don't assert on a specific count — the test database may
	// be empty. We only check the slice is well-formed.
	for i, s := range samples {
		if s.Source == "" {
			t.Errorf("sample[%d] missing source", i)
		}
		if s.Text == "" {
			t.Errorf("sample[%d] empty text", i)
		}
		if s.SampleAt.IsZero() {
			t.Errorf("sample[%d] zero SampleAt", i)
		}
	}
}
