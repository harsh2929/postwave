// SPDX-License-Identifier: AGPL-3.0-only

package sar

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func erasureTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("set POSTWAVE_TEST_ADMIN_DATABASE_URL to the fully migrated fixture database")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var kindCol *string
	if err := pool.QueryRow(context.Background(),
		`SELECT column_name::text FROM information_schema.columns
		  WHERE table_name = 'sar_bundles' AND column_name = 'kind'`).Scan(&kindCol); err != nil {
		t.Fatalf("sar_bundles.kind missing: apply infra/migrations/1704_sar_erasure_integrity.sql")
	}
	return pool
}

// seedSubject creates a tenant with one subscriber and returns (tenantID, email).
func seedSubject(t *testing.T, pool *pgxpool.Pool) (string, string) {
	t.Helper()
	ctx := context.Background()

	var tenantID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier)
		VALUES ('erase-test-' || substr(md5(random()::text), 1, 8), 'Erase Test', 'studio')
		RETURNING id::text`).Scan(&tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	email := "alice.subject." + strings.ToLower(tenantID[:8]) + "@example.com"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'import')`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM sar_bundles WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(c, `DELETE FROM subscriber_suppressions WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(c, `DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(c, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID, email
}

func postSAR(t *testing.T, d *Deps, tenantID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sar/requests", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	rec := httptest.NewRecorder()
	d.Create(rec, req.WithContext(ctx))
	return rec
}

func TestCreateErasureFailsClosedBeforeDatabaseWork(t *testing.T) {
	d := &Deps{Logger: slog.Default()}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sar/requests", nil)
	rec := httptest.NewRecorder()

	d.createErasure(
		rec, req, nil,
		"00000000-0000-0000-0000-000000000001",
		"subject@example.test", "admin:test", createReq{Kind: kindErase},
	)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"erasure_coverage_incomplete"`) {
		t.Fatalf("missing stable fail-closed code: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "subject@example.test") {
		t.Fatalf("fail-closed response leaked subject email: %s", rec.Body.String())
	}
}

// Until every retained history/content store has an approved transactional
// policy, an erase request must leave both the subject and receipt stores
// untouched. A partial scrub reported as success is worse than an explicit,
// retryable conflict.
func TestCreate_Erase_FailsClosedWithoutPartialMutationOrReceipt(t *testing.T) {
	pool := erasureTestPool(t)
	tenantID, email := seedSubject(t, pool)
	d := &Deps{Pool: pool, Logger: slog.Default()}
	ctx := context.Background()

	rec := postSAR(t, d, tenantID, `{"email":"`+email+`","kind":"erase"}`)
	if rec.Code != http.StatusConflict ||
		!strings.Contains(rec.Body.String(), `"code":"erasure_coverage_incomplete"`) {
		t.Fatalf("erase request did not fail closed: got %d, body %s", rec.Code, rec.Body.String())
	}

	var live, receipts, tombstones int
	if err := pool.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)),
  (SELECT count(*) FROM sar_bundles WHERE tenant_id=$1::uuid AND kind='erase'),
  (SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND reason='dsar_deletion')`,
		tenantID, email).Scan(&live, &receipts, &tombstones); err != nil {
		t.Fatal(err)
	}
	if live != 1 || receipts != 0 || tombstones != 0 {
		t.Fatalf("fail-closed state subscriber=%d receipts=%d tombstones=%d, want 1/0/0", live, receipts, tombstones)
	}
}

// The access/export path must be untouched: it still returns the full bundle.
func TestCreate_Access_StillBuildsTheFullBundle(t *testing.T) {
	pool := erasureTestPool(t)
	tenantID, email := seedSubject(t, pool)
	d := &Deps{Pool: pool, Logger: slog.Default()}

	rec := postSAR(t, d, tenantID, `{"email":"`+email+`","kind":"access"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("access request: got %d, body %s", rec.Code, rec.Body.String())
	}
	var response struct {
		Kind        string `json:"kind"`
		DownloadURL string `json:"download_url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode access response: %v", err)
	}
	if response.Kind != "access" || response.DownloadURL == "" {
		t.Fatalf("access response kind/download = %q/%q", response.Kind, response.DownloadURL)
	}

	var kind string
	var rowsDeleted *int64
	if err := pool.QueryRow(context.Background(), `
		SELECT kind, rows_deleted FROM sar_bundles
		 WHERE tenant_id = $1::uuid ORDER BY requested_at DESC LIMIT 1`,
		tenantID).Scan(&kind, &rowsDeleted); err != nil {
		t.Fatal(err)
	}
	if kind != "access" {
		t.Fatalf("kind = %q, want access", kind)
	}
	if rowsDeleted != nil {
		t.Fatalf("an access request must not report rows_deleted, got %d", *rowsDeleted)
	}

	// The subscriber must still be there — an export erases nothing.
	var live int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM subscribers
		 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`,
		tenantID, email).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 1 {
		t.Fatalf("an access export must not delete the subject (found %d rows)", live)
	}
}

// The optional disclosure sections must actually DISCLOSE.
//
// bounce_events and complaint_events ordered by a column (`at`) that has never
// existed on either table, so both sections silently returned nothing — and
// because loadOptionalEmail had no savepoint, the failure aborted the whole
// transaction and 500'd every subject-access export. A disclosure that omits
// the subject's bounce history is an incomplete Art. 15 response.
func TestCreate_Access_IncludesBounceAndComplaintHistory(t *testing.T) {
	pool := erasureTestPool(t)
	tenantID, email := seedSubject(t, pool)
	d := &Deps{Pool: pool, Logger: slog.Default()}
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO bounce_events (tenant_id, subscriber_email, bounce_type, esp, raw)
		VALUES ($1::uuid, $2::citext, 'hard', 'ses', '{}'::jsonb)`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed bounce: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO complaint_events (tenant_id, subscriber_email, complaint_type, esp, raw)
		VALUES ($1::uuid, $2::citext, 'abuse', 'ses', '{}'::jsonb)`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed complaint: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM bounce_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = pool.Exec(c, `DELETE FROM complaint_events WHERE tenant_id = $1::uuid`, tenantID)
	})

	rec := postSAR(t, d, tenantID, `{"email":"`+email+`","kind":"access"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("access request: got %d, body %s", rec.Code, rec.Body.String())
	}

	var bundle []byte
	if err := pool.QueryRow(ctx, `
		SELECT bundle::text::bytea FROM sar_bundles
		 WHERE tenant_id = $1::uuid ORDER BY requested_at DESC LIMIT 1`,
		tenantID).Scan(&bundle); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(bundle, &got); err != nil {
		t.Fatal(err)
	}

	for _, section := range []string{"bounce_events", "complaint_events"} {
		rows, ok := got[section].([]any)
		if !ok || len(rows) == 0 {
			t.Fatalf("the disclosure omits %q — an Art. 15 response that hides the subject's %s is incomplete", section, section)
		}
	}
}

func TestCreate_RejectsMissingKindBeforeDatabaseWork(t *testing.T) {
	d := &Deps{Logger: slog.Default()}
	rec := postSAR(t, d, "00000000-0000-0000-0000-000000000001", `{"email":"subject@example.com"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a missing kind must be refused, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_kind") {
		t.Fatalf("missing kind returned the wrong contract: %s", rec.Body.String())
	}
}

func TestCreate_RejectsUnknownKindBeforeDatabaseWork(t *testing.T) {
	d := &Deps{Logger: slog.Default()}
	rec := postSAR(t, d, "00000000-0000-0000-0000-000000000001", `{"email":"subject@example.com","kind":"destroy"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an unknown kind must be refused, got %d", rec.Code)
	}
}

func TestCreate_RejectsConnectedStoreErasureBeforeDatabaseWork(t *testing.T) {
	d := &Deps{Logger: slog.Default()}
	rec := postSAR(t, d, "00000000-0000-0000-0000-000000000001", `{"email":"subject@example.com","kind":"erase","fanout_enabled":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unsupported connected-store erasure must be refused, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "erase_fanout_unsupported") {
		t.Fatalf("erase fanout returned the wrong contract: %s", rec.Body.String())
	}
}
