package handlers

import (
	"context"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestJobDestinationIsPinnedAcrossResumeReplayAndRollback(t *testing.T) {
	client := listmonkx.NewClientForDestination(tenantengine.Route{TenantID: "tenant-a", DestinationID: "instance-a", BaseURL: "https://a.test"})
	job := &canonical.MigrationJob{TenantID: "tenant-a", Cursor: map[string]*string{}}
	if err := verifyJobDestination(job, client); err == nil {
		t.Fatal("unbound job admitted")
	}
	if err := bindJobDestination(job, client); err != nil {
		t.Fatal(err)
	}
	h := NewMigration("")
	h.SetListmonkClientFactory(func(ctx context.Context) (*listmonkx.Client, error) {
		tenant, ok := jobstore.TenantIDFromContext(ctx)
		if !ok || tenant != job.TenantID {
			t.Fatal("job tenant not propagated")
		}
		return client, nil
	})
	if _, err := h.listmonkClientForJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []*listmonkx.Client{
		listmonkx.NewClientForDestination(tenantengine.Route{TenantID: "tenant-a", DestinationID: "instance-b", BaseURL: "https://b.test"}),
		listmonkx.NewClientForDestination(tenantengine.Route{TenantID: "tenant-b", DestinationID: "instance-a", BaseURL: "https://a.test"}),
		{DedicatedTenant: true, DedicatedTenantID: "tenant-a"},
	} {
		if err := verifyJobDestination(job, replacement); err == nil {
			t.Fatal("destination replacement admitted")
		}
		if err := bindJobDestination(job, replacement); err == nil && replacement.DestinationID != "" {
			t.Fatal("existing pin overwritten")
		}
	}
}
