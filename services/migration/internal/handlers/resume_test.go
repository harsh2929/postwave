package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func cancelledJob(id string, cursor map[string]*string) *canonical.MigrationJob {
	msg := cancelledByOperatorMsg
	if cursor == nil {
		cursor = map[string]*string{}
	}
	return &canonical.MigrationJob{
		ID:        id,
		TenantID:  "tenant_a",
		Source:    canonical.SourceMailchimp,
		Status:    canonical.MigFailed,
		Error:     &msg,
		StartedAt: time.Now(),
		Cursor:    cursor,
	}
}

func postResume(t *testing.T, r chi.Router, jobID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"/v1/migrations/"+jobID+"/resume", bytes.NewBufferString("{}"))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// TestResumeJobRequiresCancelledState locks in the eligibility rule:
// only a cancelled job (failed + cancellation message) is resumable.
func TestResumeJobRequiresCancelledState(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	for i, tc := range []struct {
		status canonical.MigrationStatus
		errMsg string
	}{
		{canonical.MigImporting, ""},
		{canonical.MigCompleted, ""},
		{canonical.MigFailed, "adapter exploded"}, // genuine failure ≠ cancelled
		{canonical.MigAwaitingConfirmation, ""},
	} {
		job := &canonical.MigrationJob{
			ID:        "1111111111111111111111111111111" + string(rune('0'+i)),
			TenantID:  "tenant_a",
			Source:    canonical.SourceMailchimp,
			Status:    tc.status,
			StartedAt: time.Now(),
			Cursor:    map[string]*string{},
		}
		if tc.errMsg != "" {
			msg := tc.errMsg
			job.Error = &msg
		}
		if err := store.Create(context.Background(), job); err != nil {
			t.Fatalf("create: %v", err)
		}
		rec := postResume(t, r, job.ID)
		if rec.Code != http.StatusConflict {
			t.Errorf("status %q: resume = %d, want 409; body=%s", tc.status, rec.Code, rec.Body.String())
		}
	}
}

// TestResumeJobCancelledWithoutSessionAsksForReconnect — the persisted
// session is the resume prerequisite; without it we 409 with the same
// reconnect message the kickoff path uses.
func TestResumeJobCancelledWithoutSessionAsksForReconnect(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	job := cancelledJob("22222222222222222222222222222222", nil)
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	rec := postResume(t, r, job.ID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("resume = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("session expired")) {
		t.Fatalf("expected reconnect message, got: %s", rec.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigFailed {
		t.Fatalf("job status mutated to %q on rejected resume", stored.Status)
	}
}

// TestResumeJobRestartsCancelledRun is the happy path: a cancelled job
// with a live session resumes (202) and the run continues from the
// persisted ledger. The local-demo session makes runJob deterministic —
// it completes synchronously inside the worker goroutine.
func TestResumeJobRestartsCancelledRun(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	checkpoint := "page-7"
	mode := runModeImporting
	job := cancelledJob("33333333333333333333333333333334", map[string]*string{
		"subscribers":    &checkpoint,
		runModeCursorKey: &mode,
	})
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	sess := localDemoSession(canonical.SourceMailchimp, "resume-test")
	if err := store.SaveSession(context.Background(), job.ID, "tenant_a", sess, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	rec := postResume(t, r, job.ID)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("resume = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		JobID  string `json:"job_id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.JobID != job.ID || resp.Status != string(canonical.MigImporting) {
		t.Fatalf("response = %+v, want job resumed as importing", resp)
	}

	// The demo runJob completes synchronously-ish in a goroutine; wait
	// for the terminal state rather than sleeping a fixed amount.
	deadline := time.Now().Add(5 * time.Second)
	for {
		stored, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), job.ID)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if stored.Status == canonical.MigCompleted {
			if stored.Error != nil {
				t.Fatalf("resumed job kept error %q", *stored.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not complete after resume; status=%q", stored.Status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestResumeJobHonoursDryRunMode — a cancelled dry-run resumes as a
// dry-run, not a commit.
func TestResumeJobHonoursDryRunMode(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	mode := runModeDryRun
	job := cancelledJob("44444444444444444444444444444444", map[string]*string{
		runModeCursorKey: &mode,
	})
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	sess := localDemoSession(canonical.SourceMailchimp, "resume-dry")
	if err := store.SaveSession(context.Background(), job.ID, "tenant_a", sess, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)

	rec := postResume(t, r, job.ID)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("resume = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != string(canonical.MigDryRun) {
		t.Fatalf("resumed status = %q, want %q", resp.Status, canonical.MigDryRun)
	}
}
