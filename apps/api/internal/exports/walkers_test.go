// SPDX-License-Identifier: AGPL-3.0-only
//
// walkers_test.go — coverage for the export walkers.
//
//   - Pure tests: the new "take everything" resources are advertised in
//     SupportedResources and accepted by isSupported (no DB needed).
//   - DB-gated tests (skipped unless DATABASE_URL is set): every new
//     walker streams against its real table and degrades gracefully —
//     an empty table writes a header-less / empty file with zero rows
//     and never errors the ZIP; an ABSENT table writes a note row and
//     returns 0 rows rather than failing the whole bundle.

package exports

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newResources are the resources added for the "export everything"
// (no-lock-in) work. Kept in one place so both the pure and DB-gated
// tests iterate the same set.
var newResources = []string{"templates", "segments", "forms", "suppressions", "consent"}

func TestNewResourcesAreSupported(t *testing.T) {
	for _, r := range newResources {
		if !isSupported(r) {
			t.Errorf("resource %q not advertised in SupportedResources", r)
		}
	}
}

func TestSupportedResourcesIncludesLegacyAndNew(t *testing.T) {
	// Backward compatibility: the original 7 resources must remain.
	for _, r := range []string{
		"subscribers", "campaigns", "automations", "audit_log",
		"lists", "tags", "events",
	} {
		if !isSupported(r) {
			t.Errorf("legacy resource %q dropped from SupportedResources", r)
		}
	}
}

func newExportTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed export walker tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestNewWalkersDegradeGracefully runs every new walker against its real
// table under a tenant GUC that matches no rows. Each must return no error
// and create exactly one file in the zip (empty or note-only is fine).
func TestNewWalkersDegradeGracefully(t *testing.T) {
	pool := newExportTestPool(t)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	// A random tenant id that owns no rows — exercises the zero-row path.
	const emptyTenant = "00000000-0000-0000-0000-0000000000ff"
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, emptyTenant); err != nil {
		t.Fatalf("set guc: %v", err)
	}

	w := &Worker{}
	for _, resource := range newResources {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		count, err := w.walkResource(ctx, conn, emptyTenant, resource, zw)
		if err != nil {
			t.Fatalf("walkResource(%q) errored on empty tenant: %v", resource, err)
		}
		if count != 0 {
			t.Errorf("walkResource(%q) on empty tenant returned %d rows, want 0", resource, count)
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zip close (%q): %v", resource, err)
		}
		zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
		if err != nil {
			t.Fatalf("zip read (%q): %v", resource, err)
		}
		if len(zr.File) != 1 {
			t.Errorf("walkResource(%q) wrote %d files, want exactly 1", resource, len(zr.File))
		}
	}
}

// TestWalkRowsMissingTableIsNonFatal asserts the absent-table path: a SELECT
// against a table that does not exist writes a note row and returns 0 rows
// with no error, so the ZIP still succeeds for the resources that DO exist.
func TestWalkRowsMissingTableIsNonFatal(t *testing.T) {
	pool := newExportTestPool(t)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	count, err := walkRows(ctx, conn, zw, "ghost.jsonl",
		`SELECT 1 FROM table_that_does_not_exist_xyz WHERE tenant_id = $1::uuid`,
		"00000000-0000-0000-0000-0000000000ff")
	if err != nil {
		t.Fatalf("walkRows on missing table errored: %v", err)
	}
	if count != 0 {
		t.Errorf("count = %d, want 0 for missing table", count)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip read: %v", err)
	}
	if len(zr.File) != 1 || zr.File[0].Name != "ghost.jsonl" {
		t.Fatalf("expected one ghost.jsonl placeholder file, got %+v", zr.File)
	}
}
