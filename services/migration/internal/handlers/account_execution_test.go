package handlers

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/activecampaign"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

const accountExecutionTestAPIURL = "https://account-execution.api-us1.com/api/3"

func TestActiveCampaignCredentialPathsContendAcrossDifferentJobs(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  func(*testing.T, *Migration, *jobstore.MemoryJobStore, string, adapter.Session)
	}{
		{name: "main run worker", run: testBlockedActiveCampaignMainRun},
		{name: "delta run worker", run: testBlockedActiveCampaignDeltaRun},
		{name: "synchronous discovery", run: testBlockedActiveCampaignDiscovery},
		{name: "shadow check", run: testBlockedActiveCampaignShadowCheck},
		{name: "source event sync", run: testBlockedActiveCampaignSourceEventSync},
		{name: "session refresh", run: testBlockedActiveCampaignSessionRefresh},
		{name: "initial credential bootstrap", run: testBlockedActiveCampaignCredentialBootstrap},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			h := NewMigration("", store)
			fingerprint, sess := accountExecutionTestSession(t, accountExecutionTestAPIURL)
			holdActiveCampaignAccountForDifferentJob(t, "tenant_a", fingerprint)
			tc.run(t, h, store, fingerprint, sess)
		})
	}
}

func TestActiveCampaignCredentialLeaseAllowsDifferentAccount(t *testing.T) {
	firstFingerprint, firstSession := accountExecutionTestSession(t, accountExecutionTestAPIURL)
	secondFingerprint, secondSession := accountExecutionTestSession(t, "https://other-account.api-us1.com/api/3")
	holdActiveCampaignAccountForDifferentJob(t, "tenant_a", firstFingerprint)

	h := NewMigration("")
	jobLease, err := h.acquireJobExecution(context.Background(), "tenant_a", "different-account-job")
	if err != nil {
		t.Fatalf("acquire different job lease: %v", err)
	}
	defer func() { _ = jobLease.Release() }()
	job := accountExecutionTestJob("different-account-job", canonical.MigCompleted, secondFingerprint)
	accountLease, err := h.acquireActiveCampaignSessionExecution(context.Background(), job, secondSession)
	if err != nil {
		t.Fatalf("different account lease: %v", err)
	}
	defer func() { _ = accountLease.Release() }()

	if firstSession.Extra[activecampaign.AccountFingerprintExtraKey] == secondSession.Extra[activecampaign.AccountFingerprintExtraKey] {
		t.Fatal("test setup produced identical account fingerprints")
	}
}

func TestActiveCampaignCredentialLeaseContendsAcrossPostwaveTenants(t *testing.T) {
	fingerprint, sess := accountExecutionTestSession(t, accountExecutionTestAPIURL)
	holdActiveCampaignAccountForDifferentJob(t, "tenant_a", fingerprint)

	h := NewMigration("")
	job := accountExecutionTestJob("cross-tenant-job", canonical.MigCompleted, fingerprint)
	job.TenantID = "tenant_b"
	jobLease, err := h.acquireJobExecution(context.Background(), job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("acquire cross-tenant job lease: %v", err)
	}
	defer func() { _ = jobLease.Release() }()
	_, err = h.acquireActiveCampaignSessionExecution(context.Background(), job, sess)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("cross-tenant account error = %v, want contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) {
		t.Fatalf("cross-tenant contention leaked fingerprint: %v", err)
	}
}

func TestActiveCampaignCredentialLeaseNormalizesCompatibleAccountURLs(t *testing.T) {
	const canonicalURL = "https://credential-compat.api-us1.com/api/3"
	fingerprint, _ := accountExecutionTestSession(t, canonicalURL)
	holdActiveCampaignAccountForDifferentJob(t, "tenant_a", fingerprint)
	h := NewMigration("")

	for _, raw := range []string{
		"credential-compat.api-us1.com",
		"https://credential-compat.api-us1.com/api/3/contacts/42",
	} {
		t.Run(raw, func(t *testing.T) {
			body := `{"api_key":"bootstrap-token","extra":{"api_url":"` + raw + `"}}`
			rec := serveAccountExecutionRequest(h, http.MethodPost, "/v1/migrations/activecampaign/credentials", body)
			// Contention proves pre-auth normalization reached the same canonical
			// account lease without making the provider authentication request.
			assertAccountExecutionConflict(t, rec, fingerprint)
		})
	}
}

func TestActiveCampaignCredentialLeaseRejectsUnsafeAccountURLsBeforeAuthentication(t *testing.T) {
	for _, raw := range []string{
		"http://unsafe-account.api-us1.com",
		"https://unsafe-account.api-us1.com.evil.example/api/3",
		"https://user:password@unsafe-account.api-us1.com/api/3",
		"https://unsafe-account.api-us1.com/api/3?redirect=https://evil.example",
		"https://unsafe-account.api-us1.com/not-api",
	} {
		t.Run(raw, func(t *testing.T) {
			body := credentialRequest{APIKey: "must-not-be-sent", Extra: map[string]string{"api_url": raw}}
			if fingerprint, err := activeCampaignCredentialFingerprint(body); err == nil || fingerprint != "" {
				t.Fatalf("fingerprint/error = %q/%v, want unsafe credential URL rejected", fingerprint, err)
			}
			rec := serveAccountExecutionRequest(
				NewMigration(""),
				http.MethodPost,
				"/v1/migrations/activecampaign/credentials",
				`{"api_key":"must-not-be-sent","extra":{"api_url":"`+raw+`"}}`,
			)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "must-not-be-sent") {
				t.Fatalf("unsafe URL response leaked credential: %s", rec.Body.String())
			}
		})
	}
}

func testBlockedActiveCampaignMainRun(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("main-run-target", canonical.MigDryRun, fingerprint)
	storeAccountExecutionTestJob(t, store, job, sess)
	h.runJob(context.Background(), job.TenantID, job.ID)
	assertAccountExecutionJobStatus(t, store, job, canonical.MigDryRun)
}

func testBlockedActiveCampaignDeltaRun(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("delta-run-target", canonical.MigImporting, fingerprint)
	mode := runModeDeltaImport
	job.Cursor[runModeCursorKey] = &mode
	storeAccountExecutionTestJob(t, store, job, sess)
	h.runJob(context.Background(), job.TenantID, job.ID)
	assertAccountExecutionJobStatus(t, store, job, canonical.MigImporting)
}

func testBlockedActiveCampaignDiscovery(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("discovery-target", canonical.MigAwaitingConfirmation, fingerprint)
	storeAccountExecutionTestJob(t, store, job, sess)
	rec := serveAccountExecutionRequest(h, http.MethodPost, "/v1/migrations/activecampaign/discover", `{"job_id":"`+job.ID+`"}`)
	assertAccountExecutionConflict(t, rec, fingerprint)
}

func testBlockedActiveCampaignShadowCheck(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("shadow-target", canonical.MigCompleted, fingerprint)
	storeAccountExecutionTestJob(t, store, job, sess)
	_, err := h.runShadowCheck(context.Background(), job.TenantID, job.Source, job.ID)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("shadow error = %v, want account contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) {
		t.Fatalf("shadow error leaked account fingerprint: %v", err)
	}
}

func testBlockedActiveCampaignSourceEventSync(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("source-event-target", canonical.MigCompleted, fingerprint)
	storeAccountExecutionTestJob(t, store, job, sess)
	_, _, _, _, err := h.runSourceEventSync(context.Background(), jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: job.Source,
	})
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("source-event error = %v, want account contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) {
		t.Fatalf("source-event error leaked account fingerprint: %v", err)
	}
}

func testBlockedActiveCampaignSessionRefresh(t *testing.T, h *Migration, store *jobstore.MemoryJobStore, fingerprint string, sess adapter.Session) {
	job := accountExecutionTestJob("refresh-target", canonical.MigCompleted, fingerprint)
	storeAccountExecutionTestJob(t, store, job, sess)
	body := `{"api_key":"replacement-token","extra":{"api_url":"` + accountExecutionTestAPIURL + `"}}`
	rec := serveAccountExecutionRequest(h, http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", body)
	assertAccountExecutionConflict(t, rec, fingerprint)
}

func testBlockedActiveCampaignCredentialBootstrap(t *testing.T, h *Migration, _ *jobstore.MemoryJobStore, fingerprint string, _ adapter.Session) {
	body := `{"api_key":"bootstrap-token","extra":{"api_url":"` + accountExecutionTestAPIURL + `"}}`
	rec := serveAccountExecutionRequest(h, http.MethodPost, "/v1/migrations/activecampaign/credentials", body)
	assertAccountExecutionConflict(t, rec, fingerprint)
}

func accountExecutionTestSession(t *testing.T, apiURL string) (string, adapter.Session) {
	t.Helper()
	fingerprint, err := activecampaign.AccountFingerprintForAPIURL(apiURL)
	if err != nil {
		t.Fatalf("account fingerprint: %v", err)
	}
	return fingerprint, adapter.Session{
		AccessToken: "account-execution-token",
		Source:      canonical.SourceActiveCampaign,
		Extra: map[string]string{
			"api_url": apiURL,
			activecampaign.AccountFingerprintExtraKey: fingerprint,
		},
	}
}

func accountExecutionTestJob(id string, status canonical.MigrationStatus, fingerprint string) *canonical.MigrationJob {
	now := time.Now().UTC().Add(-time.Hour)
	return &canonical.MigrationJob{
		ID:          id,
		TenantID:    "tenant_a",
		Source:      canonical.SourceActiveCampaign,
		Status:      status,
		StartedAt:   now,
		CompletedAt: &now,
		Cursor:      map[string]*string{activeCampaignAccountCursorKey: &fingerprint},
	}
}

func storeAccountExecutionTestJob(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, sess adapter.Session) {
	t.Helper()
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, sess, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}
}

func holdActiveCampaignAccountForDifferentJob(t *testing.T, tenantID, fingerprint string) {
	t.Helper()
	jobLease, err := orchestrator.AcquireMigrationExecutionLease(context.Background(), nil, tenantID, "other-job")
	if err != nil {
		t.Fatalf("acquire other job lease: %v", err)
	}
	accountLease, err := orchestrator.AcquireActiveCampaignAccountExecutionLease(context.Background(), nil, fingerprint)
	if err != nil {
		_ = jobLease.Release()
		t.Fatalf("acquire other account lease: %v", err)
	}
	t.Cleanup(func() {
		_ = accountLease.Release()
		_ = jobLease.Release()
	})
}

func serveAccountExecutionRequest(h *Migration, method, path, body string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func assertAccountExecutionConflict(t *testing.T, rec *httptest.ResponseRecorder, fingerprint string) {
	t.Helper()
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, secret := range []string{fingerprint, "account-execution.api-us1.com", "account-execution-token", "replacement-token", "bootstrap-token"} {
		if strings.Contains(body, secret) {
			t.Fatalf("response leaked %q: %s", secret, body)
		}
	}
}

func assertAccountExecutionJobStatus(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, want canonical.MigrationStatus) {
	t.Helper()
	got, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	if got.Status != want {
		t.Fatalf("job status = %q, want %q", got.Status, want)
	}
	if _, paused := rateLimitPausedUntil(got, time.Now()); !paused {
		t.Fatalf("account-contended job has no retry pause: %#v", got.Cursor)
	}
	if got.Error == nil || !strings.Contains(*got.Error, "another ActiveCampaign account operation") {
		t.Fatalf("job error = %v, want transient account-operation retry", got.Error)
	}
}
