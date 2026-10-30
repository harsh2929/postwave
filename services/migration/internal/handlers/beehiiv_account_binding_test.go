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
	"github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestCreateBeehiivJobPersistsWorkspacePublicationBinding(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := beehiivBindingTestSession("work_primary", "pub_newsletter")

	jobID, err := h.createJob(jobstore.WithTenantID(context.Background(), "tenant_a"), "tenant_a", canonical.SourceBeehiiv, sess)
	if err != nil {
		t.Fatalf("create Beehiiv job: %v", err)
	}
	job, err := store.Get(jobstore.WithTenantID(context.Background(), "tenant_a"), jobID)
	if err != nil {
		t.Fatalf("get Beehiiv job: %v", err)
	}

	if got, _ := cursorString(job.Cursor, beehiivAccountCursorKey); got != beehiiv.AccountFingerprint(sess) {
		t.Fatalf("account fingerprint = %q, want session binding", got)
	}
	workspaceFingerprint := beehiivWorkspaceFingerprint(sess)
	if got, _ := cursorString(job.Cursor, beehiivWorkspaceCursorKey); got != workspaceFingerprint {
		t.Fatalf("workspace fingerprint = %q, want %q", got, workspaceFingerprint)
	}
	if strings.Contains(workspaceFingerprint, beehiiv.WorkspaceID(sess)) {
		t.Fatalf("workspace fingerprint leaked raw workspace id: %q", workspaceFingerprint)
	}
	if got, _ := cursorString(job.Cursor, beehiivPublicationCursorKey); got != "pub_newsletter" {
		t.Fatalf("publication binding = %q, want pub_newsletter", got)
	}
	if err := requireBeehiivAccount(job, sess); err != nil {
		t.Fatalf("saved Beehiiv binding rejected: %v", err)
	}
}

func TestBeehiivBindingRejectsWorkspaceAndPublicationDrift(t *testing.T) {
	original := beehiivBindingTestSession("work_primary", "pub_newsletter")
	job := beehiivBindingTestJob("beehiiv-binding", canonical.MigCompleted, original)
	inconsistentAccountID := original
	inconsistentAccountID.AccountID = "pub_other"
	forgedFingerprint := original
	forgedFingerprint.Extra = make(map[string]string, len(original.Extra))
	for key, value := range original.Extra {
		forgedFingerprint.Extra[key] = value
	}
	forgedFingerprint.Extra[beehiiv.AccountFingerprintExtraKey] = strings.Repeat("e", sha256.Size*2)

	for _, tc := range []struct {
		name string
		sess adapter.Session
	}{
		{name: "other publication in same workspace", sess: beehiivBindingTestSession("work_primary", "pub_other")},
		{name: "same publication id in other workspace", sess: beehiivBindingTestSession("work_other", "pub_newsletter")},
		{name: "account id and publication metadata disagree", sess: inconsistentAccountID},
		{name: "fingerprint does not derive from workspace and publication", sess: forgedFingerprint},
		{name: "missing stable identity", sess: adapter.Session{Source: canonical.SourceBeehiiv, AccountID: "pub_newsletter", AccessToken: "secret"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireBeehiivAccount(job, tc.sess)
			if err == nil || !strings.Contains(err.Error(), "does not match migration job") {
				t.Fatalf("binding error = %v, want fail-closed mismatch", err)
			}
			for _, secret := range []string{"work_primary", "work_other", "pub_newsletter", "pub_other", beehiiv.AccountFingerprint(original)} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("binding error leaked %q: %v", secret, err)
				}
			}
		})
	}
}

func TestLoadCutoverSessionRejectsBeehiivDriftBeforeProviderWork(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	original := beehiivBindingTestSession("work_primary", "pub_newsletter")
	job := beehiivBindingTestJob("beehiiv-cutover", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	drifted := beehiivBindingTestSession("work_primary", "pub_other")
	if err := store.SaveSession(ctx, job.ID, job.TenantID, drifted, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	_, status, err := NewMigration("", store).loadCutoverSession(context.Background(), job.TenantID, job.ID, job.Source, "testing cutover")
	if status != http.StatusConflict || err == nil {
		t.Fatalf("status/error = %d/%v, want 409 binding rejection", status, err)
	}
}

func TestBeehiivBindingSurvivesDeltaExecutionCursorResetAndRestore(t *testing.T) {
	sess := beehiivBindingTestSession("work_primary", "pub_newsletter")
	job := beehiivBindingTestJob("beehiiv-delta", canonical.MigCompleted, sess)
	wantAccount, _ := cursorString(job.Cursor, beehiivAccountCursorKey)
	wantWorkspace, _ := cursorString(job.Cursor, beehiivWorkspaceCursorKey)
	wantPublication, _ := cursorString(job.Cursor, beehiivPublicationCursorKey)
	executionCursor := "page-two"
	job.Cursor["subscribers"] = &executionCursor

	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatalf("attach delta snapshot: %v", err)
	}
	tampered := strings.Repeat("f", sha256.Size*2)
	job.Cursor[beehiivAccountCursorKey] = &tampered
	job.Cursor[beehiivWorkspaceCursorKey] = &tampered
	wrongPublication := "pub_other"
	job.Cursor[beehiivPublicationCursorKey] = &wrongPublication
	clearDeltaImportSnapshot(job)

	for key, want := range map[string]string{
		beehiivAccountCursorKey:     wantAccount,
		beehiivWorkspaceCursorKey:   wantWorkspace,
		beehiivPublicationCursorKey: wantPublication,
	} {
		if got, ok := cursorString(job.Cursor, key); !ok || got != want {
			t.Fatalf("restored %s = %q/%v, want %q/true", key, got, ok, want)
		}
	}
}

func TestBeehiivWorkspaceLeaseContendsAcrossPublications(t *testing.T) {
	first := beehiivBindingTestSession("work_shared", "pub_first")
	second := beehiivBindingTestSession("work_shared", "pub_second")
	other := beehiivBindingTestSession("work_other", "pub_first")
	workspaceFingerprint := beehiivWorkspaceFingerprint(first)

	held, err := orchestrator.AcquireBeehiivWorkspaceExecutionLease(context.Background(), nil, workspaceFingerprint)
	if err != nil {
		t.Fatalf("hold workspace lease: %v", err)
	}
	defer func() { _ = held.Release() }()

	h := NewMigration("")
	job := beehiivBindingTestJob("beehiiv-second", canonical.MigCompleted, second)
	_, err = h.acquireSourceAccountSessionExecution(context.Background(), job, second)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("same-workspace lease error = %v, want contention", err)
	}
	if strings.Contains(err.Error(), workspaceFingerprint) || strings.Contains(err.Error(), "work_shared") {
		t.Fatalf("workspace contention leaked stable identity: %v", err)
	}

	otherJob := beehiivBindingTestJob("beehiiv-other", canonical.MigCompleted, other)
	otherLease, err := h.acquireSourceAccountSessionExecution(context.Background(), otherJob, other)
	if err != nil {
		t.Fatalf("different workspace lease: %v", err)
	}
	if err := otherLease.Release(); err != nil {
		t.Fatalf("release different workspace lease: %v", err)
	}
}

func TestRefreshBeehiivSessionRejectsDifferentWorkspace(t *testing.T) {
	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer replacement-secret" {
			t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
		}
		switch req.URL.Path {
		case "/v2/workspaces/identify":
			return jsonHTTPResponse(req, http.StatusOK, `{"data":{"id":"work_other","name":"Other"}}`), nil
		case "/v2/publications":
			return jsonHTTPResponse(req, http.StatusOK, `{"data":[{"id":"pub_newsletter","name":"Newsletter"}],"page":1,"total_pages":1,"total_results":1}`), nil
		default:
			t.Fatalf("unexpected Beehiiv request: %s", req.URL.String())
			return nil, nil
		}
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	store := jobstore.NewMemoryJobStore()
	original := beehiivBindingTestSession("work_primary", "pub_newsletter")
	job := beehiivBindingTestJob("beehiiv-refresh", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, original, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatalf("save original session: %v", err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(`{"api_key":"replacement-secret"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "replacement-secret") || strings.Contains(rec.Body.String(), "work_other") {
		t.Fatalf("refresh response leaked provider detail: %s", rec.Body.String())
	}
	stored, err := store.GetSession(ctx, job.TenantID, job.ID, time.Now())
	if err != nil {
		t.Fatalf("get preserved session: %v", err)
	}
	if stored.AccessToken != original.AccessToken || beehiiv.AccountFingerprint(stored) != beehiiv.AccountFingerprint(original) {
		t.Fatalf("rejected refresh replaced bound session: %+v", stored)
	}
}

func TestRefreshBeehiivSessionRejectsDifferentPublicationBeforeAuthentication(t *testing.T) {
	originalTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatalf("different-publication refresh reached provider: %s", req.URL.String())
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	store := jobstore.NewMemoryJobStore()
	original := beehiivBindingTestSession("work_primary", "pub_newsletter")
	job := beehiivBindingTestJob("beehiiv-refresh-publication", canonical.MigCompleted, original)
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, original, time.Now().Add(30*24*time.Hour)); err != nil {
		t.Fatalf("save original session: %v", err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+job.ID+"/source-session", bytes.NewBufferString(`{"api_key":"replacement-secret","account_id":"pub_other"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
}

func TestBeehiivLocalDemoHasSafeDeterministicBindingAndSensitiveErrorsAreRedacted(t *testing.T) {
	sess := localDemoSession(canonical.SourceBeehiiv, "ignored")
	if got := beehiiv.AccountFingerprint(sess); len(got) != sha256.Size*2 {
		t.Fatalf("demo account fingerprint length = %d, want %d", len(got), sha256.Size*2)
	}
	if got := beehiivWorkspaceFingerprint(sess); len(got) != sha256.Size*2 {
		t.Fatalf("demo workspace fingerprint length = %d, want %d", len(got), sha256.Size*2)
	}
	redacted := sanitizeMigrationErrorText(canonical.SourceBeehiiv, errors.New("Authorization: Bearer super-secret api_key=another-secret"))
	if strings.Contains(redacted, "super-secret") || strings.Contains(redacted, "another-secret") {
		t.Fatalf("Beehiiv error was not redacted: %q", redacted)
	}
}

func beehiivBindingTestSession(workspaceID, publicationID string) adapter.Session {
	digest := sha256.Sum256([]byte(workspaceID + "\x00" + publicationID))
	return adapter.Session{
		AccessToken: "beehiiv-secret",
		AccountID:   publicationID,
		Source:      canonical.SourceBeehiiv,
		Extra: map[string]string{
			beehiiv.WorkspaceIDExtraKey:        workspaceID,
			beehiiv.PublicationIDExtraKey:      publicationID,
			beehiiv.AccountFingerprintExtraKey: hex.EncodeToString(digest[:]),
		},
	}
}

func beehiivBindingTestJob(id string, status canonical.MigrationStatus, sess adapter.Session) *canonical.MigrationJob {
	accountFingerprint := beehiivAccountFingerprint(sess)
	workspaceFingerprint := beehiivWorkspaceFingerprint(sess)
	publicationID := beehiivPublicationID(sess)
	now := time.Now().UTC().Add(-time.Hour)
	return &canonical.MigrationJob{
		ID:          id,
		TenantID:    "tenant_a",
		Source:      canonical.SourceBeehiiv,
		Status:      status,
		StartedAt:   now,
		CompletedAt: &now,
		Cursor: map[string]*string{
			beehiivAccountCursorKey:     &accountFingerprint,
			beehiivWorkspaceCursorKey:   &workspaceFingerprint,
			beehiivPublicationCursorKey: &publicationID,
		},
	}
}
