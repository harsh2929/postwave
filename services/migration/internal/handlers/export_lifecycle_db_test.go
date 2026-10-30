package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/postwave/migrate/aweber"
	_ "github.com/postwave/migrate/bento"
	_ "github.com/postwave/migrate/campaignmonitor"
	"github.com/postwave/migrate/canonical"
	_ "github.com/postwave/migrate/constantcontact"
	_ "github.com/postwave/migrate/drip"
	_ "github.com/postwave/migrate/flodesk"
	_ "github.com/postwave/migrate/loops"
	_ "github.com/postwave/migrate/omnisend"
	_ "github.com/postwave/migrate/sendy"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
	"github.com/stretchr/testify/require"
)

// Exercises the real source adapter and HTTP lifecycle against a restricted
// Postgres role and a stateful destination protocol fixture. These are synthetic
// exports, not evidence that a customer's live account has been qualified.
func TestDBAllExportPathsUploadPreviewCommitRollbackCleanup(t *testing.T) {
	adminURL, appURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"), os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		t.Skip("isolated database URLs required")
	}
	t.Setenv("POSTWAVE_ENV", "test")
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "0")
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND", "filesystem")
	ctx := context.Background()
	admin, err := sql.Open("pgx", adminURL)
	require.NoError(t, err)
	defer admin.Close()
	db, err := sql.Open("pgx", appURL)
	require.NoError(t, err)
	defer db.Close()
	pool, err := pgxpool.New(ctx, appURL)
	require.NoError(t, err)
	defer pool.Close()
	cipher, err := jobstore.NewAESSessionCipher(strings.Repeat("k", 32))
	require.NoError(t, err)
	var manifest struct {
		Profiles []struct {
			Source string `json:"source"`
			File   string `json:"file"`
		} `json:"profiles"`
	}
	fixtureRoot := filepath.Join("..", "..", "..", "..", "packages", "migrate", "exportcsv", "testdata")
	raw, err := os.ReadFile(filepath.Join(fixtureRoot, "manifest.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &manifest))
	sources := []string{"substack"}
	for _, p := range manifest.Profiles {
		sources = append(sources, p.Source)
	}
	require.Len(t, sources, 11)
	for _, source := range sources {
		t.Run(source, func(t *testing.T) {
			tenant := uuid.NewString()
			_, err := admin.ExecContext(ctx, `INSERT INTO tenants(id,slug,name,tier) VALUES($1,$2,'Export lifecycle','studio')`, tenant, "export-"+tenant)
			require.NoError(t, err)
			defer admin.ExecContext(ctx, `DELETE FROM tenants WHERE id=$1`, tenant)
			var mu sync.Mutex
			remote := map[int]listmonkx.SubscriberResponse{}
			nextID := 1
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				respond := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": v}) }
				if r.URL.Path == "/api/subscribers" && r.Method == http.MethodGet {
					rows := []listmonkx.SubscriberResponse{}
					query := r.URL.Query().Get("query")
					for _, row := range remote {
						if query == "" || strings.Contains(query, row.Email) {
							rows = append(rows, row)
						}
					}
					respond(map[string]any{"results": rows, "total": len(rows), "per_page": 1000, "page": 1})
					return
				}
				if r.URL.Path == "/api/subscribers" && r.Method == http.MethodPost {
					var in listmonkx.SubscriberPayload
					if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
						http.Error(w, "bad payload", 400)
						return
					}
					for _, row := range remote {
						if row.Email == in.Email {
							http.Error(w, "exists", 409)
							return
						}
					}
					row := listmonkx.SubscriberResponse{ID: nextID, UUID: uuid.NewString(), Email: in.Email, Name: in.Name, Status: in.Status, Tags: in.Tags, Lists: listmonkx.SubscriberListIDs(in.Lists), Attribs: in.Attribs}
					remote[nextID] = row
					nextID++
					respond(row)
					return
				}
				if strings.HasPrefix(r.URL.Path, "/api/subscribers/") {
					id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/subscribers/"))
					row, ok := remote[id]
					if !ok {
						http.Error(w, "missing", 404)
						return
					}
					if r.Method == http.MethodGet {
						respond(row)
						return
					}
					if r.Method == http.MethodDelete {
						delete(remote, id)
						respond(true)
						return
					}
				}
				t.Errorf("unexpected destination request: %s %s", r.Method, r.URL.Path)
				http.Error(w, "unexpected destination request", 500)
			}))
			defer destination.Close()
			store := jobstore.NewPostgresJobStore(pool, cipher)
			h := NewMigrationWithDB("", store, db)
			h.SetListmonkClientFactory(func(context.Context) (*listmonkx.Client, error) {
				return &listmonkx.Client{BaseURL: destination.URL, AdminUser: "test", AdminPass: "test", HTTPClient: destination.Client(), DedicatedTenant: true, DedicatedTenantID: tenant}, nil
			})
			payload, filename := []byte(nil), source+".csv"
			if source == "substack" {
				var buf bytes.Buffer
				z := zip.NewWriter(&buf)
				f, err := z.Create("subscribers.csv")
				require.NoError(t, err)
				_, err = f.Write([]byte("email,created_at,state,source,name\nactive@example.test,2024-01-01T00:00:00Z,active,signup,Active\noptout@example.test,2024-01-01T00:00:00Z,canceled,signup,Optout\npending@example.test,2024-01-01T00:00:00Z,pending,signup,Pending\n"))
				require.NoError(t, err)
				require.NoError(t, z.Close())
				payload, filename = buf.Bytes(), "substack.zip"
			} else {
				payload, err = os.ReadFile(filepath.Join(fixtureRoot, filename))
				require.NoError(t, err)
			}
			uploadURL := "/v1/migrations/" + source + "/uploads/lifecycle"
			rec := uploadTestRequest(h, tenant, http.MethodPut, uploadURL+"?filename="+filename, string(payload), fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
			require.Equal(t, 200, rec.Code, rec.Body.String())
			rec = uploadTestRequest(h, tenant, http.MethodPost, uploadURL+"/complete", "", "")
			require.Equal(t, 200, rec.Code, rec.Body.String())
			var connected struct {
				JobID string `json:"job_id"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &connected))
			require.NotEmpty(t, connected.JobID)
			body := `{"job_id":"` + connected.JobID + `"}`
			rec = uploadTestRequest(h, tenant, http.MethodPost, "/v1/migrations/"+source+"/discover", body, "")
			require.Equal(t, 200, rec.Code, rec.Body.String())
			scoped := jobstore.WithTenantID(ctx, tenant)
			wait := func(status canonical.MigrationStatus) *canonical.MigrationJob {
				t.Helper()
				var job *canonical.MigrationJob
				require.Eventually(t, func() bool {
					job, err = store.Get(scoped, connected.JobID)
					return err == nil && (job.Status == status || job.Status == canonical.MigFailed)
				}, 10*time.Second, 20*time.Millisecond, "last job: %+v; error: %v", job, err)
				require.Equal(t, status, job.Status, fmt.Sprint(job.Error))
				return job
			}
			rec = uploadTestRequest(h, tenant, http.MethodPost, "/v1/migrations/"+source+"/dry-run", body, "")
			require.Equal(t, 202, rec.Code, rec.Body.String())
			preview := wait(canonical.MigAwaitingConfirmation)
			require.NotNil(t, preview.VerificationReport)
			mu.Lock()
			count := len(remote)
			mu.Unlock()
			require.Zero(t, count, "preview wrote destination subscribers")
			rec = uploadTestRequest(h, tenant, http.MethodPost, "/v1/migrations/"+source+"/commit", body, "")
			require.Equal(t, 202, rec.Code, rec.Body.String())
			committed := wait(canonical.MigCompleted)
			require.Equal(t, 3, committed.Progress.SubscribersDone)
			require.NotNil(t, committed.VerificationReport)
			require.Equal(t, 3, committed.VerificationReport.SubscribersImported)
			var mirrorCount int
			require.NoError(t, admin.QueryRowContext(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1`, tenant).Scan(&mirrorCount))
			require.Equal(t, 3, mirrorCount)
			mu.Lock()
			count = len(remote)
			mu.Unlock()
			require.Equal(t, 3, count)
			rec = uploadTestRequest(h, tenant, http.MethodPost, "/v1/migrations/"+connected.JobID+"/rollback", "", "")
			require.Equal(t, 202, rec.Code, rec.Body.String())
			wait(canonical.MigRolledBack)
			mu.Lock()
			count = len(remote)
			mu.Unlock()
			require.Zero(t, count)
			require.NoError(t, admin.QueryRowContext(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1`, tenant).Scan(&mirrorCount))
			require.Zero(t, mirrorCount)
			rec = uploadTestRequest(h, tenant, http.MethodDelete, "/v1/migrations/"+connected.JobID+"/source-session", "", "")
			require.Equal(t, 200, rec.Code, rec.Body.String())
			_, err = h.loadSession(ctx, tenant, connected.JobID)
			require.Error(t, err)
			rec = uploadTestRequest(h, tenant, http.MethodGet, uploadURL, "", "")
			require.Equal(t, 410, rec.Code, rec.Body.String())
		})
	}
}
