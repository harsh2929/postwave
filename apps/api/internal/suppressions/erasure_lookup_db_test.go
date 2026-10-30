// SPDX-License-Identifier: AGPL-3.0-only

package suppressions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

// TestErasedAddressesRecognisesEveryWritersTombstone seeds each store in the
// exact shape its production writer leaves behind and asks one batch question,
// as an import does. Only erasure evidence may block an address; an ordinary
// suppression, or another tenant's erasure of the same address, must not.
func TestErasedAddressesRecognisesEveryWritersTombstone(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	otherTenantID := newSuppressionTestTenant(t, ctx, pool)
	suffix := randHex4(t)
	address := func(label string) string { return "erasure-" + label + "-" + suffix + "@example.com" }

	subscriberDelete := address("subscriber-delete")     // subscribers.Repo.Delete / bulk delete
	canonicalPlaintext := address("canonical-plaintext") // subscriber_suppressions keyed by address
	privacyWorker := address("privacy-worker")           // privacy erasure: hash-only tombstones
	legacyHashOnly := address("legacy-hash")             // oldest store, hash-only
	receiptOnly := address("receipt")                    // erasure_receipts proof row
	malformedMetadata := address("malformed-metadata")   // fails closed like RemoveLegacyByID
	nullMetadata := address("null-metadata")             // JSON null fails closed too
	sourceOnly := address("source-only")                 // only the source says erasure
	identityOnly := address("identity-only")             // only an erasure identity marker
	bounced := address("bounced")                        // ordinary suppression
	otherTenantErased := address("other-tenant")         // erased, but in another tenant
	neverSeen := address("never-seen")

	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		for _, seed := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'manual', 'gdpr_delete', '{"gdpr_erasure":true}'::jsonb)`,
				[]any{tenantID, subscriberDelete}},
			{`INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'dsar_deletion', 'api', '{"gdpr_erasure":true}'::jsonb)`,
				[]any{tenantID, canonicalPlaintext}},
			{`INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
			  VALUES ($1::uuid, $2, $3, 'dsar_deletion', 'manual')`,
				[]any{tenantID, "erased+" + suffix + "a@erased.invalid", sha256Hex(privacyWorker)}},
			{`INSERT INTO suppressions (tenant_id, email, email_sha256, reason)
			  VALUES ($1::uuid, $2, $3, 'dsar_deletion')`,
				[]any{tenantID, "erased+" + suffix + "b@erased.invalid", sha256Hex(legacyHashOnly)}},
			{`INSERT INTO erasure_receipts (tenant_id, subscriber_id, email_redacted, email_hash, metadata)
			  VALUES ($1::uuid, gen_random_uuid(), 'redacted@example.com', $2, '{}'::jsonb)`,
				[]any{tenantID, sha256Hex(receiptOnly)}},
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'manual', 'manual', '[]'::jsonb)`,
				[]any{tenantID, malformedMetadata}},
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'manual', 'manual', 'null'::jsonb)`,
				[]any{tenantID, nullMetadata}},
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'manual', ' DSAR-Bulk-Delete ', '{}'::jsonb)`,
				[]any{tenantID, sourceOnly}},
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'manual', 'manual', '{"erasure_receipt_id":"r-1"}'::jsonb)`,
				[]any{tenantID, identityOnly}},
			{`INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
			  VALUES ($1::uuid, $2, 'hard_bounce', 'webhook', '{"note":"mailbox full"}'::jsonb)`,
				[]any{tenantID, bounced}},
			{`INSERT INTO subscriber_suppressions (tenant_id, email, reason, source)
			  VALUES ($1::uuid, $2, 'hard_bounce', 'postmark')`,
				[]any{tenantID, bounced}},
		} {
			if _, err := tx.Exec(txCtx, seed.sql, seed.args...); err != nil {
				t.Fatalf("seed erasure evidence: %v\n%s", err, seed.sql)
			}
		}
	})
	withSuppressionTenantTx(t, ctx, pool, otherTenantID, func(txCtx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'api', '{"gdpr_erasure":true}'::jsonb)`,
			otherTenantID, otherTenantErased); err != nil {
			t.Fatalf("seed other-tenant erasure: %v", err)
		}
	})

	var erased map[string]struct{}
	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		var err error
		erased, err = ErasedAddresses(txCtx, tx, tenantID, []string{
			"  " + strings.ToUpper(subscriberDelete) + " ", canonicalPlaintext, privacyWorker,
			legacyHashOnly, receiptOnly, malformedMetadata, nullMetadata, sourceOnly, identityOnly,
			bounced, otherTenantErased, neverSeen, privacyWorker, "",
		})
		if err != nil {
			t.Fatalf("ErasedAddresses: %v", err)
		}
	})

	got := make([]string, 0, len(erased))
	for email := range erased {
		got = append(got, email)
	}
	sort.Strings(got)
	want := []string{
		canonicalPlaintext, identityOnly, legacyHashOnly, malformedMetadata, nullMetadata,
		privacyWorker, receiptOnly, sourceOnly, subscriberDelete,
	}
	sort.Strings(want)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("erased addresses:\n got %v\nwant %v", got, want)
	}

	// A single write asks about one address at a time; it must reach the same
	// verdict as the batch.
	for _, address := range append(want, bounced, otherTenantErased, neverSeen) {
		withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
			one, err := ErasedAddresses(txCtx, tx, tenantID, []string{address})
			if err != nil {
				t.Fatalf("ErasedAddresses(%s): %v", address, err)
			}
			_, batchSaid := erased[address]
			if _, singleSaid := one[address]; singleSaid != batchSaid || len(one) > 1 {
				t.Fatalf("single-address verdict for %s = %v, batch said %v", address, one, batchSaid)
			}
		})
	}
}

// The erasure check runs over a whole CSV inside the synchronous preflight.
// It used to join every requested address to every suppression row of the
// tenant through an "address OR hash" condition the planner could not hash,
// so a tenant with a long bounce list turned the preflight quadratic. Ten
// thousand addresses against ten thousand bounces must stay well inside a
// request, and still find the one erased address among them.
func TestErasedAddressesStaysFastAgainstALongSuppressionList(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	suffix := randHex4(t)
	const n = 10000
	erasedAddress := "erased-among-bounces-" + suffix + "@example.com"
	// The per-address write lock every suppression insert takes is held to the
	// end of its transaction, so the list is written in slices.
	const slice = 500
	for first := 1; first <= n; first += slice {
		withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
			if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
SELECT $1::uuid, a.email, encode(digest(a.email, 'sha256'), 'hex'), 'hard_bounce', 'postmark'
  FROM (SELECT 'bounce-' || g || '-' || $2 || '@example.com' AS email
          FROM generate_series($3::int, $4::int) g) a`,
				tenantID, suffix, first, first+slice-1); err != nil {
				t.Fatalf("seed bounces: %v", err)
			}
		})
	}
	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions (tenant_id, email, email_sha256, reason, source)
VALUES ($1::uuid, $2, $3, 'dsar_deletion', 'manual')`,
			tenantID, "erased+"+suffix+"@erased.invalid", sha256Hex(erasedAddress)); err != nil {
			t.Fatalf("seed tombstone: %v", err)
		}
	})
	addresses := make([]string, 0, n+1)
	for i := 1; i <= n; i++ {
		addresses = append(addresses, "bounce-"+strconv.Itoa(i)+"-"+suffix+"@example.com")
	}
	addresses = append(addresses, erasedAddress)

	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		started := time.Now()
		erased, err := ErasedAddresses(txCtx, tx, tenantID, addresses)
		elapsed := time.Since(started)
		if err != nil {
			t.Fatalf("ErasedAddresses: %v", err)
		}
		if _, ok := erased[erasedAddress]; !ok || len(erased) != 1 {
			t.Fatalf("erased=%d addresses, want only %s", len(erased), erasedAddress)
		}
		if elapsed > 10*time.Second {
			t.Fatalf("checking %d addresses against %d suppressions took %s", len(addresses), n, elapsed)
		}
	})
}

func TestErasedAddressesWithNothingToCheckMakesNoQuery(t *testing.T) {
	erased, err := ErasedAddresses(context.Background(), nil, "", []string{" ", ""})
	if err != nil || len(erased) != 0 {
		t.Fatalf("blank input erased=%v err=%v", erased, err)
	}
}
