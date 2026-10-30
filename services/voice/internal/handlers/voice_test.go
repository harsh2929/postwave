package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/ingest/pastein"
	"github.com/postwave/postwave/services/voice/internal/ingest/rss"
	"github.com/postwave/postwave/services/voice/internal/ingest/twitter"
)

func TestRegisterSourceRejectsUnsafeRSSURLBeforeStoring(t *testing.T) {
	reg := ingest.NewRegistry()
	reg.Register(rss.New())
	store := NewMemoryStore()
	handler := New(reg, store, nil)

	req := httptest.NewRequest(http.MethodPost, "/sources", strings.NewReader(`{
		"type": "blog_rss",
		"params": {"FeedURL": "http://127.0.0.1/feed.xml"}
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	rows, err := store.ListSources(context.Background(), "tenant-1")
	if err != nil {
		t.Fatalf("ListSources: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("stored %d source(s), want 0", len(rows))
	}
}

func TestRegisterSourceRejectsOversizedBody(t *testing.T) {
	reg := ingest.NewRegistry()
	reg.Register(pastein.New())
	store := NewMemoryStore()
	handler := New(reg, store, nil)

	req := httptest.NewRequest(http.MethodPost, "/sources", strings.NewReader(`{
		"type": "paste_in",
		"params": {"RawText": "`+strings.Repeat("x", int(voiceHandlerJSONMaxBodyBytes))+`"}
	}`))
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusRequestEntityTooLarge, rec.Body.String())
	}
}

func TestListSourcesProjectsMetadataWithoutCorpusOrInternalParams(t *testing.T) {
	store := NewMemoryStore()
	_, err := store.RegisterSource(context.Background(), "tenant-secret", ingest.SourceBlogRSS, ingest.IngestParams{
		FeedURL:     "https://feeds.example.com/news.xml?signature=private-token#internal",
		TenantID:    "tenant-secret",
		RawText:     "private pasted corpus",
		ArchivePath: "uploads/tenant-secret/export.csv",
		Extra:       map[string]string{"api_key": "connector-secret"},
	})
	if err != nil {
		t.Fatalf("RegisterSource: %v", err)
	}
	_, err = store.RegisterSource(context.Background(), "tenant-secret", ingest.SourcePasteIn, ingest.IngestParams{
		RawText: "another private corpus",
	})
	if err != nil {
		t.Fatalf("RegisterSource paste-in: %v", err)
	}
	handler := New(ingest.NewRegistry(), store, nil)
	req := httptest.NewRequest(http.MethodGet, "/sources", nil)
	req.Header.Set("X-Tenant-ID", "tenant-secret")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, secret := range []string{
		"private-token", "private pasted corpus", "another private corpus",
		"tenant-secret", "export.csv", "connector-secret", "signature",
		"params", "RawText", "ArchivePath", "Extra",
	} {
		if strings.Contains(body, secret) {
			t.Errorf("list projection exposed %q: %s", secret, body)
		}
	}
	if !strings.Contains(body, `"label":"https://feeds.example.com/news.xml"`) {
		t.Errorf("safe feed recognition label missing: %s", body)
	}
	if !strings.Contains(body, `"type":"paste_in"`) {
		t.Errorf("paste-in source summary missing: %s", body)
	}
	if strings.Contains(body, "0001-01-01") {
		t.Errorf("never-ingested source fabricated an ingest timestamp: %s", body)
	}
}

func TestKickIngestRejectsUnsafeArchivePathBeforeRunning(t *testing.T) {
	reg := ingest.NewRegistry()
	reg.Register(twitter.New())
	store := NewMemoryStore()
	sourceID, err := store.RegisterSource(context.Background(), "tenant-1", ingest.SourceTwitter, ingest.IngestParams{
		ArchivePath: "../tweets.js",
	})
	if err != nil {
		t.Fatalf("RegisterSource: %v", err)
	}
	handler := New(reg, store, nil)

	req := httptest.NewRequest(http.MethodPost, "/sources/"+sourceID+"/ingest", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// memoryJobStore is an in-process IngestJobStore for tests. Mirrors the
// state machine of jobstore.Store without Postgres.
type memoryJobStore struct {
	mu   sync.Mutex
	rows map[string]IngestJob
}

func newMemoryJobStore() *memoryJobStore {
	return &memoryJobStore{rows: map[string]IngestJob{}}
}

func (m *memoryJobStore) Create(_ context.Context, tenantID, sourceID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := "job-" + sourceID
	m.rows[id] = IngestJob{
		ID: id, TenantID: tenantID, SourceID: sourceID,
		Status: "pending", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	return id, nil
}

func (m *memoryJobStore) Start(_ context.Context, _, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[jobID]
	if !ok || r.Status != "pending" {
		return nil
	}
	r.Status = "running"
	now := time.Now().UTC()
	r.StartedAt = &now
	r.UpdatedAt = now
	m.rows[jobID] = r
	return nil
}

func (m *memoryJobStore) Succeed(_ context.Context, _, jobID string, count int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[jobID]
	r.Status = "succeeded"
	r.ItemCount = count
	now := time.Now().UTC()
	r.FinishedAt = &now
	r.UpdatedAt = now
	m.rows[jobID] = r
	return nil
}

func (m *memoryJobStore) Fail(_ context.Context, _, jobID, msg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[jobID]
	r.Status = "failed"
	r.ErrorMessage = msg
	now := time.Now().UTC()
	r.FinishedAt = &now
	r.UpdatedAt = now
	m.rows[jobID] = r
	return nil
}

func (m *memoryJobStore) Get(_ context.Context, tenantID, jobID string) (IngestJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[jobID]
	if !ok || r.TenantID != tenantID {
		return IngestJob{}, ErrNotFound
	}
	return r, nil
}

// TestKickIngestPersistsJobAndPollsToTerminal walks the full lifecycle:
// register a source, kick ingest, poll until status flips off 'pending'.
// Uses paste_in (synchronous, no network) so the goroutine completes fast.
func TestKickIngestPersistsJobAndPollsToTerminal(t *testing.T) {
	reg := ingest.NewRegistry()
	reg.Register(pastein.New())
	store := NewMemoryStore()
	jobs := newMemoryJobStore()

	sourceID, err := store.RegisterSource(context.Background(), "tenant-1", ingest.SourcePasteIn, ingest.IngestParams{
		RawText: "hello world this is a sample paste-in for ingest tests",
	})
	if err != nil {
		t.Fatalf("RegisterSource: %v", err)
	}

	handler := New(reg, store, nil).WithIngestJobs(jobs)

	req := httptest.NewRequest(http.MethodPost, "/sources/"+sourceID+"/ingest", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d (body=%s)", rec.Code, http.StatusAccepted, rec.Body.String())
	}
	var resp ingestResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.JobID == "" {
		t.Fatalf("response missing job_id")
	}

	// Poll up to 2s for the goroutine to drive the job to a terminal state.
	deadline := time.Now().Add(2 * time.Second)
	var final IngestJob
	for time.Now().Before(deadline) {
		pollReq := httptest.NewRequest(http.MethodGet,
			"/sources/"+sourceID+"/ingest/"+resp.JobID, nil)
		pollReq.Header.Set("X-Tenant-ID", "tenant-1")
		pollRec := httptest.NewRecorder()
		handler.Routes().ServeHTTP(pollRec, pollReq)
		if pollRec.Code != http.StatusOK {
			t.Fatalf("poll status = %d, want %d (body=%s)",
				pollRec.Code, http.StatusOK, pollRec.Body.String())
		}
		if err := json.Unmarshal(pollRec.Body.Bytes(), &final); err != nil {
			t.Fatalf("decode poll: %v", err)
		}
		if final.Status == "succeeded" || final.Status == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if final.Status != "succeeded" {
		t.Fatalf("final status = %q (err=%q), want succeeded", final.Status, final.ErrorMessage)
	}
	if final.ItemCount == 0 {
		t.Fatalf("expected item_count > 0 after paste_in ingest")
	}
}

// TestGetIngestJobScopesBySource ensures a tenant cannot poll a job through
// the wrong source URL.
func TestGetIngestJobScopesBySource(t *testing.T) {
	jobs := newMemoryJobStore()
	jobID, _ := jobs.Create(context.Background(), "tenant-1", "source-A")
	handler := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithIngestJobs(jobs)

	req := httptest.NewRequest(http.MethodGet, "/sources/source-B/ingest/"+jobID, nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
