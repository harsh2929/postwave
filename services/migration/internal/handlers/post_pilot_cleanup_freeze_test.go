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

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestPostPilotCleanupAuthorizationFreezesAcceptanceMutationRoutes(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("22222222-2222-4222-8222-222222222222", completedAt)
	markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"source monitor restart", http.MethodPost, "/v1/migrations/sources/activecampaign/source-events", `{"job_id":"` + job.ID + `"}`},
		{"shadow check", http.MethodPost, "/v1/migrations/activecampaign/shadow-check", `{"job_id":"` + job.ID + `"}`},
		{"shadow monitor restart", http.MethodPost, "/v1/migrations/sources/activecampaign/shadow-monitor", `{"job_id":"` + job.ID + `"}`},
		{"delta import", http.MethodPost, "/v1/migrations/activecampaign/delta-import", `{"job_id":"` + job.ID + `"}`},
		{"credential refresh", http.MethodPost, "/v1/migrations/" + job.ID + "/source-session", `{}`},
		{"automation list normalization", http.MethodGet, "/v1/migrations/" + job.ID + "/automation-rebuilds", ""},
		{"automation update", http.MethodPatch, "/v1/migrations/" + job.ID + "/automation-rebuilds", `{"rank":1,"name":"Welcome","status":"blocked"}`},
		{"rollback rehearsal", http.MethodGet, "/v1/migrations/" + job.ID + "/rollback-rehearsal", ""},
		{"non-marker cutover evidence", http.MethodPatch, "/v1/migrations/" + job.ID + "/cutover-evidence", `{"key":"activecampaign_templates_review","status":"pass","detail":"late change"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Tenant-ID", job.TenantID)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "freezes acceptance evidence") {
				t.Fatalf("status/body = %d/%s, want cleanup freeze conflict", w.Code, w.Body.String())
			}
		})
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if !activeCampaignPostPilotCleanupAuthorized(stored) {
		t.Fatal("rejected acceptance mutations invalidated cleanup authorization")
	}
}

func TestPostPilotCleanupMarkerCanOnlyBeRevokedBeforeCleanupStarts(t *testing.T) {
	completedAt := time.Now().UTC()

	t.Run("before cleanup", func(t *testing.T) {
		store := jobstore.NewMemoryJobStore()
		job := activeCampaignAcceptedJob("33333333-3333-4333-8333-333333333333", completedAt)
		markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
		if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
			t.Fatalf("create job: %v", err)
		}
		w := patchCleanupMarker(t, store, job, "warning")
		if w.Code != http.StatusOK {
			t.Fatalf("revoke status/body = %d/%s, want 200", w.Code, w.Body.String())
		}
		stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
		if err != nil {
			t.Fatalf("reload job: %v", err)
		}
		if activeCampaignPostPilotCleanupAuthorized(stored) {
			t.Fatal("warning marker did not revoke cleanup authorization")
		}
	})

	t.Run("after cleanup start", func(t *testing.T) {
		store := jobstore.NewMemoryJobStore()
		job := activeCampaignAcceptedJob("44444444-4444-4444-8444-444444444444", completedAt)
		markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
		markActiveCampaignPostPilotCleanupStarted(job, completedAt.Add(2*time.Minute))
		if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
			t.Fatalf("create job: %v", err)
		}
		w := patchCleanupMarker(t, store, job, "blocker")
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "can no longer be revoked") {
			t.Fatalf("revoke status/body = %d/%s, want post-start conflict", w.Code, w.Body.String())
		}
	})
}

func TestPostPilotCleanupMonitorStopClaimsCleanupStart(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("55555555-5555-4555-8555-555555555555", completedAt)
	markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	now := time.Now().UTC()
	if _, err := store.UpsertSourceEventMonitor(jobstore.WithTenantID(context.Background(), job.TenantID), jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: job.Source, Enabled: true, IntervalSeconds: 300, NextSyncAt: &now,
	}); err != nil {
		t.Fatalf("create monitor: %v", err)
	}
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodDelete, "/v1/migrations/"+job.ID+"/source-events?post_pilot_cleanup=1", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("cleanup stop status/body = %d/%s", w.Code, w.Body.String())
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if !activeCampaignPostPilotCleanupAuthorized(stored) || !activeCampaignPostPilotCleanupStarted(stored) {
		t.Fatalf("cleanup authorization/start latch = authorized:%v started:%v", activeCampaignPostPilotCleanupAuthorized(stored), activeCampaignPostPilotCleanupStarted(stored))
	}
}

func TestPostPilotCleanupAuthorizationRejectsOAuthCredentialReconnect(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := activeCampaignAcceptedJob("66666666-6666-4666-8666-666666666666", completedAt)
	markPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)
	_, err := h.completeOAuthJob(
		context.Background(),
		job.TenantID,
		job.Source,
		oauthStateForJob("opaque", job.ID),
		adapter.Session{Source: job.Source},
	)
	if err == nil || !strings.Contains(err.Error(), "freezes acceptance evidence") {
		t.Fatalf("OAuth reconnect error = %v, want cleanup freeze", err)
	}
}

func TestHubSpotPostPilotCleanupAuthorizationFreezesBridgeMutationRoutes(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("77777777-7777-4777-8777-777777777777", completedAt)
	markHubSpotPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"source monitor restart", http.MethodPost, "/v1/migrations/sources/hubspot/source-events", `{"job_id":"` + job.ID + `"}`},
		{"shadow check", http.MethodPost, "/v1/migrations/hubspot/shadow-check", `{"job_id":"` + job.ID + `"}`},
		{"shadow monitor restart", http.MethodPost, "/v1/migrations/sources/hubspot/shadow-monitor", `{"job_id":"` + job.ID + `"}`},
		{"final full snapshot", http.MethodPost, "/v1/migrations/hubspot/delta-import", `{"job_id":"` + job.ID + `"}`},
		{"credential refresh", http.MethodPost, "/v1/migrations/" + job.ID + "/source-session", `{}`},
		{"rollback rehearsal", http.MethodGet, "/v1/migrations/" + job.ID + "/rollback-rehearsal", ""},
		{"non-marker cutover evidence", http.MethodPatch, "/v1/migrations/" + job.ID + "/cutover-evidence", `{"key":"` + hubSpotCRMBridgeScopeReviewKey + `","status":"pass","detail":"late change"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Tenant-ID", job.TenantID)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "freezes acceptance evidence") || !strings.Contains(w.Body.String(), "HubSpot") {
				t.Fatalf("status/body = %d/%s, want HubSpot cleanup freeze conflict", w.Code, w.Body.String())
			}
		})
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if !postPilotCleanupAuthorized(stored) {
		t.Fatal("rejected bridge mutations invalidated HubSpot cleanup authorization")
	}
}

func TestHubSpotPostPilotCleanupDisablesMonitorAndClearsSourceSession(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	completedAt := time.Now().UTC()
	job := hubSpotAcceptedJob("88888888-8888-4888-8888-888888888888", completedAt)
	markHubSpotPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	sess := hubSpotBindingTestSession("12345", "na1")
	if err := store.SaveSession(ctx, job.ID, job.TenantID, sess, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save HubSpot source session: %v", err)
	}
	now := time.Now().UTC()
	if _, err := store.UpsertSourceEventMonitor(ctx, jobstore.SourceEventMonitorRecord{
		JobID: job.ID, TenantID: job.TenantID, Source: job.Source, Enabled: true, IntervalSeconds: 300, NextSyncAt: &now,
	}); err != nil {
		t.Fatalf("create monitor: %v", err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodDelete, "/v1/migrations/"+job.ID+"/source-events?post_pilot_cleanup=1", nil)
	req.Header.Set("X-Tenant-ID", job.TenantID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"source_session_cleared":true`) {
		t.Fatalf("cleanup status/body = %d/%s, want monitor stop and source-session cleanup", w.Code, w.Body.String())
	}
	stored, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if !postPilotCleanupAuthorized(stored) || !postPilotCleanupStarted(stored) {
		t.Fatalf("cleanup authorization/start latch = authorized:%v started:%v", postPilotCleanupAuthorized(stored), postPilotCleanupStarted(stored))
	}
	if _, ok := cursorString(stored.Cursor, hubSpotPostPilotSessionClearedAtKey); !ok {
		t.Fatalf("HubSpot source-session cleared marker is missing: %#v", stored.Cursor)
	}
	if _, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now()); !errors.Is(err, jobstore.ErrNotFound) {
		t.Fatalf("source session after cleanup = %v, want deleted", err)
	}
	monitor, err := store.GetSourceEventMonitor(ctx, job.TenantID, job.ID)
	if err != nil {
		t.Fatalf("reload monitor: %v", err)
	}
	if monitor.Enabled {
		t.Fatalf("source-event monitor remains enabled after cleanup: %+v", monitor)
	}
}

func TestHubSpotPostPilotCleanupMarkerCanOnlyBeRevokedBeforeCleanupStarts(t *testing.T) {
	completedAt := time.Now().UTC()
	for _, tc := range []struct {
		name       string
		jobID      string
		started    bool
		wantStatus int
	}{
		{name: "before cleanup", jobID: "99999999-9999-4999-8999-999999999990", wantStatus: http.StatusOK},
		{name: "after cleanup start", jobID: "99999999-9999-4999-8999-999999999991", started: true, wantStatus: http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := jobstore.NewMemoryJobStore()
			job := hubSpotAcceptedJob(tc.jobID, completedAt)
			markHubSpotPostPilotCleanupAuthorized(job, completedAt.Add(time.Minute))
			if tc.started {
				markPostPilotCleanupStarted(job, completedAt.Add(2*time.Minute))
			}
			if err := store.Create(jobstore.WithTenantID(context.Background(), job.TenantID), job); err != nil {
				t.Fatalf("create job: %v", err)
			}
			h := NewMigration("", store)
			router := chi.NewRouter()
			h.Mount(router)
			body := `{"key":"` + hubSpotPostPilotCleanupEvidenceKey + `","status":"warning","detail":"Reopen HubSpot bridge evidence before cleanup."}`
			req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Tenant-ID", job.TenantID)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("revoke status/body = %d/%s, want %d", w.Code, w.Body.String(), tc.wantStatus)
			}
			if tc.started && !strings.Contains(w.Body.String(), "can no longer be revoked") {
				t.Fatalf("post-start response = %s, want irreversible cleanup latch", w.Body.String())
			}
			if !tc.started {
				stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
				if err != nil {
					t.Fatal(err)
				}
				if postPilotCleanupAuthorized(stored) {
					t.Fatal("warning marker did not revoke HubSpot cleanup authorization")
				}
			}
		})
	}
}

func markHubSpotPostPilotCleanupAuthorized(job *canonical.MigrationJob, reviewedAt time.Time) {
	if job == nil || job.CompletedAt == nil {
		return
	}
	markFinalDeltaCompleted(job, *job.CompletedAt)
	markSourceEventOverlapSnapshot(job, sourceEventOverlapSnapshotV1{
		Version:             1,
		EnabledSince:        job.CompletedAt.Add(-8 * 24 * time.Hour),
		FirstSuccessfulSync: job.CompletedAt.Add(-8 * 24 * time.Hour),
		PreDeltaSyncedAt:    job.CompletedAt.Add(-2 * time.Minute),
		IntervalSeconds:     300,
		SuccessfulSyncs:     100,
		MaxSyncGapSeconds:   300,
		CapturedAt:          job.CompletedAt.Add(-time.Minute),
	})
	status := "pass"
	at := reviewedAt.UTC().Format(time.RFC3339Nano)
	detail := "Strict HubSpot bridge pilot passed; authorize cleanup."
	rawEvidence := `["pilot acceptance passed"]`
	statusKey, atKey, detailKey, evidenceKey := hubSpotCutoverEvidenceCursorKeys(hubSpotPostPilotCleanupEvidenceKey)
	job.Cursor[statusKey] = &status
	job.Cursor[atKey] = &at
	job.Cursor[detailKey] = &detail
	job.Cursor[evidenceKey] = &rawEvidence
}

func patchCleanupMarker(t *testing.T, store *jobstore.MemoryJobStore, job *canonical.MigrationJob, status string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	body := `{"key":"` + activeCampaignPostPilotCleanupEvidenceKey + `","status":"` + status + `","detail":"Reopen acceptance evidence before cleanup."}`
	req := httptest.NewRequest(http.MethodPatch, "/v1/migrations/"+job.ID+"/cutover-evidence", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tenant-ID", job.TenantID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}
