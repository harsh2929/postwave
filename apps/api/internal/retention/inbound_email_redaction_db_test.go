// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Inbound email bodies must be redacted on schedule, and only the bodies.
//
// `sweepInboundEmailBodies` does not delete these rows — it keeps the envelope
// and clears the content. `postwave_app` had no UPDATE on the table, so every
// sweep raised "permission denied" and message text and HTML were retained past
// the window. The difference is between keeping the fact that a message arrived
// and keeping the message.
//
// Migration 1912 grants UPDATE on exactly (body_text, body_html) — the pattern
// audit_log already uses — so redaction works while the envelope stays
// unwritable.
func TestInboundEmailBodiesAreRedactedAndTheEnvelopeIsNot(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping inbound email redaction test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'inbound-redact', 'inbound-redact-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO inbound_emails (tenant_id, from_email, to_email, body_text, body_html, received_at)
VALUES ($1::uuid, 'sender@example.test', 'inbox@example.test',
        'secret body', '<p>secret body</p>', now() - interval '400 days')`,
		tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed inbound email: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		cx, cerr := db.WithTenant(bg, pool, tenantID)
		if cerr != nil {
			return
		}
		defer func() { _ = cx.Rollback(bg) }()
		_, _ = cx.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cx.Commit(bg)
	})

	sweeper := &Sweeper{Pool: pool}
	redacted, err := sweeper.sweepInboundEmailBodies(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("sweepInboundEmailBodies: %v. Message text and HTML are retained "+
			"past the window the product promises.", err)
	}
	if redacted != 1 {
		t.Fatalf("the sweep redacted %d email(s), want 1", redacted)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(read): %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var body, from string
	if err := read.QueryRow(ctx,
		`SELECT COALESCE(body_text,''), from_email FROM inbound_emails WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&body, &from); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if body != "" {
		t.Fatalf("body survived redaction: %q", body)
	}
	// The envelope is evidence about what arrived and must remain.
	if from != "sender@example.test" {
		t.Fatalf("the envelope was altered: from_email = %q", from)
	}
	// And it must not be writable by an ordinary request.
	if _, err := read.Exec(ctx,
		`UPDATE inbound_emails SET from_email = 'attacker@example.test' WHERE tenant_id = $1::uuid`,
		tenantID); err == nil {
		t.Fatal("an ordinary request rewrote an inbound email's sender. The grant " +
			"added for redaction has become a way to forge what arrived.")
	}
}
