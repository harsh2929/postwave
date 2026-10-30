// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Proof that the PII-findings erasure actually erases, and that its tenant
// binding actually refuses.
//
// The only other coverage of migration 1913 was a substring match asserting that
// erasure.go CONTAINS the call. That is worth having — it is what notices if the
// call is deleted — but it executes nothing, so a function that deleted zero
// rows, or one that happily erased another tenant's findings, passed the whole
// package. A review made both points and both were right.
//
// The gap mattered more here than it would for a sibling DELETE. The other
// twelve satellites are plain statements whose failure mode is loud: the
// original bug in this very table announced itself as "permission denied". The
// logic now lives in plpgsql that no Go test ran, where the failure modes are
// quiet — a predicate that matches nothing returns 0 and looks like a subject
// who simply had no findings.
//
// FOUR PROPERTIES, because three of them are the security argument the migration
// makes for itself and an untested security argument is a comment:
//
//  1. a matching tenant erases the subject's findings and reports how many;
//  2. a tenant that disagrees with app.tenant_id is REFUSED, not silently
//     scoped down — without this, EXECUTE is a cross-tenant delete capability;
//  3. no tenant GUC at all is refused for the same reason;
//  4. the app role still cannot DELETE the table directly, which is the
//     immutability contract the whole definer detour exists to preserve.
func TestSubscriberPIIFindingsEraseIsScopedAndActuallyDeletes(t *testing.T) {
	pool := newErasureTestPool(t)
	ctx := context.Background()

	const tenantA = "3f000000-0000-4000-8000-000000000001"
	const tenantB = "3f000000-0000-4000-8000-000000000002"
	seedErasureTenant(t, pool, tenantA)
	t.Cleanup(func() { cleanupErasureTenant(t, pool, tenantA) })
	seedErasureTenant(t, pool, tenantB)
	t.Cleanup(func() { cleanupErasureTenant(t, pool, tenantB) })

	const email = "findings-erase@example.test"

	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	subscriberID := seedErasureSubscriber(t, tx, tenantA, email, "findings", "+15550000001", false)

	// A finding in its initial 'pending' state, which is the only state that can
	// be inserted on its own: a terminal finding requires a matching immutable
	// review receipt, and the receipt requires the terminal finding, so the pair
	// can only be created together through the review path. Pending is enough
	// here — erasure does not care what state the accusation reached.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_pii_findings (
    tenant_id, subscriber_id, field_name, detected_type, raw_value_hash,
    scanner_name, scanner_version, detector_name, detector_version,
    policy_name, policy_version, fingerprint_scheme, fingerprint_key_version
) VALUES (
    $1::uuid, $2::uuid, 'notes', 'ssn', repeat('a', 64),
    'scanner', '1', 'detector', '1', 'policy', '1', 'hmac-sha256-v1', 'k1'
)`, tenantA, subscriberID); err != nil {
		t.Fatalf("seed pii finding: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	countFindings := func(tenantID string) int {
		t.Helper()
		countTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open count transaction: %v", err)
		}
		defer func() { _ = countTx.Rollback(ctx) }()
		var n int
		if err := countTx.QueryRow(ctx,
			`SELECT count(*) FROM subscriber_pii_findings WHERE tenant_id = $1::uuid`,
			tenantID).Scan(&n); err != nil {
			t.Fatalf("count findings: %v", err)
		}
		return n
	}

	if got := countFindings(tenantA); got != 1 {
		t.Fatalf("seeded findings = %d, want 1 (the rest of this test proves nothing without it)", got)
	}

	// (2) A foreign tenant must be refused. Checked BEFORE the successful call,
	// so a function that erased everything regardless of tenant cannot pass this
	// by having already deleted the row.
	foreignTx, err := db.WithTenant(ctx, pool, tenantB)
	if err != nil {
		t.Fatalf("open foreign-tenant transaction: %v", err)
	}
	_, foreignErr := foreignTx.Exec(ctx,
		`SELECT subscriber_pii_findings_erase($1::uuid, $2::citext)`, tenantA, email)
	_ = foreignTx.Rollback(ctx)
	if foreignErr == nil {
		t.Fatal("erasing tenant A's findings from a tenant B session succeeded; " +
			"EXECUTE on this function is then a cross-tenant delete capability")
	}
	if !strings.Contains(foreignErr.Error(), "does not match session tenant") {
		t.Fatalf("foreign-tenant call failed for the wrong reason: %v", foreignErr)
	}
	if got := countFindings(tenantA); got != 1 {
		t.Fatalf("findings after refused foreign call = %d, want 1", got)
	}

	// (3) No tenant GUC at all. Acquired straight from the pool so app.tenant_id
	// is unset, which is what a worker or a mis-wired call path would present.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire connection: %v", err)
	}
	_, unscopedErr := conn.Exec(ctx,
		`SELECT subscriber_pii_findings_erase($1::uuid, $2::citext)`, tenantA, email)
	conn.Release()
	if unscopedErr == nil {
		t.Fatal("erasure succeeded with no app.tenant_id set; the function must refuse " +
			"rather than trust its argument")
	}
	if !strings.Contains(unscopedErr.Error(), "requires app.tenant_id") {
		t.Fatalf("unscoped call failed for the wrong reason: %v", unscopedErr)
	}

	// (4) The immutability contract is still intact: the app role has no DELETE.
	denyTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open direct-delete transaction: %v", err)
	}
	_, deleteErr := denyTx.Exec(ctx,
		`DELETE FROM subscriber_pii_findings WHERE tenant_id = $1::uuid`, tenantA)
	_ = denyTx.Rollback(ctx)
	if deleteErr == nil {
		t.Fatal("the app role deleted from subscriber_pii_findings directly; the " +
			"immutability contract pii_scanner asserts has been lost, and the " +
			"definer function is no longer the only way in")
	}

	// (1) The real thing: the owning tenant erases, and reports what it erased.
	eraseTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open erase transaction: %v", err)
	}
	var erased int64
	if err := eraseTx.QueryRow(ctx,
		`SELECT subscriber_pii_findings_erase($1::uuid, $2::citext)`, tenantA, email).Scan(&erased); err != nil {
		_ = eraseTx.Rollback(ctx)
		t.Fatalf("erase findings: %v", err)
	}
	if err := eraseTx.Commit(ctx); err != nil {
		t.Fatalf("commit erase: %v", err)
	}
	if erased != 1 {
		t.Fatalf("function reported %d rows erased, want 1", erased)
	}
	if got := countFindings(tenantA); got != 0 {
		t.Fatalf("findings after erasure = %d, want 0 — the call reported success "+
			"and the subject's rows are still there", got)
	}
}
