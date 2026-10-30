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

func TestCampaignReplyBodyRedactionPreservesImmutableEvidence_DB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping campaign reply redaction test")
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
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'campaign-reply-redact', 'reply-redact-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var replyID, bodyHash, receiptHash string
	if err := seed.QueryRow(ctx, `
INSERT INTO campaign_replies (
    tenant_id, recipient_email, subject, body_snippet, body_stripped,
    raw_message_id, source, classification, classified_at, received_at,
    metadata
)
VALUES (
    $1::uuid, 'reader@example.test', 'Re: launch', 'private reply',
    'private reply without quoted history', '<reply-redact@example.test>',
    'postmark', 'human_reply', now() - interval '400 days',
    now() - interval '400 days',
    '{"classification_receipt":{"version":"reply-header-v1"}}'::jsonb
)
RETURNING id::text, body_evidence_sha256, evidence_receipt_sha256`, tenantID).
		Scan(&replyID, &bodyHash, &receiptHash); err != nil {
		t.Fatalf("seed campaign reply: %v", err)
	}
	if len(bodyHash) != 64 || len(receiptHash) != 64 {
		t.Fatalf("reply evidence hashes were not generated: body=%q receipt=%q", bodyHash, receiptHash)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		cleanup, cleanupErr := db.WithTenant(bg, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(bg) }()
		_, _ = cleanup.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(bg)
	})

	sweeper := &Sweeper{Pool: pool}
	redacted, err := sweeper.sweepInboundEmailBodies(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("sweepInboundEmailBodies: %v", err)
	}
	if redacted != 1 {
		t.Fatalf("redacted rows = %d, want 1 campaign reply", redacted)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(read): %v", err)
	}
	var snippet, stripped, gotBodyHash, gotReceiptHash string
	var redactedAt *time.Time
	if err := read.QueryRow(ctx, `
SELECT COALESCE(body_snippet, ''), COALESCE(body_stripped, ''),
       body_evidence_sha256, evidence_receipt_sha256, body_redacted_at
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, replyID).
		Scan(&snippet, &stripped, &gotBodyHash, &gotReceiptHash, &redactedAt); err != nil {
		_ = read.Rollback(ctx)
		t.Fatalf("read redacted reply: %v", err)
	}
	if snippet != "" || stripped != "" || redactedAt == nil {
		_ = read.Rollback(ctx)
		t.Fatalf("reply body was not irreversibly redacted: snippet=%q stripped=%q at=%v", snippet, stripped, redactedAt)
	}
	if gotBodyHash != bodyHash || gotReceiptHash != receiptHash {
		_ = read.Rollback(ctx)
		t.Fatalf("redaction rewrote evidence hashes: body=%q receipt=%q", gotBodyHash, gotReceiptHash)
	}
	if err := read.Commit(ctx); err != nil {
		t.Fatalf("commit read: %v", err)
	}

	// Ordinary tenant code cannot restore content or rewrite envelope evidence.
	for _, statement := range []string{
		`UPDATE campaign_replies SET body_snippet = 'restored' WHERE id = $2::uuid AND tenant_id = $1::uuid`,
		`UPDATE campaign_replies SET subject = 'forged' WHERE id = $2::uuid AND tenant_id = $1::uuid`,
		`DELETE FROM campaign_replies WHERE id = $2::uuid AND tenant_id = $1::uuid`,
	} {
		attempt, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant(tamper): %v", err)
		}
		_, execErr := attempt.Exec(ctx, statement, tenantID, replyID)
		_ = attempt.Rollback(ctx)
		if execErr == nil {
			t.Fatalf("ordinary tenant mutation unexpectedly succeeded: %s", statement)
		}
	}
}
