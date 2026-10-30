// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"testing"
	"time"
)

func TestCompareUsesReportReceiptsWithoutDispatchSnapshotDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenant := followupTenant(t, pool, ctx)
	other := followupTenant(t, pool, ctx)
	campaign := followupCampaign(t, pool, ctx, tenant, "imported report", "report")
	foreign := followupCampaign(t, pool, ctx, other, "private report", "private")
	for _, email := range []string{"one@example.test", "two@example.test"} {
		followupEvent(t, pool, ctx, tenant, campaign, email, "sent", 3)
	}
	// A repeat receipt/open must not inflate unique-recipient metrics.
	for _, event := range []string{"sent", "opened", "opened", "clicked", "bounced"} {
		followupEvent(t, pool, ctx, tenant, campaign, "one@example.test", event, 2)
	}
	followupEvent(t, pool, ctx, other, foreign, "private@example.test", "sent", 2)
	for _, band := range []ClassificationFilter{ClassificationAll, ClassificationUnknown, ClassificationHuman, ClassificationMachine} {
		rows, err := NewService(pool).Compare(ctx, tenant, []string{campaign, foreign}, band)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 2 || rows[0].TotalRecipients != 2 || rows[0].BounceRate != 0.5 {
			t.Fatalf("band %q: %+v", band, rows)
		}
		want := 0.5
		if band == ClassificationHuman || band == ClassificationMachine {
			want = 0
		}
		if rows[0].OpenRate != want || rows[0].ClickRate != want {
			t.Fatalf("band %q interaction rates: %+v", band, rows[0])
		}
		if rows[1] != (CompareRow{CampaignID: foreign}) {
			t.Fatalf("foreign facts leaked: %+v", rows[1])
		}
	}
}

func TestCompareKeepsDispatchSnapshotAuthoritativeDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenant := followupTenant(t, pool, ctx)
	campaign := followupCampaign(t, pool, ctx, tenant, "dispatch snapshot", "report")
	followupExec(t, pool, ctx, tenant, `INSERT INTO campaign_recipients
 (tenant_id, campaign_id, subscriber_email, status)
 VALUES ($1::uuid, $2::uuid, 'one@example.test', 'sent'),
 ($1::uuid, $2::uuid, 'two@example.test', 'sent')`, tenant, campaign)
	followupExec(t, pool, ctx, tenant, `INSERT INTO subscriber_events
 (tenant_id, campaign_id, subscriber_email, event_type, at)
 VALUES ($1::uuid, $2::uuid, 'one@example.test', 'opened', now())`, tenant, campaign)
	// Mirrored/extra compatibility receipts must not add a second source of facts.
	for _, email := range []string{"one@example.test", "two@example.test", "extra@example.test"} {
		followupEvent(t, pool, ctx, tenant, campaign, email, "sent", 2)
		followupEvent(t, pool, ctx, tenant, campaign, email, "opened", 1)
	}
	rows, err := NewService(pool).Compare(ctx, tenant, []string{campaign}, ClassificationAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].TotalRecipients != 2 || rows[0].OpenRate != 0.5 {
		t.Fatalf("snapshot was overridden/double-counted: %+v", rows)
	}
}
