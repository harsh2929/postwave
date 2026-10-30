package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestSubstackZIPUploadCompletesIntoPreparedExportSession(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)

	payload := substackZIPBytes(t, map[string]string{
		"export/email_list.newsletter.csv": "email,status,subscription_type,created_at\nreader@example.com,active,paid,2026-01-01T00:00:00Z\n",
		"export/posts.csv":                 "post_id,post_date,is_published,email_sent_at,title,subtitle,audience\n42,2026-01-02T00:00:00Z,true,2026-01-02T01:00:00Z,Hello,,everyone\n",
		"export/posts/42.hello.html":       "<p>Hello from the export</p>",
		"export/posts/42.delivers.csv":     "email\none@example.com\ntwo@example.com\n",
		"export/posts/42.opens.csv":        "email\none@example.com\n",
	})
	upload := httptest.NewRequest(http.MethodPut, "/v1/migrations/substack/uploads/substack_zip?filename=publication.zip", bytes.NewReader(payload))
	upload.Header.Set("X-Tenant-ID", "tenant_a")
	upload.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
	uploadRec := httptest.NewRecorder()
	router.ServeHTTP(uploadRec, upload)
	require.Equal(t, http.StatusOK, uploadRec.Code, uploadRec.Body.String())

	complete := httptest.NewRequest(http.MethodPost, "/v1/migrations/substack/uploads/substack_zip/complete", nil)
	complete.Header.Set("X-Tenant-ID", "tenant_a")
	completeRec := httptest.NewRecorder()
	router.ServeHTTP(completeRec, complete)
	require.Equal(t, http.StatusOK, completeRec.Code, completeRec.Body.String())
	var response struct {
		JobID string `json:"job_id"`
	}
	require.NoError(t, json.Unmarshal(completeRec.Body.Bytes(), &response))
	require.NotEmpty(t, response.JobID)

	sess, err := store.GetSession(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", response.JobID, time.Now())
	require.NoError(t, err)
	require.Equal(t, canonical.SourceSubstack, sess.Source)
	require.NotEmpty(t, sess.Extra["subs_csv"])
	require.NotEmpty(t, sess.Extra["archive_csv"])
	require.NotEmpty(t, sess.Extra["archive_dir"])
	require.NotEmpty(t, sess.Extra["bundle_manifest_path"])
	require.NotEmpty(t, sess.Extra["archive_stats_csv"])
	require.NoFileExists(t, filepath.Join(sess.Extra["archive_dir"], "export", "posts", "42.delivers.csv"))
	require.NoFileExists(t, filepath.Join(sess.Extra["archive_dir"], "export", "posts", "42.opens.csv"))
	statsInfo, err := os.Stat(sess.Extra["archive_stats_csv"])
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), statsInfo.Mode().Perm())

	ad, err := adapter.Get(canonical.SourceSubstack)
	require.NoError(t, err)
	discovery, err := ad.Discover(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, 1, discovery.SubscribersTotal)
	require.Equal(t, 1, discovery.ArchiveTotal)
	require.Equal(t, 1, discovery.ReportsTotal)
	posts, _, err := ad.ListCampaignArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, posts, 1)
	require.Equal(t, 2, posts[0].RecipientsCount)
	require.Equal(t, 1, posts[0].Opens)
}

func TestSubstackZIPUploadRejectsPathTraversalBeforeCreatingJob(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_UPLOAD_DIR", t.TempDir())
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	payload := substackZIPBytes(t, map[string]string{"../email_list.csv": "email,status\na@example.com,active\n"})

	upload := httptest.NewRequest(http.MethodPut, "/v1/migrations/substack/uploads/substack_bad?filename=publication.zip", bytes.NewReader(payload))
	upload.Header.Set("X-Tenant-ID", "tenant_a")
	upload.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
	uploadRec := httptest.NewRecorder()
	router.ServeHTTP(uploadRec, upload)
	require.Equal(t, http.StatusOK, uploadRec.Code, uploadRec.Body.String())

	complete := httptest.NewRequest(http.MethodPost, "/v1/migrations/substack/uploads/substack_bad/complete", nil)
	complete.Header.Set("X-Tenant-ID", "tenant_a")
	completeRec := httptest.NewRecorder()
	router.ServeHTTP(completeRec, complete)
	require.Equal(t, http.StatusBadRequest, completeRec.Code, completeRec.Body.String())
	require.Contains(t, completeRec.Body.String(), "unsafe ZIP entry")
}

func substackZIPBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var payload bytes.Buffer
	writer := zip.NewWriter(&payload)
	for name, body := range files {
		entry, err := writer.Create(name)
		require.NoError(t, err)
		_, err = entry.Write([]byte(body))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return payload.Bytes()
}
