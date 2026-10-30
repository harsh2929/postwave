package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	csvadapter "github.com/postwave/migrate/csv"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/uploadstore"
)

func uploadTestRequest(h *Migration, tenant, method, path, body, contentRange string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Tenant-ID", tenant)
	if contentRange != "" {
		req.Header.Set("Content-Range", contentRange)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

type failUploadSessionOnce struct {
	jobstore.MigrationJobStore
	failed bool
}

func (s *failUploadSessionOnce) SaveSession(ctx context.Context, job, tenant string, sess adapter.Session, expiry time.Time) error {
	if !s.failed {
		s.failed = true
		return errors.New("injected session persistence failure")
	}
	return s.MigrationJobStore.SaveSession(ctx, job, tenant, sess, expiry)
}

func TestUploadCompletionRecoversSessionWriteFailureWithoutDuplicatingJob(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "test")
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND", "filesystem")
	base := jobstore.NewMemoryJobStore()
	fault := &failUploadSessionOnce{MigrationJobStore: base}
	h := NewMigration("", fault)
	body := "email,status\none@example.test,subscribed\n"
	url := "/v1/migrations/csv/uploads/retry"
	if rec := uploadTestRequest(h, "tenant", http.MethodPut, url+"?filename=x.csv", body, fmt.Sprintf("bytes 0-%d/%d", len(body)-1, len(body))); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if rec := uploadTestRequest(h, "tenant", http.MethodPost, url+"/complete", "", ""); rec.Code != 500 {
		t.Fatal("fault was not observed", rec.Code, rec.Body.String())
	}
	h = NewMigration("", base)
	rec := uploadTestRequest(h, "tenant", http.MethodPost, url+"/complete", "", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var response map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	jobID := response["job_id"]
	if jobs, err := base.List(context.Background(), "tenant"); err != nil || len(jobs) != 1 {
		t.Fatal("duplicate jobs", len(jobs), err)
	}
	sess, err := h.loadSession(context.Background(), "tenant", jobID)
	if err != nil {
		t.Fatal(err)
	}
	mapping, err := csvadapter.DecodeMapping(sess.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	mapping.Columns[1].Kind = csvadapter.KindCustom
	mapping.Columns[1].CustomKey = "reviewed_status"
	sess.AccessToken, err = csvadapter.EncodeMapping(mapping)
	if err != nil {
		t.Fatal(err)
	}
	if err := base.SaveSession(context.Background(), jobID, "tenant", sess, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if rec := uploadTestRequest(h, "tenant", http.MethodPost, url+"/complete", "", ""); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	stored, err := h.loadSession(context.Background(), "tenant", jobID)
	if err != nil || stored.AccessToken != sess.AccessToken {
		t.Fatal("completion reset mapping", err)
	}
	if rec := uploadTestRequest(h, "other-tenant", http.MethodPost, url+"/complete", "", ""); rec.Code != 404 {
		t.Fatal("cross-tenant completion admitted", rec.Code)
	}
	if err := os.WriteFile(stored.Extra["csv_path"], []byte(strings.Repeat("x", len(body))), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.loadSession(context.Background(), "tenant", jobID); !errors.Is(err, uploadstore.ErrCorrupt) {
		t.Fatal("tampered file admitted", err)
	}
}

func TestDBUploadResumesOnAnotherReplicaAndCleansExpiredArtifacts(t *testing.T) {
	adminURL, appURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"), os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		t.Skip("isolated database URLs required")
	}
	t.Setenv("POSTWAVE_ENV", "test")
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND", "filesystem")
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	tenant := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tenants(id,slug,name,tier) VALUES($1,$2,'Upload replica test','studio')`, tenant, "uploads-"+tenant); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1`, tenant) })
	newReplica := func() *Migration {
		pool, err := pgxpool.New(ctx, appURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		cipher, err := jobstore.NewAESSessionCipher(strings.Repeat("k", 32))
		if err != nil {
			t.Fatal(err)
		}
		return NewMigration("", jobstore.NewPostgresJobStore(pool, cipher))
	}
	first, second := newReplica(), newReplica()
	body := "email,status\none@example.test,subscribed\n"
	split := 10
	url := "/v1/migrations/csv/uploads/replica"
	if rec := uploadTestRequest(first, tenant, http.MethodPut, url+"?filename=x.csv", body[:split], fmt.Sprintf("bytes 0-%d/%d", split-1, len(body))); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if rec := uploadTestRequest(second, tenant, http.MethodGet, url, "", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"received":10`) {
		t.Fatal("resume offset lost", rec.Body.String())
	}
	if rec := uploadTestRequest(second, tenant, http.MethodPut, url+"?filename=x.csv", body[split:], fmt.Sprintf("bytes %d-%d/%d", split, len(body)-1, len(body))); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	rec := uploadTestRequest(second, tenant, http.MethodPost, url+"/complete", "", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var response map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	id := response["job_id"]
	third := newReplica()
	sess, err := third.loadSession(ctx, tenant, id)
	if err != nil {
		t.Fatal(err)
	}
	ad, err := adapter.Get(canonical.SourceCSV)
	if err != nil {
		t.Fatal(err)
	}
	subs, _, err := ad.ListSubscribers(ctx, sess, "")
	if err != nil || len(subs) != 1 || subs[0].Email != "one@example.test" {
		t.Fatal("replica cannot read export", err)
	}
	if _, err := admin.Exec(ctx, `UPDATE migration_sessions SET expires_at=now()-interval '1 hour' WHERE job_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	// The sweep uses a future clock while the physical session expiry is past.
	n, err := third.SweepExpiredUploads(ctx, time.Now().Add(rawUploadRetention+time.Hour))
	if err != nil || n != 1 {
		t.Fatal("upload cleanup", n, err)
	}
	if _, err := os.Stat(sess.Extra["csv_path"]); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("raw upload retained")
	}
	sweeper := third.store.(expiredSessionSweeper)
	n, err = sweeper.SweepExpiredSessions(ctx, time.Now(), 100)
	if err != nil || n < 1 {
		t.Fatal("credential cleanup", n, err)
	}
	var sessions int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM migration_sessions WHERE job_id=$1`, id).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatal("ciphertext retained", sessions, err)
	}
}
