package campaigns

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestRepoListPage_StableTieBreak proves adjacent offset pages cannot change
// order merely because multiple campaigns share the same updated_at value.
// It skips through dbForIntegration when DATABASE_URL is unavailable.
func TestRepoListPage_StableTieBreak(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "campaign-page-order")
	prefix := "page-order-" + randHex4QF(t) + "-"
	t.Cleanup(func() { cleanupCampaigns(pool, tenantID, prefix) })

	want := make([]string, 0, 4)
	for index := 0; index < 4; index++ {
		created, err := repo.Create(ctx, tenantID, CreateInput{
			Name:                 prefix + string(rune('a'+index)),
			Subject:              "Stable page ordering",
			CampaignType:         "regular",
			EditorMode:           "blocks",
			ReusableSectionIDs:   []string{},
			ContentBlocks:        []map[string]any{},
			Variants:             []map[string]any{},
			TrackingSettings:     map[string]any{},
			DeliverySettings:     map[string]any{},
			TemplateVariables:    map[string]any{},
			ReferenceTemplateIDs: []string{},
		})
		if err != nil {
			t.Fatalf("seed campaign %d: %v", index, err)
		}
		want = append(want, created.ID)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sharedUpdatedAt := time.Date(2026, time.July, 20, 12, 0, 0, 0, time.UTC)
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET updated_at = $3
 WHERE tenant_id = $1::uuid
   AND name LIKE $2`, tenantID, prefix+"%", sharedUpdatedAt); err != nil {
		t.Fatalf("align updated_at values: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit aligned timestamps: %v", err)
	}

	first, err := repo.ListPage(ctx, tenantID, prefix, 2, 0)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	second, err := repo.ListPage(ctx, tenantID, prefix, 2, 2)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("page lengths = %d and %d, want 2 and 2", len(first), len(second))
	}

	sort.Sort(sort.Reverse(sort.StringSlice(want)))
	got := []string{first[0].ID, first[1].ID, second[0].ID, second[1].ID}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("combined page order = %v, want %v", got, want)
		}
	}
}
