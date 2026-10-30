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
	klaviyox "github.com/postwave/migrate/klaviyo"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestCreateKlaviyoJobPersistsOpaqueAccountBinding(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := klaviyoBindingTestSession("account_primary")

	jobID, err := h.createJob(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", canonical.SourceKlaviyo, sess)
	if err != nil {
		t.Fatalf("create Klaviyo job: %v", err)
	}
	job, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), jobID)
	if err != nil {
		t.Fatalf("get Klaviyo job: %v", err)
	}
	want := klaviyox.AccountFingerprint(sess)
	if got, ok := cursorString(job.Cursor, klaviyoAccountCursorKey); !ok || got != want {
		t.Fatalf("account fingerprint = %q/%v, want %q/true", got, ok, want)
	}
	if strings.Contains(want, sess.AccountID) {
		t.Fatalf("account fingerprint leaked provider account id: %q", want)
	}
	if err := requireKlaviyoAccount(job, sess); err != nil {
		t.Fatalf("saved Klaviyo binding rejected: %v", err)
	}
}

func TestCreateKlaviyoJobRejectsSecondUnrolledBackAccountLineage(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := klaviyoBindingTestSession("account_primary")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")

	originalJobID, err := h.createJob(ctx, "tenant_a", canonical.SourceKlaviyo, sess)
	if err != nil {
		t.Fatalf("create original Klaviyo job: %v", err)
	}
	_, err = h.createJob(ctx, "tenant_a", canonical.SourceKlaviyo, sess)
	if !errors.Is(err, errKlaviyoLineageConflict) {
		t.Fatalf("second Klaviyo job error = %v, want lineage conflict", err)
	}
	if !strings.Contains(err.Error(), originalJobID) || !strings.Contains(err.Error(), "delta-import") {
		t.Fatalf("lineage conflict = %v, want original job and reuse guidance", err)
	}
	for _, secret := range []string{sess.AccountID, sess.AccessToken, klaviyox.AccountFingerprint(sess)} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("lineage conflict leaked account identity %q: %v", secret, err)
		}
	}
	jobs, listErr := store.List(ctx, "tenant_a")
	if listErr != nil || len(jobs) != 1 {
		t.Fatalf("jobs after rejected lineage = %d, %v; want one", len(jobs), listErr)
	}

	rec := httptest.NewRecorder()
	writeMigrationJobCreationErr(rec, err)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), originalJobID) {
		t.Fatalf("lineage HTTP response = %d %s, want 409 with original job", rec.Code, rec.Body.String())
	}

	original, getErr := store.Get(ctx, originalJobID)
	if getErr != nil {
		t.Fatalf("get original Klaviyo job: %v", getErr)
	}
	original.Status = canonical.MigRolledBack
	if updateErr := store.Update(ctx, original); updateErr != nil {
		t.Fatalf("mark original Klaviyo job rolled back: %v", updateErr)
	}
	replacementJobID, err := h.createJob(ctx, "tenant_a", canonical.SourceKlaviyo, sess)
	if err != nil {
		t.Fatalf("create Klaviyo job after completed rollback: %v", err)
	}
	if replacementJobID == originalJobID {
		t.Fatal("replacement Klaviyo lineage reused the rolled-back job id")
	}
}

func TestKlaviyoLineageWithoutSessionCanReconnectOriginalJob(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := klaviyoBindingTestSession("account_primary")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")
	jobID, err := h.createJob(ctx, "tenant_a", canonical.SourceKlaviyo, sess)
	if err != nil {
		t.Fatalf("create Klaviyo job: %v", err)
	}
	if err := store.DeleteSession(ctx, "tenant_a", jobID); err != nil {
		t.Fatalf("delete Klaviyo source session: %v", err)
	}

	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "a.klaviyo.com" || req.URL.Path != "/api/accounts" {
			t.Fatalf("unexpected Klaviyo request: %s", req.URL.String())
		}
		if req.Header.Get("Authorization") != "Klaviyo-API-Key replacement-secret" {
			t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
		}
		return jsonHTTPResponse(req, http.StatusOK, `{"data":[{"type":"account","id":"account_primary"}]}`), nil
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+jobID+"/source-session", bytes.NewBufferString(`{"api_key":"replacement-secret"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reconnect original Klaviyo job = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	reconnected, err := store.GetSession(ctx, "tenant_a", jobID, time.Now())
	if err != nil {
		t.Fatalf("load reconnected Klaviyo session: %v", err)
	}
	if reconnected.AccessToken != "replacement-secret" || reconnected.AccountID != "account_primary" {
		t.Fatalf("unexpected reconnected Klaviyo session: %+v", reconnected)
	}
}

func TestKlaviyoBindingRejectsAccountDriftAndForgedMetadata(t *testing.T) {
	original := klaviyoBindingTestSession("account_primary")
	want := klaviyox.AccountFingerprint(original)
	job := klaviyoBindingTestJob("klaviyo-binding", canonical.MigCompleted, original)
	forged := original
	forged.Extra = map[string]string{
		klaviyox.AccountIDExtraKey:          original.AccountID,
		klaviyox.AccountFingerprintExtraKey: strings.Repeat("e", sha256.Size*2),
		"auth_scheme":                       "private_api_key",
	}
	inconsistent := original
	inconsistent.AccountID = "account_other"

	for _, tc := range []struct {
		name string
		sess adapter.Session
	}{
		{name: "different account", sess: klaviyoBindingTestSession("account_other")},
		{name: "account metadata disagrees", sess: inconsistent},
		{name: "forged fingerprint", sess: forged},
		{name: "missing stable identity", sess: adapter.Session{Source: canonical.SourceKlaviyo, AccountID: original.AccountID, AccessToken: "secret"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireKlaviyoAccount(job, tc.sess)
			if err == nil || !strings.Contains(err.Error(), "does not match migration job") {
				t.Fatalf("binding error = %v, want fail-closed mismatch", err)
			}
			for _, secret := range []string{"account_primary", "account_other", want, "secret"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("binding error leaked %q: %v", secret, err)
				}
			}
		})
	}
}

func TestKlaviyoBindingSurvivesDeltaCursorResetAndRestore(t *testing.T) {
	sess := klaviyoBindingTestSession("account_primary")
	job := klaviyoBindingTestJob("klaviyo-delta", canonical.MigCompleted, sess)
	want, _ := cursorString(job.Cursor, klaviyoAccountCursorKey)
	page := "page-two"
	job.Cursor["subscribers"] = &page

	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatalf("attach delta snapshot: %v", err)
	}
	tampered := strings.Repeat("f", sha256.Size*2)
	job.Cursor[klaviyoAccountCursorKey] = &tampered
	clearDeltaImportSnapshot(job)
	if got, ok := cursorString(job.Cursor, klaviyoAccountCursorKey); !ok || got != want {
		t.Fatalf("restored account binding = %q/%v, want %q/true", got, ok, want)
	}
}

func TestKlaviyoAccountLeaseContendsAcrossJobsAndTenants(t *testing.T) {
	sess := klaviyoBindingTestSession("account_shared")
	fingerprint := klaviyox.AccountFingerprint(sess)
	held, err := orchestrator.AcquireKlaviyoAccountExecutionLease(context.Background(), nil, fingerprint)
	if err != nil {
		t.Fatalf("hold Klaviyo account lease: %v", err)
	}
	defer func() { _ = held.Release() }()

	job := klaviyoBindingTestJob("klaviyo-other-job", canonical.MigCompleted, sess)
	job.TenantID = "tenant_b"
	_, err = NewMigration("").acquireSourceAccountSessionExecution(context.Background(), job, sess)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("same-account lease error = %v, want contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) || strings.Contains(err.Error(), sess.AccountID) {
		t.Fatalf("account contention leaked stable identity: %v", err)
	}
}

func TestInitialKlaviyoCredentialsJoinAccountLeaseAfterIdentity(t *testing.T) {
	sess := klaviyoBindingTestSession("account_shared")
	fingerprint := klaviyox.AccountFingerprint(sess)
	held, err := orchestrator.AcquireKlaviyoAccountExecutionLease(context.Background(), nil, fingerprint)
	if err != nil {
		t.Fatalf("hold Klaviyo account lease: %v", err)
	}
	defer func() { _ = held.Release() }()

	originalTransport := http.DefaultTransport
	providerCalls := 0
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		providerCalls++
		if req.URL.Host != "a.klaviyo.com" || req.URL.Path != "/api/accounts" {
			t.Fatalf("unexpected Klaviyo request: %s", req.URL.String())
		}
		if req.Header.Get("Authorization") != "Klaviyo-API-Key bootstrap-secret" {
			t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
		}
		return jsonHTTPResponse(req, http.StatusOK, `{"data":[{"type":"account","id":"account_shared"}]}`), nil
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	h := NewMigration("", jobstore.NewMemoryJobStore())
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/klaviyo/credentials", bytes.NewBufferString(`{"api_key":"bootstrap-secret"}`))
	req.Header.Set("X-Tenant-ID", "tenant_a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 account contention; body=%s", rec.Code, rec.Body.String())
	}
	if providerCalls != 1 {
		t.Fatalf("provider calls = %d, want one identity request", providerCalls)
	}
	if strings.Contains(rec.Body.String(), "bootstrap-secret") || strings.Contains(rec.Body.String(), "account_shared") || strings.Contains(rec.Body.String(), fingerprint) {
		t.Fatalf("credential response leaked sensitive identity: %s", rec.Body.String())
	}
}

func TestAuthenticateKlaviyoCredentialRequestAcceptsBearerToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer oauth-secret" {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"data":[{"type":"account","id":"account_oauth"}]}`))
	}))
	defer srv.Close()
	ad := klaviyox.New()
	ad.BaseURL = srv.URL
	sess, status, err := authenticateFromCredentialRequest(context.Background(), canonical.SourceKlaviyo, ad, ad.Capabilities(), credentialRequest{AccessToken: "oauth-secret"})
	if err != nil || status != http.StatusOK {
		t.Fatalf("authenticate bearer = status %d err %v", status, err)
	}
	if sess.AccountID != "account_oauth" || sess.Extra["auth_scheme"] != "bearer" {
		t.Fatalf("unexpected bearer session: %+v", sess)
	}
}

func klaviyoBindingTestSession(accountID string) adapter.Session {
	digest := sha256.Sum256([]byte("klaviyo-account-v1\x00" + accountID))
	return adapter.Session{
		AccessToken: "klaviyo-secret",
		AccountID:   accountID,
		Source:      canonical.SourceKlaviyo,
		Extra: map[string]string{
			klaviyox.AccountIDExtraKey:          accountID,
			klaviyox.AccountFingerprintExtraKey: hex.EncodeToString(digest[:]),
			"auth_scheme":                       "private_api_key",
		},
	}
}

func klaviyoBindingTestJob(id string, status canonical.MigrationStatus, sess adapter.Session) *canonical.MigrationJob {
	fingerprint := klaviyox.AccountFingerprint(sess)
	now := time.Now().UTC().Add(-time.Hour)
	return &canonical.MigrationJob{
		ID:          id,
		TenantID:    "tenant_a",
		Source:      canonical.SourceKlaviyo,
		Status:      status,
		StartedAt:   now,
		CompletedAt: &now,
		Cursor:      map[string]*string{klaviyoAccountCursorKey: &fingerprint},
	}
}
