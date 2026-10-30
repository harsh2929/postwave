package campaigns

// SQL-level test for List(q) substring filter. Skips silently when
// DATABASE_URL is unset (mirrors repo_send_domain_test.go).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestRepoList_QFilter inserts 5 campaigns with mixed name/subject and
// asserts that List(q) filters on either column (case-insensitive).
func TestRepoList_QFilter(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "campaign-qfilter")
	prefix := "qf-" + randHex4QF(t) + "-"
	t.Cleanup(func() { cleanupCampaigns(pool, tenantID, prefix) })

	seeds := []struct{ name, subject string }{
		{prefix + "Alpha launch", "weekly digest"},
		{prefix + "Beta promo", "alpha promo"},
		{prefix + "Gamma test", "weekly digest"},
		{prefix + "Delta release", "monthly recap"},
		{prefix + "Echo update", "monthly recap"},
	}
	for _, s := range seeds {
		if _, err := repo.Create(ctx, tenantID, CreateInput{
			Name: s.name, Subject: s.subject,
			CampaignType:       "regular",
			EditorMode:         "blocks",
			ReusableSectionIDs: []string{}, // NOT NULL on schema
			ContentBlocks:      []map[string]any{},
			Variants:           []map[string]any{},
			TrackingSettings:   map[string]any{},
			DeliverySettings:   map[string]any{},
		}); err != nil {
			t.Fatalf("seed %q: %v", s.name, err)
		}
	}

	got, err := repo.List(ctx, tenantID, "alpha", 0)
	if err != nil {
		t.Fatalf("List q=alpha: %v", err)
	}
	matched := 0
	for _, c := range got {
		if strings.HasPrefix(c.Name, prefix) {
			matched++
		}
	}
	// Two rows: name "Alpha launch" + subject "alpha promo".
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d test rows, want 2", matched)
	}
}

func randHex4QF(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func cleanupCampaigns(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM campaigns WHERE tenant_id = $1::uuid AND name LIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
