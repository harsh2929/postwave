package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestDBRollbackRehearsalBlocksEditedListAndPilotEvidence(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL/DATABASE_URL are required")
	}

	ctx := context.Background()
	admin, err := sql.Open("pgx", adminURL)
	if err != nil {
		t.Fatalf("open admin database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	app, err := sql.Open("pgx", appURL)
	if err != nil {
		t.Fatalf("open application database: %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	if err := admin.PingContext(ctx); err != nil {
		t.Fatalf("ping admin database: %v", err)
	}
	if err := app.PingContext(ctx); err != nil {
		t.Fatalf("ping application database: %v", err)
	}
	var appRole string
	if err := app.QueryRowContext(ctx, `SELECT current_user`).Scan(&appRole); err != nil {
		t.Fatalf("read application role: %v", err)
	}
	if appRole != "postwave_app" {
		t.Skipf("application connection uses %q, want postwave_app", appRole)
	}

	tenantID := uuid.NewString()
	jobID := uuid.NewString()
	_, err = admin.ExecContext(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Rollback rehearsal conflict test', 'studio')`, tenantID, "rollback-rehearsal-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	_, err = admin.ExecContext(ctx, `
INSERT INTO migration_jobs (id, tenant_id, source, status)
VALUES ($1::uuid, $2::uuid, 'customerio', 'completed')`, jobID, tenantID)
	if err != nil {
		t.Fatalf("create migration job: %v", err)
	}

	const (
		destinationID = "42"
		sourceID      = "audience-1"
		name          = "Customer.io audience"
	)
	fingerprint := rollbackRehearsalOwnershipFingerprint("list", tenantID, jobID, string(canonical.SourceCustomerIO), sourceID, name)
	metadata, err := json.Marshal(map[string]interface{}{
		"operation":             "created",
		"name":                  name,
		"ownership_fingerprint": fingerprint,
	})
	if err != nil {
		t.Fatalf("marshal list rollback metadata: %v", err)
	}
	_, err = admin.ExecContext(ctx, `
INSERT INTO migration_imported_resources
       (tenant_id, job_id, resource_type, source_platform, source_id,
        destination_type, destination_id, destination_metadata)
VALUES ($1::uuid, $2::uuid, $3, 'customerio', $4, $5, $6, $7::jsonb)`,
		tenantID, jobID, listmonkx.ResourceList, sourceID, listmonkx.DestinationListmonkList, destinationID, string(metadata))
	if err != nil {
		t.Fatalf("create list rollback ledger: %v", err)
	}

	exactDescription := fmt.Sprintf("Moosewave migration-owned audience; tenant=%s; job=%s; source=%s; source_id=%s; fingerprint=%s; activation requires Moosewave review",
		tenantID, jobID, canonical.SourceCustomerIO, sourceID, fingerprint)
	exactList := listmonkx.ListResponse{
		ID:          42,
		Name:        rollbackRehearsalScopedSourceName(name, jobID, sourceID),
		Type:        "private",
		Optin:       "single",
		Tags:        []string{"postwave-migration", "tenant:" + tenantID, "postwave-fingerprint:" + fingerprint},
		Description: exactDescription,
	}
	var edited atomic.Bool
	var requests atomic.Int32
	var mutationAttempted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet {
			mutationAttempted.Store(true)
			http.Error(w, "rehearsal must be read-only", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/api/lists/42" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		current := exactList
		if edited.Load() {
			current.Description = "operator edited this destination list"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": current})
	}))
	t.Cleanup(server.Close)

	completedAt := time.Now().UTC().Add(-time.Minute)
	rollbackUntil := completedAt.Add(24 * time.Hour)
	deltaMode := runModeDeltaImport
	job := &canonical.MigrationJob{
		ID:            jobID,
		TenantID:      tenantID,
		Source:        canonical.SourceCustomerIO,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Cursor:        map[string]*string{runModeCursorKey: &deltaMode},
		Progress:      canonical.MigrationProgress{SubscribersDone: 1},
		VerificationReport: &canonical.VerificationReport{
			SubscribersImported: 1,
		},
	}
	store := jobstore.NewMemoryJobStore()
	if err := store.Create(jobstore.WithTenantID(ctx, tenantID), job); err != nil {
		t.Fatalf("create in-memory migration job: %v", err)
	}
	h := NewMigrationWithDB("", store, app)
	h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
		return &listmonkx.Client{
			BaseURL:           server.URL,
			HTTPClient:        server.Client(),
			DedicatedTenant:   true,
			DedicatedTenantID: tenantID,
		}, nil
	})
	router := chi.NewRouter()
	h.Mount(router)

	runRehearsal := func() RollbackRehearsalReport {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/rollback-rehearsal", nil)
		req.Header.Set("X-Tenant-ID", tenantID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("rollback rehearsal status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var report RollbackRehearsalReport
		if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
			t.Fatalf("decode rollback rehearsal: %v", err)
		}
		return report
	}
	runPilotAcceptance := func() PilotAcceptanceReport {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/migrations/"+jobID+"/pilot-acceptance", nil)
		req.Header.Set("X-Tenant-ID", tenantID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("pilot acceptance status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var report PilotAcceptanceReport
		if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
			t.Fatalf("decode pilot acceptance: %v", err)
		}
		return report
	}

	report := runRehearsal()
	if report.Status != "pass" || rollbackItemByKey(report, "destination_preflight").Status != "pass" {
		t.Fatalf("exact destination rehearsal = %+v, want pass", report)
	}
	stored, err := store.Get(jobstore.WithTenantID(ctx, tenantID), jobID)
	if err != nil {
		t.Fatalf("get passed rehearsal job: %v", err)
	}
	if validation, ok := cursorString(stored.Cursor, rollbackRehearsalValidationKey); !ok || validation != rollbackRehearsalValidationV1 {
		t.Fatalf("destination validation evidence = %q/%v, want current version", validation, ok)
	}
	if item := pilotItemByKey(BuildPilotAcceptanceReport(stored), "rollback_rehearsal"); item.Status != "pass" {
		t.Fatalf("pilot rollback item after exact rehearsal = %+v, want pass", item)
	}

	edited.Store(true)
	pilot := runPilotAcceptance()
	pilotRehearsal := pilotItemByKey(pilot, "rollback_rehearsal")
	if pilot.Status != "blocker" || pilot.Blockers == 0 || pilotRehearsal.Status != "blocker" || !strings.Contains(pilotRehearsal.Detail, "no longer matches") {
		t.Fatalf("pilot acceptance after destination edit = status=%s blockers=%d item=%+v, want current-state blocker", pilot.Status, pilot.Blockers, pilotRehearsal)
	}
	stored, err = store.Get(jobstore.WithTenantID(ctx, tenantID), jobID)
	if err != nil {
		t.Fatalf("get job after pilot recheck: %v", err)
	}
	if validation, ok := cursorString(stored.Cursor, rollbackRehearsalValidationKey); !ok || validation != rollbackRehearsalValidationV1 {
		t.Fatalf("pilot recheck mutated persisted validation evidence = %q/%v, want unchanged current version", validation, ok)
	}

	report = runRehearsal()
	preflight := rollbackItemByKey(report, "destination_preflight")
	if report.Status != "blocker" || preflight.Status != "blocker" || !strings.Contains(preflight.Detail, "no longer matches") {
		t.Fatalf("edited destination rehearsal = %+v, want ownership conflict blocker", report)
	}
	stored, err = store.Get(jobstore.WithTenantID(ctx, tenantID), jobID)
	if err != nil {
		t.Fatalf("get blocked rehearsal job: %v", err)
	}
	if validation, ok := cursorString(stored.Cursor, rollbackRehearsalValidationKey); ok || validation != "" {
		t.Fatalf("stale destination validation evidence = %q/%v, want removed", validation, ok)
	}
	if item := pilotItemByKey(BuildPilotAcceptanceReport(stored), "rollback_rehearsal"); item.Status != "blocker" {
		t.Fatalf("pilot rollback item after edited destination = %+v, want blocker", item)
	}
	if mutationAttempted.Load() {
		t.Fatal("rollback rehearsal attempted a destination mutation")
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("Listmonk request count = %d, want one read per rehearsal/recheck", got)
	}
	var activeLedgerRows int
	if err := admin.QueryRowContext(ctx, `
SELECT count(*)
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND rolled_back_at IS NULL`, tenantID, jobID).Scan(&activeLedgerRows); err != nil {
		t.Fatalf("count active rollback ledger rows: %v", err)
	}
	if activeLedgerRows != 1 {
		t.Fatalf("active rollback ledger rows = %d, want unchanged 1", activeLedgerRows)
	}
}

func rollbackRehearsalOwnershipFingerprint(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = hash.Write([]byte(strconv.Itoa(len(part))))
		_, _ = hash.Write([]byte{':'})
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func rollbackRehearsalScopedSourceName(name, jobID, sourceID string) string {
	shortJobID := jobID
	if len(shortJobID) > 8 {
		shortJobID = shortJobID[:8]
	}
	sourceDigest := sha256.Sum256([]byte(sourceID))
	return fmt.Sprintf("%s (migration %s) [source %s]", name, shortJobID, hex.EncodeToString(sourceDigest[:4]))
}
