// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

// seedSubscriber inserts one subscriber under the tenant's own RLS scope and
// returns its uuid — the identifier the VERP token must carry.
func seedSubscriber(t *testing.T, pool *db.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'import')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	return id
}

// TestLoadSubscriberIDsResolvesRealSubscriberUUIDs proves the SQL behind the
// identifier the token carries. campaign_recipients stores only
// subscriber_email, so this join is the only thing standing between the send
// path and a token that carries the wrong identity space.
func TestLoadSubscriberIDsResolvesRealSubscriberUUIDs(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")

	known := fmt.Sprintf("known-%d@verp.test", time.Now().UnixNano())
	mixedCase := fmt.Sprintf("Mixed-%d@Verp.Test", time.Now().UnixNano())
	knownID := seedSubscriber(t, pool, tenantID, known)
	mixedID := seedSubscriber(t, pool, tenantID, mixedCase)
	stranger := fmt.Sprintf("stranger-%d@verp.test", time.Now().UnixNano())

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	guard := &Guard{Pool: pool}
	got := guard.loadSubscriberIDs(ctx, tx, []string{known, strings.ToUpper(mixedCase), stranger})

	if got[strings.ToLower(known)] != knownID {
		t.Fatalf("known address resolved to %q, want %q", got[strings.ToLower(known)], knownID)
	}
	// Addresses are citext and the queue stores whatever case the import had;
	// the map must be keyed and matched case-insensitively or the send path
	// silently drops the subscriber id for half the list.
	if got[strings.ToLower(mixedCase)] != mixedID {
		t.Fatalf("mixed-case address resolved to %q, want %q",
			got[strings.ToLower(mixedCase)], mixedID)
	}
	// An address with no subscriber row must produce NO entry, not an empty
	// string that later reads as "resolved to nothing".
	if _, present := got[strings.ToLower(stranger)]; present {
		t.Fatalf("stranger address produced an entry: %q", got[strings.ToLower(stranger)])
	}
	if len(got) != 2 {
		t.Fatalf("map = %v, want exactly the two seeded addresses", got)
	}
	// An empty batch must not query at all, and must not return nil.
	if empty := guard.loadSubscriberIDs(ctx, tx, nil); empty == nil || len(empty) != 0 {
		t.Fatalf("empty batch returned %v", empty)
	}
}

// seedRecipient inserts one pending recipient for an existing campaign and
// returns its id.
//
// It is deliberately an UNBOUND row. Seeding an assurance-bound one is not
// possible from here: campaign_recipients_assurance_run_fk points at
// campaign_assurance_runs, whose guard trigger refuses any insert that is not
// a fresh unfrozen `queued` row and only reaches a frozen, attempted run
// through worker-scoped transitions that first require matching
// campaign_assurance_run_{artifacts,configurations,targets} manifests. That
// fixture belongs to the assurance packages. The unbound row still exercises
// everything this test is about — claim, subscriber-id resolution, batch
// attachment, mint — and reaches a reply address the send loop actually emits.
func seedRecipient(t *testing.T, pool *db.Pool, tenantID, campaignID, email string) int64 {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_recipients (campaign_id, tenant_id, subscriber_email, status)
VALUES ($1::uuid, $2::uuid, $3, 'pending')
RETURNING id`, campaignID, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed recipient: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recipient: %v", err)
	}
	return id
}

// TestRunOnceLegacyPathNeverMintsUnledgeredVERP proves that merely configuring
// the legacy guard cannot mint a reply identity. Signed reply correlation now
// belongs to the qualified assurance runtime, where its configuration and
// delivery evidence are ledgered together. The adjacent subscriber-ID test
// still pins the database join used to hand that runtime its canonical UUID.
func TestRunOnceLegacyPathNeverMintsUnledgeredVERP(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 0, nil, "", "", "")

	email := fmt.Sprintf("recipient-%d@verp.test", time.Now().UnixNano())
	seedSubscriber(t, pool, tenantID, email)
	recipientID := seedRecipient(t, pool, tenantID, campaignID, email)

	sender := &mockListmonk{}
	guard := &Guard{
		Pool:         pool,
		Listmonk:     sender,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		VERPSecret:   verpSecretFixture,
		VERPDomain:   "reply.example.test",
		BatchSize:    10,
	}

	attempted, err := guard.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if attempted != 1 {
		t.Fatalf("RunOnce attempted %d, want 1", attempted)
	}
	if sender.count() != 1 {
		t.Fatalf("provider sends = %d, want 1", sender.count())
	}

	if replyTo := sender.replyToHeader(); replyTo != "" {
		t.Fatalf("legacy send minted an unledgered Reply-To identity: %q", replyTo)
	}
	if status := recipientStatus(t, pool, tenantID, recipientID); status != RecipientSent {
		t.Fatalf("recipient status = %q, want %q", status, RecipientSent)
	}
}

// TestRunOnceLeavesReplyToAloneWhenVERPUnconfigured is proof (c) at the top of
// the real send loop: with no VERP identity configured, the subscriber-id
// query is not issued and the outgoing mail carries no VERP-shaped address.
func TestRunOnceLeavesReplyToAloneWhenVERPUnconfigured(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 0, nil, "", "", "")

	email := fmt.Sprintf("unconfigured-%d@verp.test", time.Now().UnixNano())
	seedSubscriber(t, pool, tenantID, email)
	seedRecipient(t, pool, tenantID, campaignID, email)

	sender := &mockListmonk{}
	guard := &Guard{
		Pool:         pool,
		Listmonk:     sender,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	if _, err := guard.RunOnce(context.Background(), tenantID); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if sender.count() != 1 {
		t.Fatalf("provider sends = %d, want 1", sender.count())
	}
	if got := sender.replyToHeader(); strings.Contains(got, replies.VERPTokenPrefix) {
		t.Fatalf("Reply-To = %q, want no VERP address", got)
	}
}

// replyToHeader reads the Reply-To the last send carried, case-insensitively
// so a differently-spelled header name cannot make the assertion vacuous.
func (m *mockListmonk) replyToHeader() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, value := range m.lastHeaders {
		if strings.EqualFold(strings.TrimSpace(name), "Reply-To") {
			return value
		}
	}
	return ""
}

func recipientStatus(t *testing.T, pool *db.Pool, tenantID string, recipientID int64) string {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM campaign_recipients WHERE id = $1`, recipientID).Scan(&status); err != nil {
		t.Fatalf("recipient status: %v", err)
	}
	return status
}
