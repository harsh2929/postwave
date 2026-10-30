package suppressions

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestLinkedLegacyMetadataOwnsIdentityLink(t *testing.T) {
	input := map[string]any{
		"diagnostic":                 "550 mailbox unavailable",
		legacyMirrorSuppressionIDKey: "caller-controlled-id",
	}
	linked := linkedLegacyMetadata(input, "canonical-id")

	if got := linked[legacyMirrorSuppressionIDKey]; got != "canonical-id" {
		t.Fatalf("identity link = %v, want canonical-id", got)
	}
	if got := input[legacyMirrorSuppressionIDKey]; got != "caller-controlled-id" {
		t.Fatalf("input metadata was mutated: identity link = %v", got)
	}
	linked["diagnostic"] = "changed"
	if got := input["diagnostic"]; got != "550 mailbox unavailable" {
		t.Fatalf("input metadata aliases linked copy: diagnostic = %v", got)
	}
}

func TestStoreRemoveDeletesOnlyIdentityLinkAndNeverReactivates(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	email := "remove-exact-" + randHex4(t) + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })

	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(txCtx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'blocklisted', 'unknown')`, tenantID, email); err != nil {
			t.Fatalf("seed subscriber: %v", err)
		}
	})

	canonical, err := store.Add(ctx, tenantID, email, ReasonHardBounce, SourceManual,
		"", nil, map[string]any{"signal": "reviewed"})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	// Same email does not establish identity. Preserve both an independent
	// legacy suppression with no link and one linked to another canonical ID.
	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(txCtx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES
  ($1::uuid, $2, 'manual', 'manual', '{"independent":true}'::jsonb),
  ($1::uuid, $2, 'complaint', 'manual',
   jsonb_build_object($3::text, gen_random_uuid()::text))`,
			tenantID, email, legacyMirrorSuppressionIDKey); err != nil {
			t.Fatalf("seed independent legacy suppressions: %v", err)
		}
	})

	if err := store.Remove(ctx, tenantID, email); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		var canonicalCount, linkedCount, legacyCount int
		var status string
		if err := tx.QueryRow(txCtx, `
SELECT count(*) FROM subscriber_suppressions
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, canonical.ID).Scan(&canonicalCount); err != nil {
			t.Fatalf("count canonical: %v", err)
		}
		if err := tx.QueryRow(txCtx, `
SELECT count(*) FILTER (WHERE metadata ->> $3 = $4), count(*)
FROM email_suppressions
WHERE tenant_id = $1::uuid AND email = $2::citext`,
			tenantID, email, legacyMirrorSuppressionIDKey, canonical.ID).Scan(&linkedCount, &legacyCount); err != nil {
			t.Fatalf("count legacy rows: %v", err)
		}
		if err := tx.QueryRow(txCtx, `
SELECT status FROM subscribers
WHERE tenant_id = $1::uuid AND email = $2::citext`, tenantID, email).Scan(&status); err != nil {
			t.Fatalf("subscriber status: %v", err)
		}
		if canonicalCount != 0 {
			t.Errorf("canonical selected row count = %d, want 0", canonicalCount)
		}
		if linkedCount != 0 {
			t.Errorf("legacy rows linked to deleted canonical = %d, want 0", linkedCount)
		}
		if legacyCount != 2 {
			t.Errorf("independent legacy row count = %d, want 2", legacyCount)
		}
		if status != "blocklisted" {
			t.Errorf("subscriber status = %q, want blocklisted", status)
		}
	})
}

func TestRemoveSelectedPreservesNewerSuppression(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	email := "remove-newer-" + randHex4(t) + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })

	if _, err := store.Add(ctx, tenantID, email, ReasonListManual, SourceManual,
		"", nil, map[string]any{"generation": "reviewed"}); err != nil {
		t.Fatalf("Add reviewed row: %v", err)
	}
	reviewed, err := store.FetchByEmail(ctx, tenantID, email)
	if err != nil || reviewed == nil {
		t.Fatalf("Fetch reviewed row = %+v, err %v", reviewed, err)
	}
	if reviewed.RowVersion == "" {
		t.Fatal("reviewed row has empty version token")
	}

	// Simulate a provider signal landing after the admin review but before
	// deletion. The unique (tenant,email) upsert keeps the UUID and changes the
	// MVCC version, which the compare-and-delete must detect.
	if _, err := store.Add(ctx, tenantID, email, ReasonHardBounce, SourcePostmark,
		"newer-event-"+randHex4(t), nil, map[string]any{"generation": "newer"}); err != nil {
		t.Fatalf("Add newer suppression: %v", err)
	}

	deleted, err := store.RemoveSelected(ctx, tenantID, reviewed)
	if deleted {
		t.Fatal("RemoveSelected deleted a stale reviewed row")
	}
	if !errors.Is(err, ErrSuppressionChanged) {
		t.Fatalf("RemoveSelected error = %v, want ErrSuppressionChanged", err)
	}
	current, err := store.FetchByEmail(ctx, tenantID, email)
	if err != nil || current == nil {
		t.Fatalf("Fetch current row = %+v, err %v", current, err)
	}
	if current.ID != reviewed.ID {
		t.Errorf("upsert row id = %q, want original %q", current.ID, reviewed.ID)
	}
	if current.Reason != ReasonHardBounce {
		t.Errorf("current reason = %q, want hard_bounce", current.Reason)
	}
	if current.RowVersion == reviewed.RowVersion {
		t.Errorf("row version did not change across newer upsert: %q", current.RowVersion)
	}

	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		var linkedLegacy int
		if err := tx.QueryRow(txCtx, `
SELECT count(*) FROM email_suppressions
WHERE tenant_id = $1::uuid AND email = $2::citext
  AND metadata ->> $3 = $4`, tenantID, email,
			legacyMirrorSuppressionIDKey, current.ID).Scan(&linkedLegacy); err != nil {
			t.Fatalf("count preserved legacy mirrors: %v", err)
		}
		if linkedLegacy < 1 {
			t.Errorf("linked legacy mirrors = %d, want at least 1", linkedLegacy)
		}
	})
}

func TestBulkRemoveSelectedPreservesStaleRowAndDeletesReviewedPeer(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	store := &Store{Pool: pool}
	staleEmail := "bulk-stale-" + randHex4(t) + "@example.com"
	freshEmail := "bulk-fresh-" + randHex4(t) + "@example.com"
	t.Cleanup(func() {
		_ = store.Remove(context.Background(), tenantID, staleEmail)
		_ = store.Remove(context.Background(), tenantID, freshEmail)
	})

	for _, email := range []string{staleEmail, freshEmail} {
		if _, err := store.Add(ctx, tenantID, email, ReasonListManual, SourceManual, "", nil, nil); err != nil {
			t.Fatalf("Add(%s): %v", email, err)
		}
	}
	stale, err := store.FetchByEmail(ctx, tenantID, staleEmail)
	if err != nil || stale == nil {
		t.Fatalf("Fetch stale selection = %+v, err %v", stale, err)
	}
	fresh, err := store.FetchByEmail(ctx, tenantID, freshEmail)
	if err != nil || fresh == nil {
		t.Fatalf("Fetch fresh selection = %+v, err %v", fresh, err)
	}
	if _, err := store.Add(ctx, tenantID, staleEmail, ReasonComplaint, SourcePostmark,
		"complaint-"+randHex4(t), nil, nil); err != nil {
		t.Fatalf("Add newer complaint: %v", err)
	}

	deletedIDs, rowErrors, err := store.BulkRemoveSelected(ctx, tenantID, []*Entry{stale, fresh})
	if err != nil {
		t.Fatalf("BulkRemoveSelected: %v", err)
	}
	if len(deletedIDs) != 1 || deletedIDs[0] != fresh.ID {
		t.Fatalf("deleted IDs = %v, want [%s]", deletedIDs, fresh.ID)
	}
	if len(rowErrors) != 1 || !strings.Contains(rowErrors[0], "changed after review") {
		t.Fatalf("row errors = %v, want one changed-after-review error", rowErrors)
	}
	current, err := store.FetchByEmail(ctx, tenantID, staleEmail)
	if err != nil || current == nil || current.Reason != ReasonComplaint {
		t.Fatalf("newer complaint was not preserved: row=%+v err=%v", current, err)
	}
	removed, err := store.FetchByEmail(ctx, tenantID, freshEmail)
	if err != nil || removed != nil {
		t.Fatalf("reviewed peer still exists: row=%+v err=%v", removed, err)
	}
}

func TestStoreHandlersForceRemovalRequiresSeparateReviewedResubscribe(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	store := &Store{Pool: pool}
	h := &StoreHandlers{Store: store}

	for _, reason := range []Reason{ReasonHardBounce, ReasonSpamComplaint, ReasonComplaint} {
		t.Run(string(reason), func(t *testing.T) {
			email := "force-" + strings.ReplaceAll(string(reason), "_", "-") + "-" + randHex4(t) + "@example.com"
			t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })
			withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
				if _, err := tx.Exec(txCtx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'blocklisted', 'unknown')`, tenantID, email); err != nil {
					t.Fatalf("seed subscriber: %v", err)
				}
			})
			if _, err := store.Add(ctx, tenantID, email, reason, SourceManual, "", nil, nil); err != nil {
				t.Fatalf("Add: %v", err)
			}

			withoutForce := suppressionRemoveRequest(ctx, tenantID, email, false)
			withoutForceW := httptest.NewRecorder()
			h.Remove(withoutForceW, withoutForce)
			if withoutForceW.Code != http.StatusConflict ||
				!strings.Contains(withoutForceW.Body.String(), "force_required") {
				t.Fatalf("without force: status=%d body=%s", withoutForceW.Code, withoutForceW.Body.String())
			}
			if row, err := store.FetchByEmail(ctx, tenantID, email); err != nil || row == nil {
				t.Fatalf("suppression removed without force: row=%+v err=%v", row, err)
			}

			withForce := suppressionRemoveRequest(ctx, tenantID, email, true)
			withForceW := httptest.NewRecorder()
			h.Remove(withForceW, withForce)
			if withForceW.Code != http.StatusOK {
				t.Fatalf("with force: status=%d body=%s", withForceW.Code, withForceW.Body.String())
			}
			body := withForceW.Body.String()
			if !strings.Contains(body, `"reviewed_resubscribe_required":true`) ||
				!strings.Contains(body, `"subscriber_status_changed":false`) {
				t.Fatalf("force response does not preserve separate resubscribe flow: %s", body)
			}
			if row, err := store.FetchByEmail(ctx, tenantID, email); err != nil || row != nil {
				t.Fatalf("reviewed suppression was not deleted: row=%+v err=%v", row, err)
			}
			withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
				var status string
				if err := tx.QueryRow(txCtx, `
SELECT status FROM subscribers
WHERE tenant_id = $1::uuid AND email = $2::citext`, tenantID, email).Scan(&status); err != nil {
					t.Fatalf("subscriber status: %v", err)
				}
				if status != "blocklisted" {
					t.Fatalf("subscriber status = %q, want blocklisted until separate resubscribe", status)
				}
			})
		})
	}

	t.Run("dsar_force_never_overrides_permanent", func(t *testing.T) {
		email := "force-dsar-" + randHex4(t) + "@example.com"
		if _, err := store.Add(ctx, tenantID, email, ReasonDSARDeletion, SourceManual, "", nil, nil); err != nil {
			t.Fatalf("Add DSAR suppression: %v", err)
		}
		r := suppressionRemoveRequest(ctx, tenantID, email, true)
		w := httptest.NewRecorder()
		h.Remove(w, r)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "not_reversible") {
			t.Fatalf("forced DSAR removal: status=%d body=%s", w.Code, w.Body.String())
		}
		if row, err := store.FetchByEmail(ctx, tenantID, email); err != nil || row == nil || row.Reason != ReasonDSARDeletion {
			t.Fatalf("DSAR suppression did not survive force: row=%+v err=%v", row, err)
		}
	})
}

func suppressionRemovalTestPool(t *testing.T) (context.Context, *db.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping PostgreSQL removal-safety test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func withSuppressionTenantTx(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string, fn func(context.Context, pgx.Tx)) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	fn(ctx, tx)
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant tx: %v", err)
	}
}

func suppressionRemoveRequest(ctx context.Context, tenantID, email string, force bool) *http.Request {
	path := "/api/v1/deliverability/suppressions/" + email
	if force {
		path += "?force=1"
	}
	r := httptest.NewRequest(http.MethodDelete, path, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("email", email)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	return r.WithContext(ctx)
}
