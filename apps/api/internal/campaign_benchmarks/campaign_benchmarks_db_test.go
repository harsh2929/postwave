// SPDX-License-Identifier: AGPL-3.0-only

package campaign_benchmarks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func benchmarkDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed campaign benchmark tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func benchmarkUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func benchmarkTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := benchmarkUUID(t)
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, "bench-"+tenantID[:8]); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanup, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return tenantID
}

func benchmarkExec(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	query string,
	args ...any,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		t.Fatalf("exec benchmark fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit benchmark fixture: %v", err)
	}
}

func benchmarkCampaign(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	status string,
) string {
	t.Helper()
	id := benchmarkUUID(t)
	benchmarkExec(t, pool, ctx, tenantID, `
INSERT INTO campaigns (id, tenant_id, name, subject, status)
VALUES ($1::uuid, $2::uuid, $1::text, $1::text, $3)`, id, tenantID, status)
	return id
}

func benchmarkRecipient(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	campaignID string,
	email string,
	status string,
	sentAt time.Time,
) {
	t.Helper()
	benchmarkExec(t, pool, ctx, tenantID, `
INSERT INTO campaign_recipients
       (tenant_id, campaign_id, subscriber_email, status, sent_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
		tenantID, campaignID, email, status, sentAt)
}

func benchmarkEvent(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID string,
	campaignID string,
	email string,
	eventType string,
	at time.Time,
) {
	t.Helper()
	benchmarkExec(t, pool, ctx, tenantID, `
INSERT INTO subscriber_events
       (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
		tenantID, campaignID, email, eventType, at)
}

func TestCampaignBenchmarkDenominatorWindowAndTenantBoundaryDB(t *testing.T) {
	pool := benchmarkDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	tenantID := benchmarkTenant(t, pool, ctx)
	foreignTenantID := benchmarkTenant(t, pool, ctx)
	asOf := time.Now().UTC().Truncate(time.Second)
	currentID := benchmarkCampaign(t, pool, ctx, tenantID, "sent")
	foreignID := benchmarkCampaign(t, pool, ctx, foreignTenantID, "sent")

	benchmarkRecipient(t, pool, ctx, tenantID, currentID,
		"sent@example.test", "sent", asOf.Add(-2*time.Hour))
	benchmarkRecipient(t, pool, ctx, tenantID, currentID,
		"failed@example.test", "failed", time.Time{})
	benchmarkEvent(t, pool, ctx, tenantID, currentID,
		"sent@example.test", "opened", asOf.Add(-time.Hour))
	benchmarkEvent(t, pool, ctx, tenantID, currentID,
		"failed@example.test", "opened", asOf.Add(-time.Hour))
	benchmarkEvent(t, pool, ctx, tenantID, currentID,
		"sent@example.test", "clicked", asOf.Add(time.Hour))

	// Five completed peers meet the judgement floor. A draft with a sent
	// recipient and an old completed campaign must not enter the sample.
	for i := 0; i < benchmarkMinSampleSize; i++ {
		id := benchmarkCampaign(t, pool, ctx, tenantID, "sent")
		email := "peer-" + id[:8] + "@example.test"
		benchmarkRecipient(t, pool, ctx, tenantID, id, email, "sent",
			asOf.Add(-time.Duration(i+1)*24*time.Hour))
		benchmarkEvent(t, pool, ctx, tenantID, id, email, "opened",
			asOf.Add(-time.Duration(i+1)*24*time.Hour))
	}
	draftID := benchmarkCampaign(t, pool, ctx, tenantID, "draft")
	benchmarkRecipient(t, pool, ctx, tenantID, draftID,
		"draft@example.test", "sent", asOf.Add(-time.Hour))
	oldID := benchmarkCampaign(t, pool, ctx, tenantID, "sent")
	benchmarkRecipient(t, pool, ctx, tenantID, oldID,
		"old@example.test", "sent", asOf.Add(-120*24*time.Hour))

	tx, err := db.WithTenantOptions(ctx, pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		t.Fatalf("WithTenantOptions: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := campaignRates(ctx, tx, tenantID, currentID, asOf)
	if err != nil {
		t.Fatalf("campaignRates: %v", err)
	}
	if current.Recipients != 1 || current.OpenRate != 1 || current.ClickRate != 0 {
		t.Fatalf("current rates included failed/future actors: %+v", current)
	}

	for label, id := range map[string]string{
		"missing": benchmarkUUID(t),
		"foreign": foreignID,
	} {
		if _, err := campaignRates(ctx, tx, tenantID, id, asOf); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("%s campaign error=%v, want nondisclosing pgx.ErrNoRows", label, err)
		}
	}

	baseline, samples, err := tenantBaseline(
		ctx,
		tx,
		tenantID,
		currentID,
		asOf.Add(-90*24*time.Hour),
		asOf,
	)
	if err != nil {
		t.Fatalf("tenantBaseline: %v", err)
	}
	if len(samples) != benchmarkMinSampleSize ||
		baseline.OpenRate != 1 ||
		baseline.Recipients != 1 {
		t.Fatalf("baseline=%+v samples=%d, want five completed peers", baseline, len(samples))
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit read: %v", err)
	}
}
