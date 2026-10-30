package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/customerio"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func TestCreateCustomerIOJobPersistsOpaqueWorkspaceBinding(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := customerIOBindingTestSession("31415", "eu")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")

	jobID, err := h.createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess)
	if err != nil {
		t.Fatalf("create Customer.io job: %v", err)
	}
	job, err := store.Get(ctx, jobID)
	if err != nil {
		t.Fatalf("get Customer.io job: %v", err)
	}
	want := customerio.AccountFingerprint(sess)
	if got, ok := cursorString(job.Cursor, customerIOWorkspaceCursorKey); !ok || got != want {
		t.Fatalf("workspace fingerprint = %q/%v, want %q/true", got, ok, want)
	}
	if got, ok := cursorString(job.Cursor, customerIOWorkspaceIDCursorKey); !ok || got != "31415" {
		t.Fatalf("workspace id = %q/%v, want 31415/true", got, ok)
	}
	if got, ok := cursorString(job.Cursor, customerIORegionCursorKey); !ok || got != "eu" {
		t.Fatalf("region = %q/%v, want eu/true", got, ok)
	}
	if strings.Contains(want, sess.AccountID) {
		t.Fatalf("workspace fingerprint leaked provider workspace id: %q", want)
	}
	if err := requireCustomerIOWorkspace(job, sess); err != nil {
		t.Fatalf("saved Customer.io binding rejected: %v", err)
	}
}

func TestCustomerIOSessionUsesNinetyDayTTLAndFourteenDayReconnectGate(t *testing.T) {
	now := time.Date(2026, time.July, 18, 12, 0, 0, 0, time.UTC)
	expiresAt := sessionExpiresAt(customerIOBindingTestSession("31415", "us"), now)
	if want := now.Add(90 * 24 * time.Hour); !expiresAt.Equal(want) {
		t.Fatalf("Customer.io session expiry = %s, want %s", expiresAt, want)
	}
	if cutoverSessionNearExpiry(canonical.SourceCustomerIO, now.Add(sourceBridgeNearExpiryWindow+time.Second), now) {
		t.Fatal("Customer.io session outside the 14-day reconnect window was rejected")
	}
	if !cutoverSessionNearExpiry(canonical.SourceCustomerIO, now.Add(sourceBridgeNearExpiryWindow), now) {
		t.Fatal("Customer.io session at the 14-day reconnect boundary was accepted")
	}
}

func TestCreateCustomerIOJobRejectsSecondUnrolledBackWorkspaceLineage(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := customerIOBindingTestSession("31415", "us")
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")

	originalJobID, err := h.createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess)
	if err != nil {
		t.Fatalf("create original Customer.io job: %v", err)
	}
	_, err = h.createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess)
	if !errors.Is(err, errCustomerIOLineageConflict) {
		t.Fatalf("second Customer.io job error = %v, want lineage conflict", err)
	}
	if !strings.Contains(err.Error(), originalJobID) || !strings.Contains(err.Error(), "delta-import") {
		t.Fatalf("lineage conflict = %v, want original job and reuse guidance", err)
	}
	for _, secret := range []string{sess.AccountID, sess.AccessToken, customerio.AccountFingerprint(sess)} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("lineage conflict leaked workspace identity %q: %v", secret, err)
		}
	}

	original, err := store.Get(ctx, originalJobID)
	if err != nil {
		t.Fatalf("get original Customer.io job: %v", err)
	}
	original.Status = canonical.MigRolledBack
	if err := store.Update(ctx, original); err != nil {
		t.Fatalf("mark original Customer.io job rolled back: %v", err)
	}
	if _, err := h.createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess); err != nil {
		t.Fatalf("create Customer.io job after completed rollback: %v", err)
	}
}

func TestCustomerIOBindingRejectsWorkspaceRegionDriftAndForgedMetadata(t *testing.T) {
	original := customerIOBindingTestSession("31415", "us")
	job := customerIOBindingTestJob("customerio-binding", canonical.MigCompleted, original)
	forged := original
	forged.Extra = cloneCustomerIOStringMap(original.Extra)
	forged.Extra[customerio.WorkspaceFingerprintExtraKey] = strings.Repeat("e", sha256.Size*2)
	inconsistent := original
	inconsistent.AccountID = "27182"

	for _, tc := range []struct {
		name string
		sess adapter.Session
	}{
		{name: "different workspace", sess: customerIOBindingTestSession("27182", "us")},
		{name: "different region", sess: customerIOBindingTestSession("31415", "eu")},
		{name: "workspace metadata disagrees", sess: inconsistent},
		{name: "forged fingerprint", sess: forged},
		{name: "missing stable identity", sess: adapter.Session{Source: canonical.SourceCustomerIO, AccountID: original.AccountID, AccessToken: "secret"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireCustomerIOWorkspace(job, tc.sess)
			if err == nil || !strings.Contains(err.Error(), "does not match migration job") {
				t.Fatalf("binding error = %v, want fail-closed mismatch", err)
			}
			for _, secret := range []string{"31415", "27182", customerio.AccountFingerprint(original), "secret"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("binding error leaked %q: %v", secret, err)
				}
			}
		})
	}
	for _, key := range []string{customerIOWorkspaceIDCursorKey, customerIORegionCursorKey} {
		t.Run("tampered job "+key, func(t *testing.T) {
			tampered := *job
			tampered.Cursor = make(map[string]*string, len(job.Cursor))
			for cursorKey, value := range job.Cursor {
				tampered.Cursor[cursorKey] = value
			}
			value := "eu"
			if key == customerIOWorkspaceIDCursorKey {
				value = "27182"
			}
			tampered.Cursor[key] = &value
			err := requireCustomerIOWorkspace(&tampered, original)
			if err == nil || !strings.Contains(err.Error(), "does not match migration job") {
				t.Fatalf("tampered job binding error = %v, want mismatch", err)
			}
		})
	}
}

func TestCustomerIOWorkspaceLeaseContendsAcrossJobsAndTenants(t *testing.T) {
	sess := customerIOBindingTestSession("31415", "us")
	fingerprint := customerio.AccountFingerprint(sess)
	held, err := orchestrator.AcquireCustomerIOWorkspaceExecutionLease(context.Background(), nil, fingerprint)
	if err != nil {
		t.Fatalf("hold Customer.io workspace lease: %v", err)
	}
	defer func() { _ = held.Release() }()

	job := customerIOBindingTestJob("customerio-other-job", canonical.MigCompleted, sess)
	job.TenantID = "tenant_b"
	_, err = NewMigration("").acquireSourceAccountSessionExecution(context.Background(), job, sess)
	if !errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		t.Fatalf("same-workspace lease error = %v, want contention", err)
	}
	if strings.Contains(err.Error(), fingerprint) || strings.Contains(err.Error(), sess.AccountID) {
		t.Fatalf("workspace contention leaked stable identity: %v", err)
	}
}

func TestCustomerIOBindingSurvivesDeltaCursorResetAndRestore(t *testing.T) {
	sess := customerIOBindingTestSession("31415", "eu")
	job := customerIOBindingTestJob("customerio-delta", canonical.MigCompleted, sess)
	wantFingerprint, _ := cursorString(job.Cursor, customerIOWorkspaceCursorKey)
	wantWorkspace, _ := cursorString(job.Cursor, customerIOWorkspaceIDCursorKey)
	wantRegion, _ := cursorString(job.Cursor, customerIORegionCursorKey)
	page := "page-two"
	job.Cursor["subscribers"] = &page

	if err := attachDeltaImportSnapshot(job); err != nil {
		t.Fatalf("attach delta snapshot: %v", err)
	}
	tampered := strings.Repeat("f", sha256.Size*2)
	job.Cursor[customerIOWorkspaceCursorKey] = &tampered
	clearDeltaImportSnapshot(job)
	for key, want := range map[string]string{
		customerIOWorkspaceCursorKey:   wantFingerprint,
		customerIOWorkspaceIDCursorKey: wantWorkspace,
		customerIORegionCursorKey:      wantRegion,
	} {
		if got, ok := cursorString(job.Cursor, key); !ok || got != want {
			t.Fatalf("restored %s = %q/%v, want %q/true", key, got, ok, want)
		}
	}
}

type failCustomerIOSessionStore struct {
	jobstore.MigrationJobStore
}

func (failCustomerIOSessionStore) SaveSession(context.Context, string, string, adapter.Session, time.Time) error {
	return errors.New("injected encrypted-session persistence failure")
}

func TestCreateCustomerIOJobReleasesEmptyLineageWhenSessionPersistenceFails(t *testing.T) {
	memory := jobstore.NewMemoryJobStore()
	failing := failCustomerIOSessionStore{MigrationJobStore: memory}
	h := NewMigration("", failing)
	ctx := jobstore.WithTenantID(context.Background(), "tenant_a")
	sess := customerIOBindingTestSession("31415", "us")

	if _, err := h.createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess); err == nil || !strings.Contains(err.Error(), "save migration session") {
		t.Fatalf("create error = %v, want injected session failure", err)
	}
	jobs, err := memory.List(ctx, "tenant_a")
	if err != nil || len(jobs) != 1 {
		t.Fatalf("failed-create jobs = %d, %v; want one audit row", len(jobs), err)
	}
	if jobs[0].Status != canonical.MigRolledBack {
		t.Fatalf("failed-create job status = %q, want rolled_back", jobs[0].Status)
	}
	if _, err := NewMigration("", memory).createJob(ctx, "tenant_a", canonical.SourceCustomerIO, sess); err != nil {
		t.Fatalf("replacement after pre-execution session failure: %v", err)
	}
}

func customerIOBindingTestSession(workspaceID, region string) adapter.Session {
	region = strings.ToLower(strings.TrimSpace(region))
	digest := sha256.Sum256([]byte("customerio|" + region + "|" + workspaceID))
	fingerprint := hex.EncodeToString(digest[:])
	return adapter.Session{
		AccessToken: "customerio-binding-secret",
		AccountID:   workspaceID,
		Source:      canonical.SourceCustomerIO,
		Extra: map[string]string{
			customerio.WorkspaceIDExtraKey:          workspaceID,
			customerio.WorkspaceFingerprintExtraKey: fingerprint,
			customerio.RegionExtraKey:               region,
		},
	}
}

func cloneCustomerIOStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func customerIOBindingTestJob(id string, status canonical.MigrationStatus, sess adapter.Session) *canonical.MigrationJob {
	now := time.Now().UTC().Add(-time.Hour)
	fingerprint := customerio.AccountFingerprint(sess)
	workspaceID := sess.AccountID
	region := sess.Extra[customerio.RegionExtraKey]
	return &canonical.MigrationJob{
		ID:          id,
		TenantID:    "tenant_a",
		Source:      canonical.SourceCustomerIO,
		Status:      status,
		StartedAt:   now,
		CompletedAt: &now,
		Cursor: map[string]*string{
			customerIOWorkspaceCursorKey:   &fingerprint,
			customerIOWorkspaceIDCursorKey: &workspaceID,
			customerIORegionCursorKey:      &region,
		},
	}
}
