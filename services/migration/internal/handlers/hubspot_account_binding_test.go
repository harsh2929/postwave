package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	hubspotx "github.com/postwave/migrate/hubspot"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestCreateHubSpotJobPersistsOpaquePortalBinding(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := hubSpotBindingTestSession("12345", "na1")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")

	jobID, err := h.createJob(ctx, "tenant_a", canonical.SourceHubSpot, sess)
	if err != nil {
		t.Fatalf("create HubSpot job: %v", err)
	}
	job, err := store.Get(ctx, jobID)
	if err != nil {
		t.Fatalf("get HubSpot job: %v", err)
	}
	want := hubspotx.AccountFingerprint(sess)
	if got, ok := cursorString(job.Cursor, hubSpotAccountCursorKey); !ok || got != want {
		t.Fatalf("account fingerprint = %q/%v, want %q/true", got, ok, want)
	}
	if got, ok := cursorString(job.Cursor, hubSpotDataLocationCursorKey); !ok || got != "na1" {
		t.Fatalf("data hosting location = %q/%v, want na1/true", got, ok)
	}
	if strings.Contains(want, sess.AccountID) {
		t.Fatalf("account fingerprint leaked portal id: %q", want)
	}
	if err := requireHubSpotAccount(job, sess); err != nil {
		t.Fatalf("saved HubSpot binding rejected: %v", err)
	}
}

func TestHubSpotCredentialResponseRedactsPortalID(t *testing.T) {
	if got := credentialAccountIDForResponse(canonical.SourceHubSpot, "12345"); got != "[redacted-hubspot-portal]" {
		t.Fatalf("credential account response = %q, want redacted HubSpot portal", got)
	}
}

func TestCreateHubSpotJobRejectsSecondUnrolledBackPortalLineage(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := hubSpotBindingTestSession("12345", "na1")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")

	originalJobID, err := h.createJob(ctx, "tenant_a", canonical.SourceHubSpot, sess)
	if err != nil {
		t.Fatalf("create original HubSpot job: %v", err)
	}
	_, err = h.createJob(ctx, "tenant_a", canonical.SourceHubSpot, sess)
	if !errors.Is(err, errHubSpotLineageConflict) {
		t.Fatalf("second HubSpot job error = %v, want lineage conflict", err)
	}
	if !strings.Contains(err.Error(), originalJobID) || !strings.Contains(err.Error(), "delta-import") {
		t.Fatalf("lineage conflict = %v, want original job and reuse guidance", err)
	}
	for _, secret := range []string{sess.AccountID, sess.AccessToken, hubspotx.AccountFingerprint(sess)} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("lineage conflict leaked account identity %q: %v", secret, err)
		}
	}

	original, err := store.Get(ctx, originalJobID)
	if err != nil {
		t.Fatalf("get original HubSpot job: %v", err)
	}
	original.Status = canonical.MigRolledBack
	if err := store.Update(ctx, original); err != nil {
		t.Fatalf("mark original HubSpot job rolled back: %v", err)
	}
	if _, err := h.createJob(ctx, "tenant_a", canonical.SourceHubSpot, sess); err != nil {
		t.Fatalf("create HubSpot job after completed rollback: %v", err)
	}
}

func TestHubSpotBindingRejectsPortalLocationDriftAndForgedMetadata(t *testing.T) {
	original := hubSpotBindingTestSession("12345", "na1")
	job := hubSpotBindingTestJob("hubspot-binding", canonical.MigCompleted, original)
	forged := original
	forged.Extra = cloneHubSpotStringMap(original.Extra)
	forged.Extra[hubspotx.AccountFingerprintExtraKey] = strings.Repeat("e", sha256.Size*2)
	inconsistent := original
	inconsistent.AccountID = "54321"

	for _, tc := range []struct {
		name string
		sess adapter.Session
	}{
		{name: "different portal", sess: hubSpotBindingTestSession("54321", "na1")},
		{name: "different hosting location", sess: hubSpotBindingTestSession("12345", "eu1")},
		{name: "portal metadata disagrees", sess: inconsistent},
		{name: "forged fingerprint", sess: forged},
		{name: "missing stable identity", sess: adapter.Session{Source: canonical.SourceHubSpot, AccountID: original.AccountID, AccessToken: "secret"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireHubSpotAccount(job, tc.sess)
			if err == nil || !strings.Contains(err.Error(), "does not match migration job") {
				t.Fatalf("binding error = %v, want fail-closed mismatch", err)
			}
			for _, secret := range []string{"12345", "54321", hubspotx.AccountFingerprint(original), "secret"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("binding error leaked %q: %v", secret, err)
				}
			}
		})
	}
}

func TestHubSpotBindingSurvivesDeltaCursorResetAndRestore(t *testing.T) {
	sess := hubSpotBindingTestSession("12345", "eu1")
	job := hubSpotBindingTestJob("hubspot-delta", canonical.MigCompleted, sess)
	wantFingerprint, _ := cursorString(job.Cursor, hubSpotAccountCursorKey)
	wantLocation, _ := cursorString(job.Cursor, hubSpotDataLocationCursorKey)
	page := "page-two"
	job.Cursor["subscribers"] = &page

	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatalf("attach delta snapshot: %v", err)
	}
	tampered := strings.Repeat("f", sha256.Size*2)
	job.Cursor[hubSpotAccountCursorKey] = &tampered
	location := "na1"
	job.Cursor[hubSpotDataLocationCursorKey] = &location
	clearDeltaImportSnapshot(job)
	for key, want := range map[string]string{
		hubSpotAccountCursorKey:      wantFingerprint,
		hubSpotDataLocationCursorKey: wantLocation,
	} {
		if got, ok := cursorString(job.Cursor, key); !ok || got != want {
			t.Fatalf("restored %s = %q/%v, want %q/true", key, got, ok, want)
		}
	}
}

func TestHubSpotAccountLeaseContendsAcrossJobsAndTenants(t *testing.T) {
	sess := hubSpotBindingTestSession("12345", "na1")
	fingerprint := hubspotx.AccountFingerprint(sess)
	held, err := orchestrator.AcquireHubSpotAccountExecutionLease(context.Background(), nil, fingerprint)
	if err != nil {
		t.Fatalf("hold HubSpot account lease: %v", err)
	}
	defer func() { _ = held.Release() }()

	job := hubSpotBindingTestJob("hubspot-other-job", canonical.MigCompleted, sess)
	job.TenantID = "tenant_b"
	_, err = NewMigration("").acquireSourceAccountSessionExecution(context.Background(), job, sess)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("same-account lease error = %v, want contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) || strings.Contains(err.Error(), sess.AccountID) {
		t.Fatalf("account contention leaked stable identity: %v", err)
	}
}

func TestRefreshHubSpotSourceSessionPreservesPortalBinding(t *testing.T) {
	var gotAuth string
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		gotAuth = req.Header.Get("Authorization")
		switch {
		case strings.Contains(req.URL.Path, "/contacts"):
			return jsonHTTPResponse(req, http.StatusOK, `{"results":[]}`), nil
		case req.URL.Path == "/account-info/2026-03/details":
			return jsonHTTPResponse(req, http.StatusOK, `{"portalId":12345,"dataHostingLocation":"na1"}`), nil
		default:
			return jsonHTTPResponse(req, http.StatusNotFound, `{"message":"unexpected test path"}`), nil
		}
	})

	store := jobstore.NewMemoryJobStore()
	original := hubSpotBindingTestSession("12345", "na1")
	job := hubSpotBindingTestJob("hubspot-refresh", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, original, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(`{"api_key":"replacement-token"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh status/body = %d/%s", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer replacement-token" {
		t.Fatalf("authentication header = %q, want replacement private-app token", gotAuth)
	}
	if strings.Contains(rec.Body.String(), original.AccountID) {
		t.Fatalf("refresh response leaked HubSpot portal ID: %s", rec.Body.String())
	}
	stored, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if stored.AccessToken != "replacement-token" || hubspotx.AccountFingerprint(stored) != hubspotx.AccountFingerprint(original) {
		t.Fatalf("stored refreshed session does not preserve bound portal: %+v", stored)
	}
}

func TestRefreshHubSpotSourceSessionRejectsDifferentPortal(t *testing.T) {
	installActiveCampaignTestTransport(t, func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(req.URL.Path, "/contacts"):
			return jsonHTTPResponse(req, http.StatusOK, `{"results":[]}`), nil
		case req.URL.Path == "/account-info/2026-03/details":
			return jsonHTTPResponse(req, http.StatusOK, `{"portalId":54321,"dataHostingLocation":"na1"}`), nil
		default:
			return jsonHTTPResponse(req, http.StatusNotFound, `{"message":"unexpected test path"}`), nil
		}
	})

	store := jobstore.NewMemoryJobStore()
	original := hubSpotBindingTestSession("12345", "na1")
	job := hubSpotBindingTestJob("hubspot-refresh-mismatch", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, original, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(`{"api_key":"other-portal-token"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "does not match migration job") {
		t.Fatalf("refresh status/body = %d/%s, want portal-binding conflict", rec.Code, rec.Body.String())
	}
	for _, leaked := range []string{"12345", "54321", "other-portal-token"} {
		if strings.Contains(rec.Body.String(), leaked) {
			t.Fatalf("refresh mismatch response leaked %q: %s", leaked, rec.Body.String())
		}
	}
	stored, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if stored.AccessToken != original.AccessToken || hubspotx.AccountFingerprint(stored) != hubspotx.AccountFingerprint(original) {
		t.Fatalf("rejected reconnect replaced the original session: %+v", stored)
	}
}

func TestRefreshHubSpotSourceSessionJoinsAccountLease(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	original := hubSpotBindingTestSession("12345", "na1")
	job := hubSpotBindingTestJob("hubspot-refresh-account-lease", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	held, err := orchestrator.AcquireHubSpotAccountExecutionLease(context.Background(), nil, hubspotx.AccountFingerprint(original))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Release() }()

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(`{"api_key":"replacement-token"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "account operation is already owned") {
		t.Fatalf("refresh status/body = %d/%s, want account-lease conflict", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), original.AccountID) || strings.Contains(rec.Body.String(), hubspotx.AccountFingerprint(original)) {
		t.Fatalf("account-lease response leaked HubSpot identity: %s", rec.Body.String())
	}
}

func cloneHubSpotStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func hubSpotBindingTestSession(portalID, location string) adapter.Session {
	location = strings.ToLower(strings.TrimSpace(location))
	digest := sha256.Sum256([]byte("hubspot-account-v1\x00" + portalID))
	return adapter.Session{
		AccessToken: "hubspot-binding-secret",
		AccountID:   portalID,
		Source:      canonical.SourceHubSpot,
		Extra: map[string]string{
			hubspotx.HubIDExtraKey:               portalID,
			hubspotx.DataHostingLocationExtraKey: location,
			hubspotx.AccountFingerprintExtraKey:  hex.EncodeToString(digest[:]),
		},
	}
}

func hubSpotBindingTestJob(id string, status canonical.MigrationStatus, sess adapter.Session) *canonical.MigrationJob {
	now := time.Now().UTC().Add(-time.Hour)
	fingerprint := hubspotx.AccountFingerprint(sess)
	location := sess.Extra[hubspotx.DataHostingLocationExtraKey]
	return &canonical.MigrationJob{
		ID:          id,
		TenantID:    "tenant_a",
		Source:      canonical.SourceHubSpot,
		Status:      status,
		StartedAt:   now,
		CompletedAt: &now,
		Cursor: map[string]*string{
			hubSpotAccountCursorKey:      &fingerprint,
			hubSpotDataLocationCursorKey: &location,
		},
	}
}
