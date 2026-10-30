package mailchimpv3

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// POST /api/v1/mailchimp/3.0/campaigns has never once succeeded.
//
// CreateCampaign's INSERT hardcoded `editor_mode = 'template'`, and campaigns
// carries CHECK (editor_mode IN ('blocks','html','plain_text','mjml')) -- placed
// there by migration 0028, the same migration that created the table. So
// 'template' was never a legal value, every call violated the constraint, and
// writeStoreError sanitised the 23514 into a generic 500 while logging nothing.
//
// Two separate silences kept it hidden for its whole life: the constraint
// violation never reached a log, and no test in this package had ever inserted
// a campaign against a real schema. A mock would have accepted 'template'
// happily -- only Postgres knew it was wrong.

func TestCreateCampaignSatisfiesTheEditorModeConstraint(t *testing.T) {
	pool := mcTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	if _, err := pool.Exec(ctx,
		`with g as (select set_config('app.tenant_id', $1, true))
		 insert into tenants (id, name, slug, tier)
		 select $1::uuid, 'mc-create', $2, 'studio' from g
		 on conflict do nothing`,
		tenantID, "mc-create-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	repo := &Repo{Pool: pool}
	out, err := repo.CreateCampaign(ctx, &middleware.Tenant{ID: tenantID}, CampaignInput{
		Type:     "regular",
		Settings: map[string]any{"title": "Launch", "subject_line": "Hello"},
	})
	if err != nil {
		t.Fatalf("creating a Mailchimp-compatible campaign must succeed: %v", err)
	}
	if out == nil || out.ID == "" {
		t.Fatal("expected a campaign back")
	}

	// Assert the stored value against the CONSTRAINT's own allowed set, read
	// from the catalogue rather than restated here. Restating it would let this
	// test keep passing if the constraint changed underneath it -- the exact
	// drift that produced the bug.
	// Read through db.WithTenant rather than a CTE set_config: the GUC has to be
	// established BEFORE the scan applies its RLS predicate, and a CTE gives no
	// such ordering guarantee -- the first version of this test read zero rows
	// for exactly that reason.
	var editorMode string
	rtx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = rtx.Rollback(ctx) }()
	if err := rtx.QueryRow(ctx,
		`select editor_mode from campaigns where id::text = $1`, out.ID).Scan(&editorMode); err != nil {
		t.Fatalf("read back: %v", err)
	}
	var allowed bool
	if err := pool.QueryRow(ctx,
		`select pg_get_constraintdef(oid) like '%' || $1 || '%'
		   from pg_constraint where conname = 'campaigns_editor_mode_check'`,
		"'"+editorMode+"'").Scan(&allowed); err != nil {
		t.Fatalf("inspect constraint: %v", err)
	}
	if !allowed {
		t.Fatalf("stored editor_mode %q is not in the table's CHECK constraint", editorMode)
	}
}
