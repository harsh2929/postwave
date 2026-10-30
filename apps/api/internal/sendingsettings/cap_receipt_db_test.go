// SPDX-License-Identifier: AGPL-3.0-only

package sendingsettings

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const capReceiptTestTenantID = "00000000-0000-4000-8000-203400000001"

func TestCapMutationReceiptSurvivesProductionAuditRedaction_DB(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping sending-cap receipt DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	var receiptTable bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.tenant_sending_cap_mutation_receipts') IS NOT NULL`).Scan(&receiptTable); err != nil {
		t.Fatalf("inspect receipt migration: %v", err)
	}
	if !receiptTable {
		t.Fatalf("migration 2034 is not applied to the test database")
	}

	seed, err := db.WithTenant(ctx, pool, capReceiptTestTenantID)
	if err != nil {
		t.Fatalf("begin seed: %v", err)
	}
	if _, err := seed.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, capReceiptTestTenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("clean fixture: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'sending-cap-receipt-test','sending-cap-receipt-test','studio')`, capReceiptTestTenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, capReceiptTestTenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, capReceiptTestTenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	// Model the production redactor's security posture more aggressively than
	// necessary: discard every caller metadata key. The commit proof must still
	// exist because it is a dedicated digest receipt, not audit JSON.
	db.SetAuditRedactor(func(
		context.Context,
		string,
		map[string]any,
	) (map[string]any, []byte, map[string]string, error) {
		return map[string]any{"redacted": true}, nil, nil, nil
	})
	t.Cleanup(func() { db.SetAuditRedactor(nil) })

	capValue := 2500
	coordinator := &fakeCapCache{}
	repo := &Repo{Pool: pool}
	_, lease, err := repo.Upsert(ctx, Settings{
		TenantID:               capReceiptTestTenantID,
		MaxSendsPerHour:        &capValue,
		QuietHoursPerRecipient: true,
	}, UpsertOptions{
		AuditMeta:      &db.AuditMeta{TenantID: capReceiptTestTenantID, ActorType: "system"},
		CapCoordinator: coordinator,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if lease.Token == "" {
		t.Fatal("upsert returned an empty cap mutation lease")
	}
	committed, err := repo.CapMutationCommitted(ctx, capReceiptTestTenantID, lease.Token)
	if err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if !committed {
		t.Fatal("audit redaction erased the dedicated cap mutation receipt")
	}
}
