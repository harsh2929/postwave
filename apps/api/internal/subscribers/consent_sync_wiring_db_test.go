// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// An unsubscribe must reach the places the data went.
//
// `ConsentSyncLedger` is complete — writer, retry sweep, idempotency, migration
// 0563 — and guarded at SEVEN call sites by `if ... ConsentSyncLedger != nil`.
// It is assigned in no composition path, so every one of those guards is
// permanently false. A subscriber unsubscribes, the local row updates, and
// nothing propagates to the connected destinations their data was pushed to.
//
// That is the question a data-protection officer asks — "you were told to stop;
// who else has this record and were they told?" — and the answer today is a
// silent no, with the code to answer it already written.
//
// This test asserts the wiring, because the ledger's own tests exercise the
// ledger and cannot see that nothing calls it.

func newConsentSyncPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestTheWebhookRegistryResolvesConsentSyncDestinations(t *testing.T) {
	pool := newConsentSyncPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'consent sync', 'studio')`,
		tenantID, "csync-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	type hook struct {
		url    string
		events []string
		active bool
		want   bool
		why    string
	}
	for _, h := range []hook{
		{"https://crm.example.test/hook", []string{"subscriber.unsubscribed"}, true, true,
			"subscribed to the event and active"},
		{"https://silent.example.test/hook", []string{"campaign.sent"}, true, false,
			"active but not subscribed to consent changes"},
		{"https://off.example.test/hook", []string{"subscriber.unsubscribed"}, false, false,
			"subscribed but disabled — a disabled destination is not a destination"},
	} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO outbound_webhooks (tenant_id, url, events, active, secret_envelope)
			VALUES ($1::uuid, $2, $3, $4, '\x00'::bytea)`, tenantID, h.url, h.events, h.active); err != nil {
			t.Fatalf("seed webhook %s: %v", h.url, err)
		}
	}

	lister := ConsentSyncWebhookDestinations{}
	got, err := lister.ListConsentSyncDestinations(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	byURL := map[string]bool{}
	for _, d := range got {
		byURL[d.URL] = true
		if d.ID == "" {
			t.Error("a destination with no id cannot be recorded against a ledger row")
		}
	}
	if !byURL["https://crm.example.test/hook"] {
		t.Error("an active webhook subscribed to subscriber.unsubscribed was not " +
			"returned, so an unsubscribe would never reach it")
	}
	if byURL["https://silent.example.test/hook"] {
		t.Error("a webhook that never asked for consent events was returned; " +
			"pushing to it would be an unrequested disclosure of a consent change")
	}
	if byURL["https://off.example.test/hook"] {
		t.Error("a disabled webhook was returned as a live destination")
	}
}

func TestARecordedUnsubscribeProducesOneLedgerRowPerDestination(t *testing.T) {
	pool := newConsentSyncPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'consent sync', 'studio')`,
		tenantID, "csync2-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	var subID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api') RETURNING id::text`,
		tenantID, "csync-"+tenantID[:8]+"@example.test").Scan(&subID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	for _, u := range []string{"https://a.example.test/h", "https://b.example.test/h"} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO outbound_webhooks (tenant_id, url, events, active, secret_envelope)
			VALUES ($1::uuid, $2, ARRAY['subscriber.unsubscribed'], true, '\x00'::bytea)`, tenantID, u); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed webhook: %v", err)
		}
	}

	ledger := &ConsentSyncLedger{Pool: pool, Destinations: ConsentSyncWebhookDestinations{}}
	if err := ledger.RecordEvent(ctx, tx, tenantID, subID, "unsubscribe"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("record: %v", err)
	}

	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM consent_sync_ledger
		 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subID).Scan(&n); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("count: %v", err)
	}
	_ = tx.Rollback(ctx)

	if n != 2 {
		t.Fatalf("recorded %d ledger row(s) for 2 subscribed destinations. Every "+
			"place the record was pushed to needs its own row, or the answer to "+
			"\"were they told?\" is partial.", n)
	}
}

var _ ConsentSyncDestinationLister = ConsentSyncWebhookDestinations{}
var _ pgx.Tx = nil

func TestOnlyWebhooksThatAskedForConsentEventsBecomeDestinations(t *testing.T) {
	// Stated separately from the resolver test because it is a disclosure rule,
	// not a filtering detail: pushing a consent change to an endpoint that never
	// requested one would itself be an unrequested disclosure of what a person
	// decided about their data.
	pool := newConsentSyncPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'consent sync', 'studio')`,
		tenantID, "csync3-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbound_webhooks (tenant_id, url, events, active, secret_envelope)
		VALUES ($1::uuid, 'https://analytics.example.test/h',
		        ARRAY['campaign.sent','subscriber.created'], true, '\x00'::bytea)`,
		tenantID); err != nil {
		t.Fatalf("seed webhook: %v", err)
	}

	got, err := ConsentSyncWebhookDestinations{}.ListConsentSyncDestinations(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a webhook subscribed only to campaign.sent and subscriber.created "+
			"was returned as a consent destination (%d). Telling it about an "+
			"unsubscribe discloses a consent decision it never asked for.", len(got))
	}
}
