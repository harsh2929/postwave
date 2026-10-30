package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestCustomerIOLocalDemoHTTPLifecycleIsExactAndFailClosed(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "1")
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)

	credentials := customerIOLocalDemoRequest(t, router, http.MethodPost, "/v1/migrations/customerio/credentials", `{"api_key":"local-demo","account_id":"42","extra":{"region":"eu"}}`)
	if credentials.Code != http.StatusOK {
		t.Fatalf("credentials status = %d, body=%s", credentials.Code, credentials.Body.String())
	}
	var connected struct {
		JobID     string `json:"job_id"`
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(credentials.Body.Bytes(), &connected); err != nil {
		t.Fatalf("decode credentials: %v", err)
	}
	if connected.JobID == "" || connected.AccountID != "1" {
		t.Fatalf("credentials response = %+v, want deterministic workspace-bound demo job", connected)
	}

	discovery := customerIOLocalDemoRequest(t, router, http.MethodPost, "/v1/migrations/customerio/discover", `{"job_id":"`+connected.JobID+`"}`)
	if discovery.Code != http.StatusOK {
		t.Fatalf("discovery status = %d, body=%s", discovery.Code, discovery.Body.String())
	}
	var found struct {
		Source                    canonical.SourcePlatform         `json:"source"`
		SubscribersCount          int                              `json:"subscribers_count"`
		ProfilesWithoutEmailCount int                              `json:"profiles_without_email_count"`
		SegmentsCount             int                              `json:"segments_count"`
		AutomationsCount          int                              `json:"automations_count"`
		ArchiveCount              int                              `json:"archive_count"`
		SourceArchiveCount        int                              `json:"source_archive_count"`
		SubscriptionChannelsCount int                              `json:"subscription_channels_count"`
		ResourceMetadata          []canonical.ResourceCompleteness `json:"resource_metadata"`
	}
	if err := json.Unmarshal(discovery.Body.Bytes(), &found); err != nil {
		t.Fatalf("decode discovery: %v", err)
	}
	if found.Source != canonical.SourceCustomerIO || found.SubscribersCount <= 0 || found.ProfilesWithoutEmailCount <= 0 {
		t.Fatalf("discovery identity/profile inventory = %+v", found)
	}
	if found.SegmentsCount != 14 || found.AutomationsCount != 28 || found.ArchiveCount != 32 || found.SubscriptionChannelsCount != 3 || found.SourceArchiveCount <= 0 {
		t.Fatalf("discovery exact inventory = %+v", found)
	}
	if len(found.ResourceMetadata) != 15 {
		t.Fatalf("discovery completeness rows = %d, want 15", len(found.ResourceMetadata))
	}

	dryRun := customerIOLocalDemoRequest(t, router, http.MethodPost, "/v1/migrations/customerio/dry-run", `{"job_id":"`+connected.JobID+`"}`)
	if dryRun.Code != http.StatusAccepted {
		t.Fatalf("dry-run status = %d, body=%s", dryRun.Code, dryRun.Body.String())
	}
	job, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_customerio"), connected.JobID)
	if err != nil {
		t.Fatalf("load dry-run job: %v", err)
	}
	assertCustomerIOLocalDemoVerification(t, job, canonical.MigAwaitingConfirmation, found.SourceArchiveCount, found.SubscriptionChannelsCount)

	verification := customerIOLocalDemoRequest(t, router, http.MethodGet, "/v1/migrations/"+connected.JobID+"/verification", "")
	if verification.Code != http.StatusOK {
		t.Fatalf("verification status = %d, body=%s", verification.Code, verification.Body.String())
	}
	var publicReport canonical.VerificationReport
	if err := json.Unmarshal(verification.Body.Bytes(), &publicReport); err != nil {
		t.Fatalf("decode verification: %v", err)
	}
	if publicReport.SourceArchiveByResource["customerio_subscription_channel"] != found.SubscriptionChannelsCount {
		t.Fatalf("public channel archive count = %d, want %d", publicReport.SourceArchiveByResource["customerio_subscription_channel"], found.SubscriptionChannelsCount)
	}

	commit := customerIOLocalDemoRequest(t, router, http.MethodPost, "/v1/migrations/customerio/commit", `{"job_id":"`+connected.JobID+`"}`)
	if commit.Code != http.StatusAccepted {
		t.Fatalf("commit status = %d, body=%s", commit.Code, commit.Body.String())
	}
	job, err = store.Get(jobstore.WithTenantID(context.Background(), "tenant_customerio"), connected.JobID)
	if err != nil {
		t.Fatalf("load committed job: %v", err)
	}
	assertCustomerIOLocalDemoVerification(t, job, canonical.MigCompleted, found.SourceArchiveCount, found.SubscriptionChannelsCount)
	if job.CompletedAt == nil || job.RollbackUntil == nil || !job.RollbackUntil.After(*job.CompletedAt) {
		t.Fatalf("completed job lacks rollback window: %+v", job)
	}

	shadow := customerIOLocalDemoRequest(t, router, http.MethodPost, "/v1/migrations/customerio/shadow-check", `{"job_id":"`+connected.JobID+`"}`)
	if shadow.Code != http.StatusOK {
		t.Fatalf("shadow status = %d, body=%s", shadow.Code, shadow.Body.String())
	}
	var shadowReport struct {
		RecommendedAction string   `json:"recommended_action"`
		Blockers          []string `json:"blockers"`
	}
	if err := json.Unmarshal(shadow.Body.Bytes(), &shadowReport); err != nil {
		t.Fatalf("decode shadow report: %v", err)
	}
	if shadowReport.RecommendedAction != "manual_review_required" || len(shadowReport.Blockers) == 0 {
		t.Fatalf("local demo shadow report = %+v, want fail-closed manual review", shadowReport)
	}
}

func customerIOLocalDemoRequest(t *testing.T, router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("X-Tenant-ID", "tenant_customerio")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func assertCustomerIOLocalDemoVerification(t *testing.T, job *canonical.MigrationJob, status canonical.MigrationStatus, sourceArchiveTotal, channelTotal int) {
	t.Helper()
	if job.Status != status || job.VerificationReport == nil {
		t.Fatalf("job status/report = %s/%#v, want %s with report", job.Status, job.VerificationReport, status)
	}
	report := job.VerificationReport
	if report.AutomationsTranslated != 0 || job.Progress.AutomationsDone != 0 {
		t.Fatalf("Customer.io workflow runtime counts = report:%d progress:%d, want zero", report.AutomationsTranslated, job.Progress.AutomationsDone)
	}
	if report.SourceArchiveImported != sourceArchiveTotal || job.Progress.SourceArchiveDone != sourceArchiveTotal {
		t.Fatalf("source archive counts = report:%d progress:%d, want %d", report.SourceArchiveImported, job.Progress.SourceArchiveDone, sourceArchiveTotal)
	}
	if report.SourceArchiveByResource["customerio_subscription_channel"] != channelTotal {
		t.Fatalf("subscription-channel archive count = %d, want %d", report.SourceArchiveByResource["customerio_subscription_channel"], channelTotal)
	}
	if len(report.ResourceCompleteness) != 15 {
		t.Fatalf("verification completeness rows = %d, want 15", len(report.ResourceCompleteness))
	}
}
