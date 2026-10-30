package campaigns

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRepoDelete_OnlyDraftCampaigns(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "campaign-delete")
	draftID := insertCampaignWithStatusD(t, pool, ctx, tenantID, StatusDraft)
	sentID := insertCampaignWithStatusD(t, pool, ctx, tenantID, StatusSent)

	if err := repo.Delete(ctx, tenantID, draftID); err != nil {
		t.Fatalf("Delete(draft): %v", err)
	}
	if exists := campaignExistsD(t, pool, ctx, tenantID, draftID); exists {
		t.Fatal("draft campaign still exists after delete")
	}

	err := repo.Delete(ctx, tenantID, sentID)
	if !errors.Is(err, ErrDeleteRequiresDraft) {
		t.Fatalf("Delete(sent) err = %v, want ErrDeleteRequiresDraft", err)
	}
	if exists := campaignExistsD(t, pool, ctx, tenantID, sentID); !exists {
		t.Fatal("sent campaign was deleted despite lifecycle guard")
	}
}

func insertCampaignWithStatusD(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	status string,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html)
VALUES ($1::uuid, $2, 'subject', $3, '<p>hello</p>')
RETURNING id::text`, tenantID, "delete-"+status, status).Scan(&id); err != nil {
		t.Fatalf("insert campaign %s: %v", status, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func campaignExistsD(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	campaignID string,
) bool {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(
  SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2
)`, tenantID, campaignID).Scan(&exists); err != nil {
		t.Fatalf("campaign exists query: %v", err)
	}
	return exists
}
