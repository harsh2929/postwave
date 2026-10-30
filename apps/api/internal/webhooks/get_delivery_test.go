package webhooks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func randHex4WH(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// --- Handler guard tests (no DB) -------------------------------------------

// A request without a tenant context short-circuits to 401 before any param
// parsing or Repo access (Repo is nil here).
func TestGetDelivery_401WithoutTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/webhooks/wh_1/deliveries/5", nil)
	rec := httptest.NewRecorder()
	d.GetDelivery(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// A non-integer delivery_id is rejected with 400 before the Repo is touched.
func TestGetDelivery_400BadDeliveryID(t *testing.T) {
	d := &Deps{} // Repo unused: the parse fails before any Repo call.
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Get("/api/v1/webhooks/{id}/deliveries/{delivery_id}", d.GetDelivery)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/webhooks/wh_1/deliveries/not-an-int", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_id") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// --- DB-backed repo test (gated on DATABASE_URL) ---------------------------

// Verifies the SETA-004 query: retained/not-retained payload mapping + the
// tenant+webhook scoping (a mismatched webhook or tenant yields ErrNotFound,
// never another webhook's delivery).
func TestGetDeliveryDetail_DB(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping webhook delivery-detail database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var hasCol bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM information_schema.columns
	WHERE table_name = 'webhook_deliveries' AND column_name = 'payload_bytes')`).Scan(&hasCol); err != nil || !hasCol {
		t.Fatalf("webhook_deliveries.payload_bytes not present; apply migration 0050")
	}

	// The id is minted HERE, not by the database.
	//
	// The tenants INSERT policy is `id = current_setting('app.tenant_id')`, and
	// a `RETURNING id` insert cannot satisfy it: the value does not exist until
	// after the row is written, so the GUC can never name it in advance. Every
	// seed was refused and the Skipf reported it as a PASS.
	tenantID := uuid.NewString()
	slug := "wh-seta004-" + randHex4WH(t)
	seedTx, seedErr := pool.Begin(ctx)
	if seedErr != nil {
		t.Fatalf("begin webhook tenant seed: %v", seedErr)
	}
	if _, err := seedTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("scope webhook tenant seed: %v", err)
	}
	if _, err := seedTx.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $3, 'studio')`,
		tenantID, "SETA-004 test", slug); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit webhook tenant seed: %v", err)
	}
	t.Cleanup(func() { deleteWebhookTestTenant(t, pool, tenantID) })

	repo := &Repo{Pool: pool}
	wh, err := repo.Create(ctx, tenantID, CreateInput{
		URL:    "https://consumer.example/webhook",
		Events: []EventType{EventSubscriberCreated},
	}, "sha256:deadbeef", nil)
	if err != nil {
		t.Fatalf("create webhook: %v", err)
	}

	body := []byte(`{"id":"evt_1","type":"subscriber.created"}`)
	if err := repo.RecordDeliveryWithPayload(ctx, tenantID, Delivery{
		WebhookID: wh.ID, Event: "subscriber.created", StatusCode: 200, Attempt: 1, ResponseMS: 42,
	}, body); err != nil {
		t.Fatalf("record retained delivery: %v", err)
	}
	if err := repo.RecordDelivery(ctx, tenantID, Delivery{
		WebhookID: wh.ID, Event: "subscriber.created", StatusCode: 500, Attempt: 2, ResponseMS: 99, Error: "boom",
	}); err != nil {
		t.Fatalf("record unretained delivery: %v", err)
	}

	list, err := repo.ListDeliveries(ctx, tenantID, wh.ID, 100, 0)
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %d rows, err = %v", len(list), err)
	}
	var retainedID, unretainedID int64
	for _, d := range list {
		if d.StatusCode == 200 {
			retainedID = d.ID
		} else {
			unretainedID = d.ID
		}
	}

	// Happy path: retained payload comes back verbatim with PayloadRetained=true.
	got, err := repo.GetDeliveryDetail(ctx, tenantID, wh.ID, retainedID)
	if err != nil {
		t.Fatalf("get retained: %v", err)
	}
	if !got.PayloadRetained || got.RequestBody != string(body) {
		t.Fatalf("retained detail = %+v", got)
	}
	if got.StatusCode != 200 || got.Attempt != 1 || got.ResponseMS != 42 || got.Event != "subscriber.created" {
		t.Fatalf("retained metadata mismatch: %+v", got)
	}

	// Not retained: metadata intact, PayloadRetained=false, empty body (NOT 404).
	gotU, err := repo.GetDeliveryDetail(ctx, tenantID, wh.ID, unretainedID)
	if err != nil {
		t.Fatalf("get unretained: %v", err)
	}
	if gotU.PayloadRetained || gotU.RequestBody != "" {
		t.Fatalf("unretained should carry no body: %+v", gotU)
	}
	if gotU.StatusCode != 500 || gotU.Error != "boom" {
		t.Fatalf("unretained metadata mismatch: %+v", gotU)
	}

	zeroUUID := "00000000-0000-0000-0000-000000000000"
	// Right delivery id but WRONG webhook → ErrNotFound (webhook_id scoping).
	if _, err := repo.GetDeliveryDetail(ctx, tenantID, zeroUUID, retainedID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-webhook err = %v, want ErrNotFound", err)
	}
	// Unknown delivery id → ErrNotFound.
	if _, err := repo.GetDeliveryDetail(ctx, tenantID, wh.ID, 999999999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown-id err = %v, want ErrNotFound", err)
	}
	// Different tenant → ErrNotFound (tenant scoping).
	if _, err := repo.GetDeliveryDetail(ctx, zeroUUID, wh.ID, retainedID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant err = %v, want ErrNotFound", err)
	}
}

// deleteWebhookTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteWebhookTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteWebhookTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteWebhookTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
