package reportstore

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

func TestMemoryStoreWritesAndAggregatesReports(t *testing.T) {
	store := NewMemoryStore("local")
	now := time.Date(2026, 5, 6, 10, 0, 0, 0, time.UTC)
	rows := []domain.InboxReport{
		{CampaignID: "cmp_1", Provider: domain.ProviderGmail, MailboxID: "gmail-1", Placement: domain.PlacementPromotions, CheckedAt: now},
		{CampaignID: "cmp_1", Provider: domain.ProviderGmail, MailboxID: "gmail-1", Placement: domain.PlacementPrimary, CheckedAt: now.Add(time.Minute)},
		{CampaignID: "cmp_1", Provider: domain.ProviderICloud, MailboxID: "icloud-1", Placement: domain.PlacementSpam, CheckedAt: now},
	}
	for _, row := range rows {
		if err := store.WriteReport(context.Background(), row); err != nil {
			t.Fatalf("WriteReport: %v", err)
		}
	}

	got, err := store.Get(context.Background(), "", "cmp_1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.TotalInboxes != 2 {
		t.Fatalf("TotalInboxes=%d want 2", got.TotalInboxes)
	}
	if got.Overall[domain.PlacementPrimary] != 0.5 || got.Overall[domain.PlacementSpam] != 0.5 {
		t.Fatalf("overall=%+v want primary/spam split", got.Overall)
	}
	if got.Providers[0].Provider != domain.ProviderGmail || got.Providers[0].Placements[domain.PlacementPrimary] != 1 {
		t.Fatalf("gmail breakdown not using latest mailbox row: %+v", got.Providers)
	}
}

func TestMemoryStoreMissingCampaign(t *testing.T) {
	store := NewMemoryStore("local")
	if _, err := store.Get(context.Background(), "", "missing"); err != ErrNotFound {
		t.Fatalf("err=%v want ErrNotFound", err)
	}
}
