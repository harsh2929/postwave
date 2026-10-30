// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	cryptorand "crypto/rand"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Every assertion below is about an authority boundary, and a superuser
// connection bypasses RLS and column-level GRANTs entirely — the suite would
// pass while proving nothing. Fail loudly rather than skip: a silent skip is
// how a vacuous security test survives review.
func requireRestrictedRole(ctx context.Context, t *testing.T, pool *db.Pool) {
	t.Helper()
	var user string
	var superuser, bypassRLS bool
	if err := pool.QueryRow(ctx, `
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user`).Scan(&user, &superuser, &bypassRLS); err != nil {
		t.Fatalf("inspect connection role: %v", err)
	}
	if superuser || bypassRLS {
		t.Fatalf("connected as %q (superuser=%v bypassrls=%v): this test proves nothing "+
			"unless DATABASE_URL uses the restricted application role", user, superuser, bypassRLS)
	}
}

func seedErasableReply(ctx context.Context, t *testing.T, pool *db.Pool, tenantID string) (replyID, bodyHash, receiptHash string) {
	t.Helper()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(seed): %v", err)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'reply-identity-erasure', 'reply-erase-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seed.QueryRow(ctx, `
INSERT INTO campaign_replies (
    tenant_id, recipient_email, subject, body_snippet, body_stripped,
    raw_message_id, source, classification, classified_at, received_at, metadata
)
VALUES (
    $1::uuid, 'reader@example.test', 'Re: launch', 'private reply',
    'private reply without quoted history', '<reply-erase@example.test>',
    'postmark', 'human_reply', now(), now(),
    '{"classification_receipt":{"version":"reply-header-v1"}}'::jsonb
)
RETURNING id::text, body_evidence_sha256, evidence_receipt_sha256`, tenantID).
		Scan(&replyID, &bodyHash, &receiptHash); err != nil {
		t.Fatalf("seed campaign reply: %v", err)
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
	return replyID, bodyHash, receiptHash
}

func erasurePool(ctx context.Context, t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping campaign reply identity erasure test")
	}
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	requireRestrictedRole(ctx, t, pool)
	return pool
}

// The point of the whole design: the identity goes, the receipt stays. A
// rewritten receipt would be indistinguishable from a forged one, so erasure
// must not recompute it.
func TestCampaignReplyIdentityErasurePreservesTheIngestReceipt_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID := uuid.NewString()
	replyID, bodyHash, receiptHash := seedErasableReply(ctx, t, pool, tenantID)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(erase): %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_replies
   SET recipient_email = 'erased+abc123@erased.invalid',
       subject = NULL,
       identity_redacted_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, replyID); err != nil {
		t.Fatalf("governed identity erasure was rejected: %v", err)
	}
	var email, subject, gotBody, gotReceipt string
	var redactedAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT recipient_email::text, COALESCE(subject, ''),
       body_evidence_sha256, evidence_receipt_sha256, identity_redacted_at
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, replyID).
		Scan(&email, &subject, &gotBody, &gotReceipt, &redactedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.HasSuffix(email, "@erased.invalid") || subject != "" {
		t.Fatalf("identity survived erasure: email=%q subject=%q", email, subject)
	}
	if redactedAt == nil {
		t.Fatal("identity_redacted_at was not stamped")
	}
	if gotBody != bodyHash || gotReceipt != receiptHash {
		t.Fatalf("erasure rewrote the ingest receipt: body %q->%q receipt %q->%q",
			bodyHash, gotBody, receiptHash, gotReceipt)
	}
}

// "Erasure" must not be usable as cover for rewriting the envelope to a
// different real address, which would let a caller launder one subject's reply
// into another identity while the row still reads as evidence.
func TestCampaignReplyIdentityErasureRefusesRewriteToRealAddress_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID := uuid.NewString()
	replyID, _, _ := seedErasableReply(ctx, t, pool, tenantID)

	for name, statement := range map[string]string{
		"rewrite to another real address": `
UPDATE campaign_replies SET recipient_email = 'someone.else@example.test',
       subject = NULL, identity_redacted_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		"drop the subject without erasing the envelope": `
UPDATE campaign_replies SET subject = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		"stamp the marker without removing the identity": `
UPDATE campaign_replies SET identity_redacted_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
	} {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("%s: WithTenant: %v", name, err)
		}
		_, execErr := tx.Exec(ctx, statement, tenantID, replyID)
		_ = tx.Rollback(ctx)
		if execErr == nil {
			t.Fatalf("%s: was accepted but must be refused", name)
		}
	}
}

// Erasure is one-way. Reverting the marker would let a tenant un-erase a
// subject's identity, which is the whole thing the transition exists to prevent.
func TestCampaignReplyIdentityErasureIsOneWay_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID := uuid.NewString()
	replyID, _, _ := seedErasableReply(ctx, t, pool, tenantID)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_replies
   SET recipient_email = 'erased+abc123@erased.invalid', subject = NULL,
       identity_redacted_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, replyID); err != nil {
		t.Fatalf("first erasure rejected: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_replies SET identity_redacted_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, replyID); err == nil {
		t.Fatal("clearing identity_redacted_at was accepted: erasure is reversible")
	}
}

// The migration is inert unless the erasure path actually calls it. Before
// this wiring, a data subject who exercised their right to erasure kept their
// reply address and subject line while every other table holding the same
// identity was placeholdered.
func TestEraseSubscriberDataErasesCampaignReplyIdentity_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)
	tenantID := uuid.NewString()
	replyID, _, receiptHash := seedErasableReply(ctx, t, pool, tenantID)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Deliberately the ungated inner function. eraseSubscriberData still refuses
	// with ErrErasureCoverageIncomplete because retained SMS proof, Mailchimp
	// reporting and raw commerce payloads have no approved retention policy yet;
	// campaign_replies was one member of that same uncovered set, and this test
	// proves its coverage without pretending the whole inventory has landed.
	stats, err := eraseSubscriberDataWithEntropy(ctx, tx, tenantID, "reader@example.test", cryptorand.Reader)
	if err != nil {
		t.Fatalf("eraseSubscriberData: %v", err)
	}
	if stats.CampaignRepliesAnonymized != 1 {
		t.Fatalf("campaign replies erased = %d, want 1", stats.CampaignRepliesAnonymized)
	}
	var email, subject, gotReceipt string
	if err := tx.QueryRow(ctx, `
SELECT recipient_email::text, COALESCE(subject, ''), evidence_receipt_sha256
  FROM campaign_replies WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, replyID).Scan(&email, &subject, &gotReceipt); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.HasSuffix(email, "@erased.invalid") || subject != "" {
		t.Fatalf("reply identity survived the erasure request: email=%q subject=%q", email, subject)
	}
	if gotReceipt != receiptHash {
		t.Fatal("erasure rewrote the ingest receipt")
	}
	// Re-running an erasure must not fail or double-count: privacy requests get
	// retried, and the guard rejects a second transition on an erased row.
	again, err := eraseSubscriberDataWithEntropy(ctx, tx, tenantID, "reader@example.test", cryptorand.Reader)
	if err != nil {
		t.Fatalf("repeat erasure failed: %v", err)
	}
	if again.CampaignRepliesAnonymized != 0 {
		t.Fatalf("repeat erasure re-counted %d rows", again.CampaignRepliesAnonymized)
	}
}

// The table-wide UPDATE grant stays revoked; only the three erasure columns
// were added. Without this, a future migration could restore blanket authority
// and every guard above would still pass.
func TestCampaignRepliesRetainsNoTableWideUpdateGrant_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := erasurePool(ctx, t)

	var tableWide bool
	if err := pool.QueryRow(ctx, `
SELECT has_table_privilege(current_user, 'campaign_replies', 'UPDATE')
   AND NOT EXISTS (
       SELECT 1 FROM information_schema.column_privileges
        WHERE table_name = 'campaign_replies' AND privilege_type = 'UPDATE'
          AND grantee = current_user
   )`).Scan(&tableWide); err != nil {
		t.Fatalf("inspect grants: %v", err)
	}
	if tableWide {
		t.Fatal("campaign_replies carries a table-wide UPDATE grant")
	}
	for _, column := range []string{"recipient_email", "subject", "identity_redacted_at"} {
		var granted bool
		if err := pool.QueryRow(ctx,
			`SELECT has_column_privilege(current_user, 'campaign_replies', $1, 'UPDATE')`,
			column).Scan(&granted); err != nil {
			t.Fatalf("inspect column grant %s: %v", column, err)
		}
		if !granted {
			t.Fatalf("erasure cannot write %s: the migration's GRANT is missing", column)
		}
	}
}
