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
)

func TestDeltaImportInvalidatesShadowAttemptOnSuccessAndRestoresItOnFailure(t *testing.T) {
	const previousToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	newCompletedJob := func() *canonical.MigrationJob {
		token := previousToken
		return &canonical.MigrationJob{
			Source: canonical.SourceBeehiiv,
			Status: canonical.MigCompleted,
			Cursor: map[string]*string{shadowAttemptTokenCursorKey: &token},
		}
	}

	t.Run("success", func(t *testing.T) {
		job := newCompletedJob()
		if err := attachDeltaImportSnapshot(job); err != nil {
			t.Fatal(err)
		}
		if _, ok := job.Cursor[shadowAttemptTokenCursorKey]; ok {
			t.Fatalf("started delta retained stale shadow token: %#v", job.Cursor)
		}
		clearDeltaImportSnapshot(job)
		if _, ok := job.Cursor[shadowAttemptTokenCursorKey]; ok {
			t.Fatalf("successful delta restored stale shadow token: %#v", job.Cursor)
		}
	})

	t.Run("failure", func(t *testing.T) {
		job := newCompletedJob()
		if err := attachDeltaImportSnapshot(job); err != nil {
			t.Fatal(err)
		}
		if !restoreDeltaImportSnapshot(job, errors.New("provider unavailable")) {
			t.Fatal("failed delta did not restore its previous completed snapshot")
		}
		if got, ok := cursorString(job.Cursor, shadowAttemptTokenCursorKey); !ok || got != previousToken {
			t.Fatalf("restored shadow token = %q/%t, want %q/true", got, ok, previousToken)
		}
	})
}

func TestDeltaImportSnapshotPreservesImmutableControlCursorsThroughClear(t *testing.T) {
	activeCampaignFingerprint := "activecampaign-fingerprint"
	mailchimpFingerprint := "mailchimp-fingerprint"
	selectedAudiences := "aud-a,aud-b"
	subscriberCursor := "completed-subscriber-page"
	rollbackEvidence := "pass"
	job := &canonical.MigrationJob{
		Source: canonical.SourceActiveCampaign,
		Cursor: map[string]*string{
			activeCampaignAccountCursorKey: &activeCampaignFingerprint,
			mailchimpAccountCursorKey:      &mailchimpFingerprint,
			selectedAudiencesCursorKey:     &selectedAudiences,
			"subscribers":                  &subscriberCursor,
			rollbackRehearsalStatusKey:     &rollbackEvidence,
		},
	}

	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		activeCampaignAccountCursorKey: activeCampaignFingerprint,
		mailchimpAccountCursorKey:      mailchimpFingerprint,
		selectedAudiencesCursorKey:     selectedAudiences,
		rollbackRehearsalStatusKey:     rollbackEvidence,
	} {
		if got, ok := cursorString(job.Cursor, key); !ok || got != want {
			t.Fatalf("cursor %q = %q/%v, want %q/true", key, got, ok, want)
		}
	}
	if _, ok := job.Cursor["subscribers"]; ok {
		t.Fatalf("execution cursor survived fresh delta attachment: %#v", job.Cursor)
	}
	rawSnapshot, ok := cursorString(job.Cursor, deltaImportSnapshotKey)
	if !ok || !strings.Contains(rawSnapshot, subscriberCursor) {
		t.Fatalf("snapshot = %q/%v, want prior execution cursor", rawSnapshot, ok)
	}

	// Completion must restore the original immutable values even if an
	// in-flight worker or an older service instance changed or dropped them.
	tampered := "tampered"
	job.Cursor[activeCampaignAccountCursorKey] = &tampered
	job.Cursor[mailchimpAccountCursorKey] = &tampered
	delete(job.Cursor, selectedAudiencesCursorKey)
	clearDeltaImportSnapshot(job)
	for key, want := range map[string]string{
		activeCampaignAccountCursorKey: activeCampaignFingerprint,
		mailchimpAccountCursorKey:      mailchimpFingerprint,
		selectedAudiencesCursorKey:     selectedAudiences,
	} {
		if got, ok := cursorString(job.Cursor, key); !ok || got != want {
			t.Fatalf("cleared cursor %q = %q/%v, want restored %q/true", key, got, ok, want)
		}
	}
	if _, ok := job.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot survived clear: %#v", job.Cursor)
	}
}

func TestDeltaImportRejectsActiveCampaignAccountDriftBeforeMutation(t *testing.T) {
	originalFingerprint := activeCampaignTestFingerprint(t, "https://account-one.api-us1.com/api/3")
	otherFingerprint := activeCampaignTestFingerprint(t, "https://account-two.api-us1.com/api/3")
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(7 * 24 * time.Hour)
	subscriberCursor := "complete"
	job := &canonical.MigrationJob{
		ID:            "ac-delta-account-drift-transition",
		TenantID:      "tenant-a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Progress:      canonical.MigrationProgress{SubscribersTotal: 12, SubscribersDone: 12},
		Cursor: map[string]*string{
			activeCampaignAccountCursorKey: &originalFingerprint,
			"subscribers":                  &subscriberCursor,
		},
		VerificationReport: &canonical.VerificationReport{SubscribersImported: 12},
	}
	store := jobstore.NewMemoryJobStore()
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, adapter.Session{
		Source:      canonical.SourceActiveCampaign,
		AccessToken: "wrong-account-token",
		AccountID:   "account-two.api-us1.com",
		Extra: map[string]string{
			activecampaign.AccountFingerprintExtraKey: otherFingerprint,
		},
	}, time.Now().Add(sourceBridgeSessionTTL)); err != nil {
		t.Fatal(err)
	}

	h := NewMigration("", store)
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPost, "/v1/migrations/activecampaign/delta-import", bytes.NewBufferString(`{"job_id":"`+job.ID+`"}`))
	req.Header.Set("X-Tenant-ID", job.TenantID)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "original account") {
		t.Fatalf("status/body = %d/%s, want account-drift conflict", rec.Code, rec.Body.String())
	}
	stored, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != canonical.MigCompleted || stored.Progress.SubscribersDone != 12 || stored.VerificationReport == nil || stored.VerificationReport.SubscribersImported != 12 {
		t.Fatalf("job mutated after rejected delta transition: %+v", stored)
	}
	if stored.CompletedAt == nil || !stored.CompletedAt.Equal(completedAt) || stored.RollbackUntil == nil || !stored.RollbackUntil.Equal(rollbackUntil) {
		t.Fatalf("completion lifecycle mutated after rejected delta: %+v", stored)
	}
	if got, _ := cursorString(stored.Cursor, activeCampaignAccountCursorKey); got != originalFingerprint {
		t.Fatalf("account cursor = %q, want original fingerprint", got)
	}
	if got, _ := cursorString(stored.Cursor, "subscribers"); got != subscriberCursor {
		t.Fatalf("subscriber cursor = %q, want %q", got, subscriberCursor)
	}
	for _, key := range []string{runModeCursorKey, deltaImportSnapshotKey, deltaImportStartedAtKey} {
		if _, ok := stored.Cursor[key]; ok {
			t.Fatalf("cursor %q written before rejected transition: %#v", key, stored.Cursor)
		}
	}
}

func TestRunJobRejectsActiveCampaignAccountDriftAndRestoresDeltaSnapshot(t *testing.T) {
	originalFingerprint := activeCampaignTestFingerprint(t, "https://account-one.api-us1.com/api/3")
	otherFingerprint := activeCampaignTestFingerprint(t, "https://account-two.api-us1.com/api/3")
	completedAt := time.Now().Add(-time.Hour).UTC()
	rollbackUntil := completedAt.Add(7 * 24 * time.Hour)
	subscriberCursor := "complete"
	job := &canonical.MigrationJob{
		ID:            "ac-delta-account-drift-worker",
		TenantID:      "tenant-a",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		StartedAt:     completedAt.Add(-time.Hour),
		CompletedAt:   &completedAt,
		RollbackUntil: &rollbackUntil,
		Progress:      canonical.MigrationProgress{SubscribersTotal: 7, SubscribersDone: 7},
		Cursor: map[string]*string{
			activeCampaignAccountCursorKey: &originalFingerprint,
			"subscribers":                  &subscriberCursor,
		},
		VerificationReport: &canonical.VerificationReport{SubscribersImported: 7},
	}
	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatal(err)
	}
	if got, _ := cursorString(job.Cursor, activeCampaignAccountCursorKey); got != originalFingerprint {
		t.Fatalf("attached account cursor = %q, want %q", got, originalFingerprint)
	}
	job.Status = canonical.MigImporting
	job.Progress = canonical.MigrationProgress{}
	job.CompletedAt = nil
	job.RollbackUntil = nil
	job.VerificationReport = nil
	job.StartedAt = time.Now().UTC()

	store := jobstore.NewMemoryJobStore()
	ctx := jobstore.WithTenantID(context.Background(), job.TenantID)
	if err := store.Create(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, job.ID, job.TenantID, adapter.Session{
		Source:      canonical.SourceActiveCampaign,
		AccessToken: "wrong-account-token",
		AccountID:   "account-two.api-us1.com",
		Extra: map[string]string{
			activecampaign.AccountFingerprintExtraKey: otherFingerprint,
		},
	}, time.Now().Add(sourceBridgeSessionTTL)); err != nil {
		t.Fatal(err)
	}

	NewMigration("", store).runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != canonical.MigCompleted || stored.Progress.SubscribersDone != 7 || stored.VerificationReport == nil || stored.VerificationReport.SubscribersImported != 7 {
		t.Fatalf("worker did not restore completed snapshot after account drift: %+v", stored)
	}
	if stored.CompletedAt == nil || !stored.CompletedAt.Equal(completedAt) || stored.RollbackUntil == nil || !stored.RollbackUntil.Equal(rollbackUntil) {
		t.Fatalf("worker did not restore completion lifecycle: %+v", stored)
	}
	if got, _ := cursorString(stored.Cursor, activeCampaignAccountCursorKey); got != originalFingerprint {
		t.Fatalf("restored account cursor = %q, want %q", got, originalFingerprint)
	}
	if got, _ := cursorString(stored.Cursor, "subscribers"); got != subscriberCursor {
		t.Fatalf("restored subscriber cursor = %q, want %q", got, subscriberCursor)
	}
	if _, ok := stored.Cursor[deltaImportSnapshotKey]; ok {
		t.Fatalf("delta snapshot survived failed worker restore: %#v", stored.Cursor)
	}
	if stored.Error == nil || !strings.Contains(*stored.Error, "delta import failed") || !strings.Contains(*stored.Error, "original account") {
		t.Fatalf("worker error = %v, want fail-closed account mismatch", stored.Error)
	}
}

func activeCampaignTestFingerprint(t *testing.T, apiURL string) string {
	t.Helper()
	fingerprint, err := activecampaign.AccountFingerprintForAPIURL(apiURL)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}
