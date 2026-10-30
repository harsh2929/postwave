// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Every assertion here is about an authority or ordering boundary, and a
// superuser connection bypasses RLS entirely — the suite would pass while
// proving nothing. Fail loudly rather than skip.
func mailboxPool(ctx context.Context, t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping reply IMAP mailbox proof")
	}
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var user string
	var superuser, bypassRLS bool
	if err := pool.QueryRow(ctx, `
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user`).Scan(&user, &superuser, &bypassRLS); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	if superuser || bypassRLS {
		t.Fatalf("connected as %q (superuser=%v bypassrls=%v): this test proves "+
			"nothing unless DATABASE_URL uses the restricted application role",
			user, superuser, bypassRLS)
	}
	return pool
}

func seedMailbox(ctx context.Context, t *testing.T, pool *db.Pool, enabled bool) (tenantID, mailboxID string) {
	t.Helper()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'imap-mailbox', 'imap-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	usernameRef, err := TenantEnvironmentSecretReference(tenantID, "IMAP_USER")
	if err != nil {
		t.Fatalf("username ref: %v", err)
	}
	passwordRef, err := TenantEnvironmentSecretReference(tenantID, "IMAP_PASSWORD")
	if err != nil {
		t.Fatalf("password ref: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO reply_imap_mailboxes (
    tenant_id, label, host, port, folder,
    username_secret_ref, password_secret_ref, enabled)
VALUES ($1::uuid, 'support', 'imap.example.test', 993, 'INBOX', $3, $4, $2)
RETURNING id::text`, tenantID, enabled, usernameRef, passwordRef).Scan(&mailboxID); err != nil {
		t.Fatalf("seed mailbox: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		cleanup, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(bg) }()
		_, _ = cleanup.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(bg)
	})
	return tenantID, mailboxID
}

// The worker discovers mailboxes before it knows whose they are, so it reads
// outside any tenant scope. That authority must come from BOTH GUCs: the outbox
// scope alone is shared by every background worker, and would otherwise let any
// of them read every tenant's mailbox configuration.
func TestMailboxDiscoveryRequiresBothWorkerFlags_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	_, _ = seedMailbox(ctx, t, pool, true)

	store := &MailboxStore{Pool: pool}
	due, err := store.DueMailboxes(ctx, 50)
	if err != nil {
		t.Fatalf("DueMailboxes: %v", err)
	}
	if len(due) == 0 {
		t.Fatal("the worker scope returned no mailboxes; discovery is broken")
	}

	// Only the shared outbox flag: must see nothing.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.outbox_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	var visible int
	if err := tx.QueryRow(ctx,
		`SELECT count(*)::int FROM reply_imap_mailboxes`).Scan(&visible); err != nil {
		t.Fatalf("count under partial scope: %v", err)
	}
	if visible != 0 {
		t.Fatalf("the shared outbox scope alone exposed %d mailbox rows", visible)
	}
}

// A disabled mailbox is one an operator is still configuring. Polling someone's
// live inbox because a row exists is not a mistake worth making.
func TestDisabledMailboxesAreNotPolled_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	_, mailboxID := seedMailbox(ctx, t, pool, false)

	due, err := (&MailboxStore{Pool: pool}).DueMailboxes(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, mailbox := range due {
		if mailbox.ID == mailboxID {
			t.Fatal("a disabled mailbox was returned as due for polling")
		}
	}
}

// The cursor may only move forward within a UIDVALIDITY. Rolling it backward
// re-ingests every message in between as a NEW reply: duplicate customer
// replies, duplicate engagement events, and a lead score that climbs on replay.
func TestCursorCannotRollBackwardWithinAUIDValidity_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	_, mailboxID := seedMailbox(ctx, t, pool, true)
	store := &MailboxStore{Pool: pool}

	if err := store.AdvanceCursor(ctx, mailboxID, 1000, 500, false); err != nil {
		t.Fatalf("first advance: %v", err)
	}
	if err := store.AdvanceCursor(ctx, mailboxID, 1000, 120, false); err == nil {
		t.Fatal("the cursor was rolled backward within a UIDVALIDITY")
	}
	if err := store.AdvanceCursor(ctx, mailboxID, 1000, 900, false); err != nil {
		t.Fatalf("legitimate forward progress was refused: %v", err)
	}
}

// A UIDVALIDITY change means the server renumbered the mailbox, so the old UID
// is meaningless and a LOWER one is correct. It must bump the generation, so a
// reader can tell a reset from ordinary progress without diffing UIDs.
func TestUIDValidityResetMustAdvanceTheGeneration_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	_, mailboxID := seedMailbox(ctx, t, pool, true)
	store := &MailboxStore{Pool: pool}

	if err := store.AdvanceCursor(ctx, mailboxID, 1000, 500, false); err != nil {
		t.Fatal(err)
	}
	// New validity, lower UID, WITHOUT bumping the generation.
	if err := store.AdvanceCursor(ctx, mailboxID, 2000, 7, false); err == nil {
		t.Fatal("a UIDVALIDITY reset was accepted without advancing the generation")
	}
	if err := store.AdvanceCursor(ctx, mailboxID, 2000, 7, true); err != nil {
		t.Fatalf("a correctly-signalled reset was refused: %v", err)
	}
	due, err := store.DueMailboxes(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, mailbox := range due {
		if mailbox.ID != mailboxID {
			continue
		}
		if mailbox.UIDValidity != 2000 || mailbox.LastUID != 7 {
			t.Fatalf("cursor did not adopt the new numbering: %+v", mailbox)
		}
		if mailbox.Generation < 2 {
			t.Fatalf("generation did not advance across the reset: %d", mailbox.Generation)
		}
		return
	}
	t.Fatal("the mailbox disappeared after the reset")
}

// A failed poll must not look like progress: the cursor stays put so the next
// attempt re-reads the same range.
func TestRecordingAFailureLeavesTheCursorUntouched_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	_, mailboxID := seedMailbox(ctx, t, pool, true)
	store := &MailboxStore{Pool: pool}

	if err := store.AdvanceCursor(ctx, mailboxID, 1000, 400, false); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordFailure(ctx, mailboxID, "dial tcp: connection refused"); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	due, err := store.DueMailboxes(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, mailbox := range due {
		if mailbox.ID == mailboxID {
			if mailbox.LastUID != 400 || mailbox.UIDValidity != 1000 {
				t.Fatalf("a failure moved the cursor: %+v", mailbox)
			}
			return
		}
	}
	t.Fatal("the mailbox disappeared after a recorded failure")
}

// The row is a pointer, never the material. A mailbox record in a dump, a log
// line, or an error message must be worth nothing on its own.
func TestMailboxRowsCarryReferencesRatherThanCredentials_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	tenantID, _ := seedMailbox(ctx, t, pool, true)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// A literal password must be refused by the reference CHECK.
	if _, err := tx.Exec(ctx, `
UPDATE reply_imap_mailboxes SET password_secret_ref = 'hunter2'
 WHERE tenant_id = $1::uuid`, tenantID); err == nil {
		t.Fatal("a literal credential was accepted as a secret reference")
	}
}

func TestTenantMailboxAdminLifecycle_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := mailboxPool(ctx, t)
	tenantA, _ := seedMailbox(ctx, t, pool, false)
	tenantB, _ := seedMailbox(ctx, t, pool, false)
	store := &MailboxStore{Pool: pool}

	usernameRef, err := TenantEnvironmentSecretReference(tenantA, "BILLING_USERNAME")
	if err != nil {
		t.Fatal(err)
	}
	passwordRef, err := TenantEnvironmentSecretReference(tenantA, "BILLING_PASSWORD")
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.CreateMailbox(ctx, tenantA, NewMailbox{
		Label:             "Billing",
		Host:              "imap.billing.example.test",
		UsernameSecretRef: usernameRef,
		PasswordSecretRef: passwordRef,
	})
	if err != nil {
		t.Fatalf("CreateMailbox: %v", err)
	}
	if created.Enabled || created.Port != secureIMAPPort || !created.UseTLS || created.Folder != "INBOX" {
		t.Fatalf("creation did not apply disabled/TLS defaults: %+v", created)
	}

	otherRows, err := store.ListMailboxes(ctx, tenantB)
	if err != nil {
		t.Fatalf("ListMailboxes(other tenant): %v", err)
	}
	for _, row := range otherRows {
		if row.ID == created.ID {
			t.Fatal("tenant B listed tenant A's mailbox")
		}
	}
	if _, err := store.SetMailboxEnabled(ctx, tenantB, created.ID, true); !errors.Is(err, ErrMailboxNotFound) {
		t.Fatalf("cross-tenant enable error = %v, want ErrMailboxNotFound", err)
	}
	if err := store.DeleteMailbox(ctx, tenantB, created.ID); !errors.Is(err, ErrMailboxNotFound) {
		t.Fatalf("cross-tenant delete error = %v, want ErrMailboxNotFound", err)
	}

	enabled, err := store.SetMailboxEnabled(ctx, tenantA, created.ID, true)
	if err != nil || !enabled.Enabled {
		t.Fatalf("SetMailboxEnabled(true) = %+v, %v", enabled, err)
	}
	disabled, err := store.SetMailboxEnabled(ctx, tenantA, created.ID, false)
	if err != nil || disabled.Enabled {
		t.Fatalf("SetMailboxEnabled(false) = %+v, %v", disabled, err)
	}
	if err := store.DeleteMailbox(ctx, tenantA, created.ID); err != nil {
		t.Fatalf("DeleteMailbox: %v", err)
	}
	if _, err := store.SetMailboxEnabled(ctx, tenantA, created.ID, true); !errors.Is(err, ErrMailboxNotFound) {
		t.Fatalf("deleted mailbox remained visible: %v", err)
	}
}
