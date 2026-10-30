// SPDX-License-Identifier: AGPL-3.0-only

package lead_integrations

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A lead webhook must resolve its own integration and nobody else's.
//
// `FindIntegrationByProviderAccountAndCampaign` serves eleven providers —
// convertflow, kickofflabs, landingi, optinmonster, outgrow, poptin, privy,
// riddle, shortstack, sleeknote, wisepops. The caller has no tenant, because a
// webhook arrives from the provider rather than from a logged-in user, so it
// sets app.lead_provider / app.lead_account_id / app.lead_campaign_id.
//
// Nothing read the account or campaign GUCs, and none of those eleven providers
// had a policy of any kind: the query matched the null tenant, resolved
// nothing, and every one of those integrations silently dropped its leads. A
// lead that cannot be attributed is not an error anywhere — it is simply a lead
// that never arrives.
func TestALeadWebhookResolvesOnlyItsOwnIntegration(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping lead webhook RLS test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	mine, theirs := uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, mine)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	seed := func(tenantID, account, campaign, name string) {
		t.Helper()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
			t.Fatalf("scope: %v", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'lead-rls', 'lead-rls-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			t.Fatalf("seed tenant: %v", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO lead_integrations (tenant_id, provider, name, status, settings)
VALUES ($1::uuid, 'poptin', $2, 'connected',
        jsonb_build_object('account_id', $3::text, 'poptin_id', $4::text))`,
			tenantID, name, account, campaign); err != nil {
			t.Fatalf("seed integration: %v", err)
		}
	}
	seed(mine, "acct-mine", "pop-mine", "Mine")
	seed(theirs, "acct-theirs", "pop-theirs", "Theirs")

	webhookScope := func(account, campaign string) {
		t.Helper()
		if _, err := tx.Exec(ctx, `
SELECT set_config('app.tenant_id', '', true),
       set_config('app.lead_provider', 'poptin', true),
       set_config('app.lead_account_id', $1, true),
       set_config('app.lead_campaign_id', $2, true)`, account, campaign); err != nil {
			t.Fatalf("webhook scope: %v", err)
		}
	}
	names := func() []string {
		t.Helper()
		rows, err := tx.Query(ctx, `SELECT name FROM lead_integrations ORDER BY name`)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				t.Fatalf("scan: %v", err)
			}
			out = append(out, n)
		}
		return out
	}

	webhookScope("acct-mine", "pop-mine")
	got := names()
	if len(got) != 1 || got[0] != "Mine" {
		t.Fatalf("the webhook resolved %v, want exactly [Mine]. Eleven providers "+
			"cannot attribute an incoming lead to any integration.", got)
	}
	// The provider alone must not be a key to every tenant's integrations.
	webhookScope("", "")
	if got := names(); len(got) != 0 {
		t.Fatalf("naming only the provider exposed %v; a webhook capability has "+
			"become a cross-tenant read", got)
	}
	// Another tenant's account must not reach this tenant's row.
	webhookScope("acct-theirs", "pop-mine")
	if got := names(); len(got) != 0 {
		t.Fatalf("a mismatched account/campaign pair resolved %v", got)
	}
}
