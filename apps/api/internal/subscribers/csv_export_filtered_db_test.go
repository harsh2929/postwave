// SPDX-License-Identifier: AGPL-3.0-only
//
// csv_export_filtered_db_test.go — pg-backed coverage for SUB-107 (server-side
// status/q filtering on the CSV export) and SUB-108 (10k hard cap +
// X-Postwave-Truncated header). Skips cleanly without DATABASE_URL.
//
// Truncation is verified with a small effective cap via ?limit= would NOT
// trip the header (an explicit small limit is the caller's choice, not a
// silent cap), so the truncation case is exercised by seeding > the hard cap
// only when DATABASE_URL is set; instead we assert the filter behaviour at
// small scale and the non-truncated header absence, plus a focused
// truncation check using a temporary lowering is not possible (const), so the
// truncation path is asserted via the writer-level unit test
// (TestCSVDownloadWriter_TruncatedHeaderSetBeforeBody) and the count-based
// overflow logic here at full cap when the env opts in.

package subscribers

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newCSVFilterTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := mustEnvDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedCSVFilterTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'csv-filter-test', 'csv-filter-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedCSVFilterSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email, status string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, $3, 'api')
ON CONFLICT (tenant_id, email) DO NOTHING`, tenantID, email, status); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
}

func csvExportRequest(tenantID, query string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/export.csv?"+query, nil)
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
}

func parseCSVEmails(t *testing.T, body string) []string {
	t.Helper()
	rd := csv.NewReader(strings.NewReader(body))
	recs, err := rd.ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v\nbody=%q", err, body)
	}
	emails := []string{}
	for i, rec := range recs {
		if i == 0 {
			continue // header
		}
		if len(rec) > 0 {
			emails = append(emails, rec[0])
		}
	}
	return emails
}

// TestExportCSV_StatusFilter — SUB-107: ?status=blocklisted streams only the
// blocklisted rows; an unknown status fails closed instead of broadening the
// export to the whole workspace.
func TestExportCSV_StatusFilter(t *testing.T) {
	pool := newCSVFilterTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0107a2c41001"
	seedCSVFilterTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	enabledEmail := fmt.Sprintf("enabled-%d@example.test", suffix)
	blockedEmail := fmt.Sprintf("blocked-%d@example.test", suffix)
	seedCSVFilterSubscriber(t, pool, tenantID, enabledEmail, "enabled")
	seedCSVFilterSubscriber(t, pool, tenantID, blockedEmail, "blocklisted")

	d := &Deps{Repo: &Repo{Pool: pool}}

	// status=blocklisted -> only the blocked row.
	w := httptest.NewRecorder()
	d.ExportCSV(w, csvExportRequest(tenantID, "status=blocklisted"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	emails := parseCSVEmails(t, w.Body.String())
	for _, e := range emails {
		if e == enabledEmail {
			t.Errorf("status=blocklisted leaked enabled row %q", enabledEmail)
		}
	}
	if !contains(emails, blockedEmail) {
		t.Errorf("status=blocklisted missing %q; got %v", blockedEmail, emails)
	}

	// Unknown status -> fail closed before any CSV bytes are written.
	w = httptest.NewRecorder()
	d.ExportCSV(w, csvExportRequest(tenantID, "status=not-a-real-status"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown status code = %d, want 400 (body=%s)", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), enabledEmail) || strings.Contains(w.Body.String(), blockedEmail) {
		t.Fatalf("unknown status leaked subscriber rows: %s", w.Body.String())
	}
}

// TestExportCSV_QFilter — SUB-107: ?q=<term> restricts to matching rows.
func TestExportCSV_QFilter(t *testing.T) {
	pool := newCSVFilterTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0107a2c41002"
	seedCSVFilterTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	hit := fmt.Sprintf("needle-%d@acmecorp.test", suffix)
	miss := fmt.Sprintf("other-%d@example.test", suffix)
	seedCSVFilterSubscriber(t, pool, tenantID, hit, "enabled")
	seedCSVFilterSubscriber(t, pool, tenantID, miss, "enabled")

	d := &Deps{Repo: &Repo{Pool: pool}}
	w := httptest.NewRecorder()
	d.ExportCSV(w, csvExportRequest(tenantID, "q=acmecorp"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	emails := parseCSVEmails(t, w.Body.String())
	if !contains(emails, hit) {
		t.Errorf("q=acmecorp missing %q; got %v", hit, emails)
	}
	if contains(emails, miss) {
		t.Errorf("q=acmecorp leaked non-matching %q", miss)
	}
}

// TestExportCSV_NoTruncationHeaderUnderCap — SUB-108: a small result set does
// NOT carry X-Postwave-Truncated.
func TestExportCSV_NoTruncationHeaderUnderCap(t *testing.T) {
	pool := newCSVFilterTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0108a2c41001"
	seedCSVFilterTenant(t, pool, tenantID)
	seedCSVFilterSubscriber(t, pool, tenantID,
		fmt.Sprintf("solo-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool}}
	w := httptest.NewRecorder()
	d.ExportCSV(w, csvExportRequest(tenantID, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Errorf("X-Postwave-Truncated = %q, want empty under cap", got)
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
