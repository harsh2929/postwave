package suppressions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestIsIrreversibleTombstone(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		reason   string
		source   string
		metadata map[string]any
		want     bool
	}{
		{name: "canonical DSAR reason", reason: "dsar_deletion", want: true},
		{name: "normalized right to be forgotten reason", reason: "Right-to-be-forgotten", want: true},
		{name: "single GDPR erasure source", reason: "manual", source: "gdpr_delete", want: true},
		{name: "bulk GDPR erasure source", reason: "manual", source: "gdpr_bulk_delete", want: true},
		{name: "future DSAR erase source", reason: "manual", source: "dsar_profile_erasure", want: true},
		{name: "boolean metadata", reason: "manual", source: "manual", metadata: map[string]any{"gdpr_erasure": true}, want: true},
		{name: "string metadata", reason: "manual", source: "manual", metadata: map[string]any{"permanent_erasure": "yes"}, want: true},
		{name: "erased subscriber identity", reason: "manual", source: "manual", metadata: map[string]any{"deleted_subscriber_id": "8df10f04-7a80-45a6-9d5a-5b12f74c7e9f"}, want: true},
		{name: "explicit false is reversible", reason: "manual", source: "manual", metadata: map[string]any{"gdpr_erasure": false}, want: false},
		{name: "ordinary manual suppression", reason: "manual", source: "manual", metadata: map[string]any{"note": "operator hold"}, want: false},
		{name: "ordinary unsubscribe", reason: "unsubscribe", source: "mailchimp", want: false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := IsIrreversibleTombstone(test.reason, test.source, test.metadata); got != test.want {
				t.Fatalf("IsIrreversibleTombstone(%q, %q, %#v) = %t, want %t",
					test.reason, test.source, test.metadata, got, test.want)
			}
		})
	}
}

func TestRepoRemoveLegacyByIDProtectsPermanentEvidence(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	tests := []struct {
		name     string
		reason   string
		source   string
		metadata string
	}{
		{name: "reason", reason: "dsar_deletion", source: "manual", metadata: `{}`},
		{name: "source", reason: "manual", source: "gdpr_delete", metadata: `{}`},
		{name: "bulk source", reason: "manual", source: "gdpr_bulk_delete", metadata: `{}`},
		{name: "metadata", reason: "manual", source: "manual", metadata: `{"gdpr_erasure":true}`},
		{name: "identity metadata", reason: "manual", source: "manual", metadata: `{"deleted_subscriber_id":"fe8fda35-d262-4ea5-ae2d-9d83f139d176"}`},
		{name: "malformed metadata shape", reason: "manual", source: "manual", metadata: `[]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			email := "legacy-permanent-" + test.name + "-" + randHex4(t) + "@example.com"
			id := seedLegacyRemovalRow(t, ctx, pool, tenantID, email, test.reason, test.source, test.metadata)

			err := repo.RemoveLegacyByID(ctx, tenantID, id)
			if !errors.Is(err, ErrIrreversibleSuppression) {
				t.Fatalf("RemoveLegacyByID error = %v, want ErrIrreversibleSuppression", err)
			}
			if count := legacyRemovalRowCount(t, ctx, pool, tenantID, id); count != 1 {
				t.Fatalf("protected row count = %d, want 1", count)
			}
		})
	}
}

func TestRepoRemoveLegacyByIDProtectsConvergedErasureEvidence(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	t.Run("canonical plaintext tombstone", func(t *testing.T) {
		email := "canonical-erasure-" + randHex4(t) + "@example.com"
		id := seedLegacyRemovalRow(t, ctx, pool, tenantID, email, "manual", "manual", `{}`)
		withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
			if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'api', '{"gdpr_erasure":true}'::jsonb)`,
				tenantID, email); err != nil {
				t.Fatalf("seed canonical erasure: %v", err)
			}
		})

		if err := repo.RemoveLegacyByID(ctx, tenantID, id); !errors.Is(err, ErrIrreversibleSuppression) {
			t.Fatalf("RemoveLegacyByID error = %v, want ErrIrreversibleSuppression", err)
		}
		if count := legacyRemovalRowCount(t, ctx, pool, tenantID, id); count != 1 {
			t.Fatalf("protected row count = %d, want 1", count)
		}
	})

	t.Run("canonical hash tombstone", func(t *testing.T) {
		email := "canonical-hash-erasure-" + randHex4(t) + "@example.com"
		id := seedLegacyRemovalRow(t, ctx, pool, tenantID, email, "manual", "manual", `{}`)
		digest := sha256.Sum256([]byte(email))
		emailHash := hex.EncodeToString(digest[:])
		withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
			if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, email_sha256, reason, source, metadata)
VALUES ($1::uuid, $2, $3, 'dsar_deletion', 'api', '{}'::jsonb)`,
				tenantID, "erased-"+randHex4(t)+"@invalid.local", emailHash); err != nil {
				t.Fatalf("seed hash erasure: %v", err)
			}
		})

		if err := repo.RemoveLegacyByID(ctx, tenantID, id); !errors.Is(err, ErrIrreversibleSuppression) {
			t.Fatalf("RemoveLegacyByID error = %v, want ErrIrreversibleSuppression", err)
		}
		if count := legacyRemovalRowCount(t, ctx, pool, tenantID, id); count != 1 {
			t.Fatalf("protected row count = %d, want 1", count)
		}
	})

	t.Run("immutable erasure receipt", func(t *testing.T) {
		email := "receipt-erasure-" + randHex4(t) + "@example.com"
		id := seedLegacyRemovalRow(t, ctx, pool, tenantID, email, "manual", "manual", `{}`)
		digest := sha256.Sum256([]byte(email))
		emailHash := hex.EncodeToString(digest[:])
		withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
			if _, err := tx.Exec(txCtx, `
INSERT INTO erasure_receipts
       (tenant_id, subscriber_id, email_redacted, email_hash, metadata)
VALUES ($1::uuid, gen_random_uuid(), 'redacted@example.com', $2, '{}'::jsonb)`,
				tenantID, emailHash); err != nil {
				t.Fatalf("seed erasure receipt: %v", err)
			}
		})

		if err := repo.RemoveLegacyByID(ctx, tenantID, id); !errors.Is(err, ErrIrreversibleSuppression) {
			t.Fatalf("RemoveLegacyByID error = %v, want ErrIrreversibleSuppression", err)
		}
		if count := legacyRemovalRowCount(t, ctx, pool, tenantID, id); count != 1 {
			t.Fatalf("protected row count = %d, want 1", count)
		}
	})
}

func TestRepoRemoveLegacyByIDTenantIsolationAndReversibleRows(t *testing.T) {
	ctx, pool := suppressionRemovalTestPool(t)
	tenantA := newSuppressionTestTenant(t, ctx, pool)
	tenantB := newSuppressionTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	sharedEmail := "tenant-isolation-" + randHex4(t) + "@example.com"

	idA := seedLegacyRemovalRow(t, ctx, pool, tenantA, sharedEmail, "manual", "manual", `{"note":"reviewed release"}`)
	idB := seedLegacyRemovalRow(t, ctx, pool, tenantB, sharedEmail, "manual", "gdpr_delete", `{"gdpr_erasure":true}`)
	withSuppressionTenantTx(t, ctx, pool, tenantB, func(txCtx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(txCtx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'dsar_deletion', 'api', '{"gdpr_erasure":true}'::jsonb)`,
			tenantB, sharedEmail); err != nil {
			t.Fatalf("seed other-tenant canonical erasure: %v", err)
		}
	})

	if err := repo.RemoveLegacyByID(ctx, tenantA, idB); !errors.Is(err, ErrLegacySuppressionNotFound) {
		t.Fatalf("cross-tenant removal error = %v, want ErrLegacySuppressionNotFound", err)
	}
	if count := legacyRemovalRowCount(t, ctx, pool, tenantB, idB); count != 1 {
		t.Fatalf("other tenant protected row count = %d, want 1", count)
	}

	// Erasure evidence for the same address in another tenant must neither leak
	// nor block tenant A's independently reviewed ordinary suppression.
	if err := repo.RemoveLegacyByID(ctx, tenantA, idA); err != nil {
		t.Fatalf("remove ordinary tenant-A suppression: %v", err)
	}
	if count := legacyRemovalRowCount(t, ctx, pool, tenantA, idA); count != 0 {
		t.Fatalf("ordinary row count after removal = %d, want 0", count)
	}
	if count := legacyRemovalRowCount(t, ctx, pool, tenantB, idB); count != 1 {
		t.Fatalf("tenant-B tombstone count after tenant-A removal = %d, want 1", count)
	}
}

func seedLegacyRemovalRow(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, email, reason, source, metadata string,
) string {
	t.Helper()
	var id string
	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		if err := tx.QueryRow(txCtx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
RETURNING id::text`, tenantID, email, reason, source, metadata).Scan(&id); err != nil {
			t.Fatalf("seed legacy suppression: %v", err)
		}
	})
	return id
}

func legacyRemovalRowCount(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, id string,
) int {
	t.Helper()
	var count int
	withSuppressionTenantTx(t, ctx, pool, tenantID, func(txCtx context.Context, tx pgx.Tx) {
		if err := tx.QueryRow(txCtx, `
SELECT count(*)
  FROM email_suppressions
 WHERE tenant_id = $1::uuid
	AND id::text = $2`, tenantID, id).Scan(&count); err != nil {
			t.Fatalf("count legacy suppression: %v", err)
		}
	})
	return count
}
