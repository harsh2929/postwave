package handlers

import (
	"context"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestBrevoJobsRequireStableOrganizationAcrossReconnect(t *testing.T) {
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	ctx := jobstore.WithTenantID(context.Background(), "tenant-a")
	sess := adapter.Session{Source: canonical.SourceBrevo, AccountID: "org-a", AccessToken: "key", Extra: map[string]string{"brevo_organization_id": "org-a"}}
	id, err := h.createJob(ctx, "tenant-a", canonical.SourceBrevo, sess)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireBoundSourceAccount(job, sess); err != nil {
		t.Fatal(err)
	}
	sess.AccessToken = "rotated"
	if err := requireBoundSourceAccount(job, sess); err != nil {
		t.Fatal(err)
	}
	sess.AccountID = "org-b"
	sess.Extra["brevo_organization_id"] = "org-b"
	if err := requireBoundSourceAccount(job, sess); err == nil {
		t.Fatal("cross-organization reconnect admitted")
	}
	legacy := adapter.Session{Source: canonical.SourceBrevo, AccountID: "Company display name", AccessToken: "key"}
	if _, err := h.createJob(ctx, "tenant-a", canonical.SourceBrevo, legacy); err == nil {
		t.Fatal("display name accepted as source identity")
	}
}
