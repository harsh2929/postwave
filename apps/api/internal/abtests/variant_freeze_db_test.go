// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// campaign_variants IS delivered content.
//
// sendloop.loadCampaignBodies joins campaign_variants inside every batch
// transaction and prefers v.subject / v.body_html / v.from_name / v.from_email
// over the campaign's own columns. Freezing only the campaigns row therefore
// left this table — the one that decides what an A/B recipient actually
// receives — completely open.
//
// CreateVariants also DELETEs the arms the client omitted. On a mid-send
// campaign that strands every pending recipient already assigned to the deleted
// arm: sendloop looks up campaignBodyKey(cid, vid), misses, and marks them
// "failed" with "campaign body missing". They are never sent, and no retry
// recovers them.

func variantTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping variant freeze test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedVariantCampaign(t *testing.T, pool *db.Pool, ctx context.Context, status string, started bool) (tenantID, campaignID string) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	slug := "variant-freeze-" + tenantID[:8]
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, started_at)
VALUES ($1::uuid, 'ab', 'subject', $2, '<p>hi</p>',
        CASE WHEN $3::bool THEN now() - interval '10 minutes' ELSE NULL END)
RETURNING id::text`, tenantID, status, started).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM campaign_variants WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM campaigns WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, campaignID
}

func TestVariantsAreFrozenOnceTheCampaignHasDispatched(t *testing.T) {
	pool := variantTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	for _, tc := range []struct{ name, status string }{
		{"sending", "sending"},
		{"paused mid-send", "paused"},
		{"sent", "sent"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID, campaignID := seedVariantCampaign(t, pool, ctx, tc.status, true)
			_, err := repo.CreateVariants(ctx, tenantID, campaignID, []Variant{
				{VariantLabel: "A", Subject: "Rewritten mid-flight", Weight: 50},
				{VariantLabel: "B", Subject: "Also rewritten", Weight: 50},
			})
			if !errors.Is(err, campaigndispatch.ErrContentFrozen) {
				t.Fatalf("err = %v, want ErrContentFrozen — the send loop reads "+
					"campaign_variants per batch, so this rewrites what later "+
					"batches deliver", err)
			}
			var n int
			tx, terr := db.WithTenant(ctx, pool, tenantID)
			if terr != nil {
				t.Fatal(terr)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if err := tx.QueryRow(ctx, `
SELECT count(*)::int FROM campaign_variants WHERE campaign_id = $1::uuid`, campaignID).Scan(&n); err != nil {
				t.Fatalf("count variants: %v", err)
			}
			if n != 0 {
				t.Fatalf("%d variant rows were written despite the refusal", n)
			}
		})
	}
}

func TestVariantsAreStillEditableBeforeDispatch(t *testing.T) {
	pool := variantTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	tenantID, campaignID := seedVariantCampaign(t, pool, ctx, "draft", false)

	out, err := repo.CreateVariants(ctx, tenantID, campaignID, []Variant{
		{VariantLabel: "A", Subject: "Arm A", Weight: 50},
		{VariantLabel: "B", Subject: "Arm B", Weight: 50},
	})
	if err != nil {
		t.Fatalf("authoring variants on a draft was refused: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d variants, want 2", len(out))
	}
}
