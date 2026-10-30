// SPDX-License-Identifier: AGPL-3.0-only
//
// Round-trip integration test for RecordScore → AvgScoreLast30d. The
// predictenrich handler depends on this round-trip producing the
// authoritative average that gets injected into the placement
// predictor's HistoricalEngagement payload.

package eqscore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newEQTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed eqscore tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randHex(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

// seedEQTenant inserts a tenants row and returns its id + a cleanup
// fn. Mirrors the agency package's helper.
func seedEQTenant(t *testing.T, pool *pgxpool.Pool) (string, func()) {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var id string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, false)`, id); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		id, "eq-test-"+randHex(t), "EQ test"); err != nil {
		t.Fatalf("seed tenant (likely missing tenants table): %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = conn.Exec(ctx,
			`DELETE FROM eq_score_history WHERE tenant_id = $1::uuid`, id)
		_, _ = conn.Exec(ctx,
			`DELETE FROM tenants WHERE id = $1::uuid`, id)
	}
	return id, cleanup
}

func TestRecordScore_AvgScoreLast30d_RoundTrip(t *testing.T) {
	pool := newEQTestPool(t)
	tenantID, cleanup := seedEQTenant(t, pool)
	defer cleanup()

	// Empty history → has=false, avg=0.
	avg, has, err := AvgScoreLast30d(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("AvgScoreLast30d (empty): %v", err)
	}
	if has || avg != 0 {
		t.Fatalf("empty history should give has=false avg=0, got has=%v avg=%d", has, avg)
	}

	// Persist three scores: 70, 80, 90 → mean = 80.
	for _, s := range []int{70, 80, 90} {
		err := RecordScore(context.Background(), pool, HistoryRecord{
			TenantID:     tenantID,
			Score:        s,
			Grade:        "B",
			ContentScore: s,
			AuthScore:    s,
			ReputationSc: -1, // skipped sub-score → NULL
			FromAddress:  "alice@example.com",
		})
		if err != nil {
			t.Fatalf("RecordScore(%d): %v", s, err)
		}
	}

	avg, has, err = AvgScoreLast30d(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("AvgScoreLast30d (after persist): %v", err)
	}
	if !has {
		t.Fatalf("expected has=true after 3 inserts")
	}
	if avg != 80 {
		t.Errorf("avg=%d want 80", avg)
	}
}

// Tenant isolation: scores from tenant A must not leak into tenant B's
// average. This is a direct check of the eq_score_history RLS policy.
func TestRecordScore_TenantIsolated(t *testing.T) {
	pool := newEQTestPool(t)
	tenantA, cleanupA := seedEQTenant(t, pool)
	defer cleanupA()
	tenantB, cleanupB := seedEQTenant(t, pool)
	defer cleanupB()

	// Insert a score for A only.
	if err := RecordScore(context.Background(), pool, HistoryRecord{
		TenantID:     tenantA,
		Score:        95,
		Grade:        "A",
		ContentScore: 95,
		AuthScore:    95,
		ReputationSc: 95,
	}); err != nil {
		t.Fatalf("RecordScore A: %v", err)
	}

	// Tenant B's average must be empty — RLS guards the lookup.
	avg, has, err := AvgScoreLast30d(context.Background(), pool, tenantB)
	if err != nil {
		t.Fatalf("AvgScoreLast30d B: %v", err)
	}
	if has || avg != 0 {
		t.Errorf("tenant B leaked tenant A's score: has=%v avg=%d (RLS broken)", has, avg)
	}

	// Tenant A still sees its own row.
	avgA, hasA, err := AvgScoreLast30d(context.Background(), pool, tenantA)
	if err != nil {
		t.Fatalf("AvgScoreLast30d A: %v", err)
	}
	if !hasA || avgA != 95 {
		t.Errorf("tenant A has=%v avg=%d want true/95", hasA, avgA)
	}
}

func TestDBSenderAuthResolverUsesExactTenantDomain(t *testing.T) {
	pool := newEQTestPool(t)
	tenantA, cleanupA := seedEQTenant(t, pool)
	defer cleanupA()
	tenantB, cleanupB := seedEQTenant(t, pool)
	defer cleanupB()

	tx, err := db.WithTenant(context.Background(), pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// spf_record_value and dmarc_record_value are pinned to exact literals by
	// sending_identities_dns_instruction_safety_check (migration 1854). They are
	// nullable with no default, so omitting them stores NULL and the row is
	// rejected — a fixture describing an identity the product cannot create.
	// The literals are the ones sending_identity.spfRecordValue() and
	// dmarcRecordValue() actually write; 1854 pins them so an old replica cannot
	// persist the former unqualified rua/ruf destinations during a rolling
	// deploy.
	_, err = tx.Exec(context.Background(), `
INSERT INTO sending_identities (
  tenant_id, domain, dkim_public_key_b64, spf_verified_at,
  dkim_verified_at, dmarc_verified_at, verify_state, verified_at,
  spf_record_value, dmarc_record_value
) VALUES ($1::uuid, 'acme.example', 'test-key', now(), now(), now(), 'verified', now(),
  'v=spf1 include:_spf.postwave.io -all', 'v=DMARC1; p=none; aspf=r; adkim=r')`, tenantA)
	if err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("insert sending identity: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit sending identity: %v", err)
	}

	resolver := NewDBSenderAuthResolver(pool)
	state, err := resolver.ResolveSenderAuth(
		context.Background(),
		tenantA,
		"Acme Updates <hello@ACME.EXAMPLE>",
	)
	if err != nil {
		t.Fatalf("ResolveSenderAuth tenant A: %v", err)
	}
	if state.Domain != "acme.example" || !state.DomainVerified ||
		!state.SPFVerified || !state.DKIMVerified || !state.DMARCAligned {
		t.Fatalf("tenant A state = %+v", state)
	}

	state, err = resolver.ResolveSenderAuth(
		context.Background(),
		tenantB,
		"hello@acme.example",
	)
	if err != nil {
		t.Fatalf("ResolveSenderAuth tenant B: %v", err)
	}
	if state.Domain != "acme.example" || state.DomainVerified ||
		state.SPFVerified || state.DKIMVerified || state.DMARCAligned {
		t.Fatalf("tenant B observed tenant A state: %+v", state)
	}
}

func TestDBReputationUsesSevenDayTenantWindowAndSampleFloor(t *testing.T) {
	pool := newEQTestPool(t)
	tenantA, cleanupA := seedEQTenant(t, pool)
	defer cleanupA()
	tenantB, cleanupB := seedEQTenant(t, pool)
	defer cleanupB()

	seedReputationEvents(t, pool, tenantA, 100, 98, 2, 1)
	seedReputationEvents(t, pool, tenantB, 99, 97, 2, 1)

	reputation := NewDBReputation(pool)
	stats, has, err := reputation.Last7d(context.Background(), tenantA)
	if err != nil {
		t.Fatalf("Last7d tenant A: %v", err)
	}
	if !has || stats != (Last7dStats{Sent: 100, Delivered: 98, Bounced: 2, Complained: 1}) {
		t.Fatalf("tenant A stats = %+v has=%v", stats, has)
	}

	stats, has, err = reputation.Last7d(context.Background(), tenantB)
	if err != nil {
		t.Fatalf("Last7d tenant B: %v", err)
	}
	if has || stats.Sent != 99 {
		t.Fatalf("99-send sample should be present but unscored: %+v has=%v", stats, has)
	}
}

func seedReputationEvents(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	sent int,
	delivered int,
	bounced int,
	complained int,
) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject)
VALUES ($1::uuid, 'EQ reputation fixture', 'Fixture')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		t.Fatalf("insert campaign: %v", err)
	}
	for eventType, count := range map[string]int{
		"sent":       sent,
		"delivered":  delivered,
		"bounced":    bounced,
		"complained": complained,
	} {
		if count == 0 {
			continue
		}
		_, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (
  tenant_id, campaign_id, subscriber_email, event_type, source
)
SELECT $1::uuid, $2::uuid, ('eq-' || $3 || '-' || n || '@example.test')::citext,
       $3, 'eqscore-test'
  FROM generate_series(1, $4::int) AS n`, tenantID, campaignID, eventType, count)
		if err != nil {
			t.Fatalf("insert %s events: %v", eventType, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit reputation events: %v", err)
	}
}
