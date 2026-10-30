// SPDX-License-Identifier: AGPL-3.0-only
//
// growth_test.go — pure-function, handler-guard, migration-contract, and live
// PostgreSQL tests for the SUB-124 audience growth report. The pure window and
// arithmetic cases remain runnable without a database; the live case proves
// the verified ledger, UTC semantics, RLS, and rolling cutover.

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestParseGrowthDays(t *testing.T) {
	cases := []struct {
		in      string
		want    int
		wantErr bool
	}{
		{in: "", want: 90},
		{in: "30", want: 30},
		{in: "  45  ", want: 45},
		{in: "1", want: 1},
		{in: "365", want: 365},
		{in: "30d", wantErr: true},
		{in: "0", wantErr: true},
		{in: "-5", wantErr: true},
		{in: "abc", wantErr: true},
		{in: "366", wantErr: true},
		{in: "1000", wantErr: true},
		{in: "1.5", wantErr: true},
		{in: "999999999999999999999999999999999", wantErr: true},
	}
	for _, tc := range cases {
		got, err := parseGrowthDays(tc.in)
		if tc.wantErr {
			if !errors.Is(err, errInvalidGrowthDays) {
				t.Errorf("parseGrowthDays(%q) error = %v, want errInvalidGrowthDays", tc.in, err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("parseGrowthDays(%q) = %d, %v; want %d, nil", tc.in, got, err, tc.want)
		}
	}
}

func TestSubscriberGrowthDelta(t *testing.T) {
	t.Run("fewer than 2 points -> zero", func(t *testing.T) {
		if d, p := subscriberGrowthDelta(nil); d != 0 || p != 0 {
			t.Fatalf("nil -> (%d,%f), want (0,0)", d, p)
		}
		if d, p := subscriberGrowthDelta([]GrowthPoint{{Total: 100}}); d != 0 || p != 0 {
			t.Fatalf("single -> (%d,%f), want (0,0)", d, p)
		}
	})
	t.Run("net growth", func(t *testing.T) {
		series := []GrowthPoint{{Total: 100}, {Total: 130}, {Total: 125}}
		d, p := subscriberGrowthDelta(series)
		if d != 25 {
			t.Fatalf("delta = %d, want 25", d)
		}
		if p < 24.99 || p > 25.01 {
			t.Fatalf("pct = %f, want ~25", p)
		}
	})
	t.Run("first total zero -> pct 0 not NaN", func(t *testing.T) {
		series := []GrowthPoint{{Total: 0}, {Total: 50}}
		d, p := subscriberGrowthDelta(series)
		if d != 50 || p != 0 {
			t.Fatalf("(%d,%f), want (50,0)", d, p)
		}
	})
}

func TestSummariseGrowth(t *testing.T) {
	series := []GrowthPoint{
		{Added: 10, Unsubbed: 2},
		{Added: 5, Unsubbed: 1},
		{Added: 0, Unsubbed: 3},
	}
	added, unsubbed, err := summariseGrowth(series)
	if err != nil {
		t.Fatalf("summariseGrowth: %v", err)
	}
	if added != 15 || unsubbed != 6 {
		t.Fatalf("totals added=%d unsubbed=%d, want 15/6", added, unsubbed)
	}
	if _, _, err := summariseGrowth([]GrowthPoint{{Added: math.MaxInt64}, {Added: 1}}); err == nil {
		t.Fatal("overflowing summary must fail closed")
	}
	if _, _, err := summariseGrowth([]GrowthPoint{{Unsubbed: -1}}); err == nil {
		t.Fatal("negative summary input must fail closed")
	}
}

func TestValidateGrowthSeries(t *testing.T) {
	readAt := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	valid := []GrowthPoint{
		{Date: "2026-07-18", EvaluatedAt: time.Date(2026, 7, 18, 11, 0, 0, 0, time.UTC), Total: 10, Added: 2, Unsubbed: 1},
		{Date: "2026-07-19", EvaluatedAt: time.Date(2026, 7, 19, 11, 0, 0, 0, time.UTC), Total: 11, Added: 2},
	}
	if err := validateGrowthSeries(valid, 2, readAt); err != nil {
		t.Fatalf("valid series rejected: %v", err)
	}

	cases := []struct {
		name   string
		series []GrowthPoint
		days   int
	}{
		{name: "outside exact window", series: []GrowthPoint{valid[0]}, days: 1},
		{name: "future date", series: []GrowthPoint{{Date: "2026-07-20", EvaluatedAt: readAt}}, days: 2},
		{name: "future evaluation", series: []GrowthPoint{{Date: "2026-07-19", EvaluatedAt: readAt.Add(time.Second)}}, days: 2},
		{name: "evaluation day mismatch", series: []GrowthPoint{{Date: "2026-07-19", EvaluatedAt: valid[0].EvaluatedAt}}, days: 2},
		{name: "descending", series: []GrowthPoint{valid[1], valid[0]}, days: 2},
		{name: "duplicate date", series: []GrowthPoint{valid[0], valid[0]}, days: 2},
		{name: "negative count", series: []GrowthPoint{{Date: "2026-07-19", EvaluatedAt: readAt.Add(-time.Minute), Total: -1}}, days: 2},
		{name: "invented lapsed value", series: []GrowthPoint{{Date: "2026-07-19", EvaluatedAt: readAt.Add(-time.Minute), Lapsed: 1}}, days: 2},
		{name: "invalid days", series: valid, days: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateGrowthSeries(tc.series, tc.days, readAt); err == nil {
				t.Fatal("invalid series was accepted")
			}
		})
	}
}

func TestGrowthHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/growth", nil)
	rec := httptest.NewRecorder()
	d.Growth(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSnapshotGrowthHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/growth/snapshot", nil)
	rec := httptest.NewRecorder()
	d.SnapshotGrowth(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestGrowthHandlerRejectsInvalidExplicitDaysBeforeRepositoryAccess(t *testing.T) {
	tenant := &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000124"}
	for _, target := range []string{
		"/api/v1/subscribers/growth?days=0",
		"/api/v1/subscribers/growth?days=30d",
		"/api/v1/subscribers/growth?days=366",
		"/api/v1/subscribers/growth?days=1&days=2",
	} {
		t.Run(target, func(t *testing.T) {
			d := &Deps{}
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req = req.WithContext(middleware.WithTenant(req.Context(), tenant))
			rec := httptest.NewRecorder()
			d.Growth(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "invalid_days") ||
				!strings.Contains(rec.Body.String(), "integer from 1 through 365") {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}

// TestGrowthResponseAssemblyDefaults verifies the empty-series note path
// without a DB by exercising the pure assembly the handler performs.
func TestGrowthResponseAssemblyDefaults(t *testing.T) {
	out, err := assembleGrowthResponse(90, []GrowthPoint{})
	if err != nil {
		t.Fatalf("assembleGrowthResponse: %v", err)
	}
	if out.Note == "" {
		t.Fatal("empty series must carry a note")
	}
	if out.Delta != 0 || out.TotalAdded != 0 {
		t.Fatal("empty series must yield zero figures")
	}
	if len(out.UnavailableMetrics) != 1 || out.UnavailableMetrics[0] != "lapsed" {
		t.Fatalf("unavailable_metrics = %v, want [lapsed]", out.UnavailableMetrics)
	}
	if len(out.PartialMetrics) != 1 || out.PartialMetrics[0] != "unsubbed" {
		t.Fatalf("partial_metrics = %v, want [unsubbed]", out.PartialMetrics)
	}
	if out.MetricContractVersion != growthMetricContractVersion {
		t.Fatalf("metric_contract_version = %q, want %q", out.MetricContractVersion, growthMetricContractVersion)
	}
	if !strings.Contains(out.Note, "lower bound") ||
		!strings.Contains(out.Note, "do not present this as exhaustive churn") {
		t.Fatalf("note does not qualify verified withdrawals: %q", out.Note)
	}
	if !strings.Contains(out.Note, "legacy heuristic snapshots") ||
		!strings.Contains(out.Note, "shorter after upgrade") {
		t.Fatalf("note does not disclose the non-backfilled contract cutover: %q", out.Note)
	}
	if !strings.Contains(out.Note, "0 values are placeholders") {
		t.Fatalf("note does not honestly qualify unavailable lapsed values: %q", out.Note)
	}
}

// TestGrowthVerifiedWithdrawalSourceInventory prevents a future UI/API change
// from silently promoting the verified exact-ledger subset into an exhaustive
// unsubscribe total. The paired writers below are included by the snapshot;
// the negative writers below lack the same event+proof+address identity and
// are intentionally excluded, which is why `unsubbed` must remain partial.
func TestGrowthVerifiedWithdrawalSourceInventory(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve audience-growth test source")
	}
	subscribersDir := filepath.Dir(thisFile)
	internalDir := filepath.Dir(subscribersDir)

	read := func(path string) string {
		t.Helper()
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read growth source inventory %s: %v", path, err)
		}
		return string(raw)
	}
	require := func(path string, needles ...string) {
		t.Helper()
		text := read(path)
		for _, needle := range needles {
			if !strings.Contains(text, needle) {
				t.Errorf("%s lost growth source-inventory marker %q", path, needle)
			}
		}
	}

	// Included: these profile-wide workflows bind an exact address event to a
	// structured proof and stamp the operation consumed by growth.go.
	require(filepath.Join(subscribersDir, "bulk_email_consent_safety.go"),
		"recordEmailConsentEvidence", `"bulk_consent"`)
	require(filepath.Join(subscribersDir, "bulk_unsubscribe_safety.go"),
		"INSERT INTO consent_events", "INSERT INTO consent_records", "'bulk_unsubscribe'")
	require(filepath.Join(subscribersDir, "channel_consent_canonical.go"),
		"recordEmailConsentEvidence", `"channel_consent_email"`)
	require(filepath.Join(subscribersDir, "jurisdiction.go"),
		"recordEmailConsentEvidence", `jurisdictionReconfirmationOperation = "jurisdiction_reconfirmation"`)

	// Excluded production classes: event-only, proof-only, and projection-only
	// negative writers cannot prove the same exact-address state transition.
	oneClickPath := filepath.Join(internalDir, "preferences", "one_click.go")
	require(oneClickPath, "INSERT INTO consent_events", "'revoked'", "'one_click'")
	if strings.Contains(read(oneClickPath), "INSERT INTO consent_records") {
		t.Errorf("%s unexpectedly became a paired proof writer; review growth coverage", oneClickPath)
	}
	require(filepath.Join(internalDir, "consent", "consent_records.go"),
		`"withdrawn": {}`, `"preference_center": {}`, `"one_click":`, `"webhook":`)
	require(filepath.Join(subscribersDir, "repo.go"), "func (r *Repo) SetStatus")
	require(filepath.Join(subscribersDir, "repo_update.go"), "isUnsubscribeTransition")
	require(filepath.Join(subscribersDir, "repo_suppressions.go"), "SET status = 'blocklisted'")
	require(filepath.Join(internalDir, "suppressions", "store.go"),
		"UPDATE subscribers SET status = 'blocklisted'")
	require(filepath.Join(subscribersDir, "growth.go"),
		`PartialMetrics:        []string{"unsubbed"}`,
		`growthMetricContractVersion = "verified-exact-ledger-v2"`,
		"subscriber_growth_verified_history",
		"are a lower bound",
		"do not present this as exhaustive churn")
}

func newGrowthTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed audience-growth test")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	// Deliberately run every test connection in a timezone far from UTC. The
	// growth contract promises UTC calendar buckets and must not inherit the
	// server, role, or pooled-session timezone.
	cfg.ConnConfig.RuntimeParams["timezone"] = "Pacific/Kiritimati"
	cfg.MaxConns = 12
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect growth test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("ping growth test database: %v", err)
	}
	return pool
}

func seedGrowthTenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'growth-db-test', 'growth-db-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed growth tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit growth tenant: %v", err)
	}
}

func cleanupGrowthTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Errorf("open growth cleanup transaction: %v", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
		t.Errorf("delete growth tenant: %v", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		t.Errorf("commit growth cleanup: %v", err)
	}
}

func seedGrowthSubscriber(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	createdAt time.Time,
	status string,
	archived bool,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open subscriber seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	email := fmt.Sprintf("growth-%s@example.test", uuid.NewString())
	var archivedAt any
	if archived {
		archivedAt = time.Now().UTC()
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers
       (tenant_id, email, status, consent_source, created_at, updated_at, archived_at)
VALUES ($1::uuid, $2, $3, 'unknown', $4, clock_timestamp(), $5::timestamptz)
RETURNING id::text`, tenantID, email, status, createdAt, archivedAt).Scan(&id); err != nil {
		t.Fatalf("seed growth subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit growth subscriber: %v", err)
	}
	return id
}

func primaryGrowthAddressID(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, subscriberID string,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open primary-address read transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND is_primary`, tenantID, subscriberID).Scan(&id); err != nil {
		t.Fatalf("load primary growth address: %v", err)
	}
	return id
}

func seedSecondaryGrowthAddress(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, subscriberID string,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open secondary-address seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_emails
       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3, false, 'never_subscribed', false)
RETURNING id::text`, tenantID, subscriberID,
		fmt.Sprintf("growth-secondary-%s@example.test", uuid.NewString())).Scan(&id); err != nil {
		t.Fatalf("seed secondary growth address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit secondary growth address: %v", err)
	}
	return id
}

func recordGrowthEmailDecision(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, subscriberID, addressID, status, operation string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open growth consent transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	subscriber, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("load growth consent subscriber: %v", err)
	}
	address, _, err := lockEmailConsentAddressForRepairByID(
		ctx, tx, tenantID, subscriberID, addressID,
	)
	if err != nil {
		t.Fatalf("lock growth consent address: %v", err)
	}
	if address == nil {
		t.Fatal("growth consent address disappeared")
	}
	now := time.Now().UTC()
	provenance := ConsentProvenanceInput{
		Source:        "direct_request",
		Channel:       "api",
		LegalBasis:    "consent",
		OccurredAt:    &now,
		Jurisdiction:  "UNSPECIFIED",
		Evidence:      "Authenticated growth DB test exact-address decision.",
		Reason:        "Verify canonical audience-growth transition accounting.",
		PolicyVersion: "growth-db-test-v1",
	}
	if err := normalizeConsentProvenance(&provenance, true); err != nil {
		t.Fatalf("normalize growth consent evidence: %v", err)
	}
	if _, err := recordEmailConsentEvidence(
		ctx, tx, tenantID, subscriber, address, status, provenance,
		operation, db.AuditMeta{TenantID: tenantID, ActorType: "system", ActorLabel: "growth-db-test"},
	); err != nil {
		t.Fatalf("record growth consent evidence: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit growth consent evidence: %v", err)
	}
}

func recordUnpairedGrowthOneClick(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, subscriberID string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open unpaired one-click transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_events
       (tenant_id, subject_type, subject_id, subject_email, channel, category,
        action, source, policy_version, preferences, proof_text)
SELECT $1::uuid, 'subscriber', subscriber.email::text, subscriber.email,
       'email', 'email_marketing', 'revoked', 'one_click', 'v1', '{}'::jsonb,
       'growth test: production-style unpaired RFC 8058 withdrawal'
  FROM subscribers AS subscriber
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = $2::uuid`, tenantID, subscriberID); err != nil {
		t.Fatalf("record unpaired one-click withdrawal: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit unpaired one-click withdrawal: %v", err)
	}
}

func putGrowthHistoryPoint(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	date time.Time,
	total, added, unsubbed, lapsed int,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open growth-history seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// UTC midnight is valid for the represented day and is always earlier than
	// a same-day recomputation. This lets the live test prove exact
	// recomputation can replace an inflated v2 seed rather than preserving it.
	evaluatedAt := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_growth_verified_history
       (tenant_id, snapshot_date, evaluated_at, total_count, added_count,
        unsubbed_count, lapsed_count, metric_contract_version)
VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET
    evaluated_at = EXCLUDED.evaluated_at,
    total_count = EXCLUDED.total_count,
    added_count = EXCLUDED.added_count,
    unsubbed_count = EXCLUDED.unsubbed_count,
    lapsed_count = EXCLUDED.lapsed_count,
    metric_contract_version = EXCLUDED.metric_contract_version`, tenantID,
		date.Format("2006-01-02"), evaluatedAt, total, added, unsubbed, lapsed,
		growthMetricContractVersion); err != nil {
		t.Fatalf("seed growth-history point: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit growth-history point: %v", err)
	}
}

func putLegacyGrowthHistoryPoint(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	date time.Time,
	total, added, unsubbed, lapsed int,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open legacy growth-history seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	evaluatedAt := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_growth_history
       (tenant_id, snapshot_date, evaluated_at, total_count, added_count,
        unsubbed_count, lapsed_count)
VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET
    evaluated_at = EXCLUDED.evaluated_at,
    total_count = EXCLUDED.total_count,
    added_count = EXCLUDED.added_count,
    unsubbed_count = EXCLUDED.unsubbed_count,
    lapsed_count = EXCLUDED.lapsed_count`, tenantID, date.Format("2006-01-02"),
		evaluatedAt, total, added, unsubbed, lapsed); err != nil {
		t.Fatalf("seed legacy growth-history point: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy growth-history point: %v", err)
	}
}

// TestAudienceGrowthSnapshotAndWindow_DB proves the production semantics on
// the fully migrated schema: UTC buckets ignore session timezone, archived and
// future-created rows stay outside the active-directory total, unrelated
// blocklisted updates are not fabricated unsubscribe transitions, exact-address
// ledger transitions dedupe by profile and exclude secondary addresses, RLS
// keeps tenants separate, the upsert remains one-row idempotent under
// contention, and the read path rejects corrupt/future persisted facts.
func TestAudienceGrowthSnapshotAndWindow_DB(t *testing.T) {
	pool := newGrowthTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	seedGrowthTenant(t, ctx, pool, tenantA)
	seedGrowthTenant(t, ctx, pool, tenantB)
	t.Cleanup(func() {
		cleanupGrowthTenant(t, pool, tenantA)
		cleanupGrowthTenant(t, pool, tenantB)
	})

	now := time.Now().UTC()
	yesterday := now.AddDate(0, 0, -1)
	// Legacy rows remain intact for audit and rolling compatibility but must be
	// completely invisible to the verified API read path.
	putLegacyGrowthHistoryPoint(t, ctx, pool, tenantA, now, 777, 777, 777, 777)
	repo := &Repo{Pool: pool}
	preCutover, err := repo.GetGrowthHistory(ctx, tenantA, 1)
	if err != nil {
		t.Fatalf("read verified history before first v2 snapshot: %v", err)
	}
	if len(preCutover) != 0 {
		t.Fatalf("legacy history leaked into verified series: %#v", preCutover)
	}
	// Exact same-day values are allowed to decrease when source facts are
	// corrected. The recomputation below must replace this inflated v2 seed.
	putGrowthHistoryPoint(t, ctx, pool, tenantA, now, 999, 999, 999, 0)
	unpairedOneClickSubscriber := seedGrowthSubscriber(t, ctx, pool, tenantA, yesterday, StatusDisabled, false)
	seedGrowthSubscriber(t, ctx, pool, tenantA, now.Add(-time.Second), StatusDisabled, false)
	seedGrowthSubscriber(t, ctx, pool, tenantA, now.Add(-time.Second), StatusDisabled, true)
	// This row reproduces the old false-positive: it is currently blocklisted
	// and updated today, but has no recorded granted→withdrawn transition.
	seedGrowthSubscriber(t, ctx, pool, tenantA, yesterday, StatusBlocklisted, false)
	ledgerSubscriber := seedGrowthSubscriber(t, ctx, pool, tenantA, yesterday, StatusDisabled, false)
	// Persisted future identities are invalid input to an as-of-now snapshot.
	seedGrowthSubscriber(t, ctx, pool, tenantA, now.AddDate(0, 0, 1), StatusDisabled, false)
	// The production RFC-8058 path writes an event plus suppression, not the
	// exact event/proof pair. It is a real withdrawal but intentionally remains
	// outside the verified lower-bound metric and is disclosed via partial_metrics.
	recordUnpairedGrowthOneClick(t, ctx, pool, tenantA, unpairedOneClickSubscriber)

	primaryAddress := primaryGrowthAddressID(t, ctx, pool, tenantA, ledgerSubscriber)
	secondaryAddress := seedSecondaryGrowthAddress(t, ctx, pool, tenantA, ledgerSubscriber)
	recordGrowthEmailDecision(t, ctx, pool, tenantA, ledgerSubscriber, primaryAddress, "subscribed", "channel_consent_email")
	time.Sleep(2 * time.Millisecond)
	recordGrowthEmailDecision(t, ctx, pool, tenantA, ledgerSubscriber, primaryAddress, "unsubscribed", "channel_consent_email")
	time.Sleep(2 * time.Millisecond)
	// A repeated withdrawal is evidence, but not a second state transition.
	recordGrowthEmailDecision(t, ctx, pool, tenantA, ledgerSubscriber, primaryAddress, "unsubscribed", "channel_consent_email")
	time.Sleep(2 * time.Millisecond)
	// A secondary address transition must not fan out the profile-level metric.
	recordGrowthEmailDecision(t, ctx, pool, tenantA, ledgerSubscriber, secondaryAddress, "subscribed", "multi_email_address_consent")
	time.Sleep(2 * time.Millisecond)
	recordGrowthEmailDecision(t, ctx, pool, tenantA, ledgerSubscriber, secondaryAddress, "unsubscribed", "multi_email_address_consent")

	otherSubscriber := seedGrowthSubscriber(t, ctx, pool, tenantB, yesterday, StatusDisabled, false)
	otherAddress := primaryGrowthAddressID(t, ctx, pool, tenantB, otherSubscriber)
	recordGrowthEmailDecision(t, ctx, pool, tenantB, otherSubscriber, otherAddress, "subscribed", "channel_consent_email")
	time.Sleep(2 * time.Millisecond)
	recordGrowthEmailDecision(t, ctx, pool, tenantB, otherSubscriber, otherAddress, "unsubscribed", "channel_consent_email")

	const writers = 8
	var wg sync.WaitGroup
	errCh := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- repo.snapshotGrowthForTenant(ctx, tenantA)
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("concurrent snapshot: %v", err)
		}
	}
	if err := repo.snapshotGrowthForTenant(ctx, tenantB); err != nil {
		t.Fatalf("snapshot tenant B: %v", err)
	}

	seriesA, err := repo.GetGrowthHistory(ctx, tenantA, 1)
	if err != nil {
		t.Fatalf("read tenant A one-day growth: %v", err)
	}
	if len(seriesA) != 1 {
		t.Fatalf("tenant A one-day series length = %d, want 1", len(seriesA))
	}
	today := now.Format("2006-01-02")
	point := seriesA[0]
	if point.Date != today {
		t.Fatalf("snapshot date = %s, want UTC date %s (pool timezone is Pacific/Kiritimati)", point.Date, today)
	}
	if point.Total != 4 || point.Added != 1 || point.Unsubbed != 1 || point.Lapsed != 0 {
		t.Fatalf("tenant A point = %#v, want total=4 added=1 unsubbed=1 lapsed=0", point)
	}
	// Simulate a draining old binary writing its legacy ON CONFLICT row after
	// v2 is already live. Physical isolation must leave the verified fact
	// unchanged; a same-table version flag cannot make this guarantee.
	putLegacyGrowthHistoryPoint(t, ctx, pool, tenantA, now, 888, 888, 888, 888)
	rollingSafe, err := repo.GetGrowthHistory(ctx, tenantA, 1)
	if err != nil {
		t.Fatalf("read verified history after legacy rolling writer: %v", err)
	}
	if len(rollingSafe) != 1 || rollingSafe[0] != point {
		t.Fatalf("legacy rolling writer changed verified point: before=%#v after=%#v", point, rollingSafe)
	}

	// Later same-day identity maintenance must not erase an already recorded
	// unsubscribe flow. Rotate the canonical address, delete a secondary
	// address, and archive the profile, then recompute from the immutable
	// event/proof binding. Total legitimately falls by one; unsubbed does not.
	identityTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open growth identity-maintenance transaction: %v", err)
	}
	rotatedEmail := fmt.Sprintf("growth-rotated-%s@example.test", uuid.NewString())
	if _, err := identityTx.Exec(ctx, `
UPDATE subscribers
   SET email=$3, primary_email=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, ledgerSubscriber, rotatedEmail); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("rotate growth subscriber address: %v", err)
	}
	if _, err := identityTx.Exec(ctx, `
DELETE FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND id=$3::uuid AND NOT is_primary`,
		tenantA, ledgerSubscriber, secondaryAddress); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("delete growth secondary address: %v", err)
	}
	if _, err := identityTx.Exec(ctx, `
UPDATE subscribers SET archived_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantA, ledgerSubscriber); err != nil {
		_ = identityTx.Rollback(ctx)
		t.Fatalf("archive growth subscriber: %v", err)
	}
	if err := identityTx.Commit(ctx); err != nil {
		t.Fatalf("commit growth identity maintenance: %v", err)
	}
	persistedPoint, err := repo.snapshotGrowthPointForTenant(ctx, tenantA)
	if err != nil {
		t.Fatalf("snapshot after identity maintenance: %v", err)
	}
	if persistedPoint == nil || persistedPoint.Date != today ||
		persistedPoint.Total != 3 || persistedPoint.Unsubbed != 1 {
		t.Fatalf("point after identity maintenance = %#v, want UTC today total=3/unsubbed=1", persistedPoint)
	}

	deps := &Deps{Repo: repo}
	snapshotReq := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/growth/snapshot", nil)
	snapshotReq = snapshotReq.WithContext(middleware.WithTenant(snapshotReq.Context(), &middleware.Tenant{ID: tenantA}))
	snapshotRec := httptest.NewRecorder()
	deps.SnapshotGrowth(snapshotRec, snapshotReq)
	if snapshotRec.Code != http.StatusOK ||
		!strings.Contains(snapshotRec.Body.String(), `"point":{`) ||
		!strings.Contains(snapshotRec.Body.String(), `"metric_contract_version":"verified-exact-ledger-v2"`) ||
		!strings.Contains(snapshotRec.Body.String(), `"unavailable_metrics":["lapsed"]`) ||
		!strings.Contains(snapshotRec.Body.String(), `"partial_metrics":["unsubbed"]`) ||
		!strings.Contains(snapshotRec.Body.String(), `"note":`) {
		t.Fatalf("snapshot response status=%d body=%s", snapshotRec.Code, snapshotRec.Body.String())
	}
	growthReq := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/growth?days=1", nil)
	growthReq = growthReq.WithContext(middleware.WithTenant(growthReq.Context(), &middleware.Tenant{ID: tenantA}))
	growthRec := httptest.NewRecorder()
	deps.Growth(growthRec, growthReq)
	if growthRec.Code != http.StatusOK ||
		!strings.Contains(growthRec.Body.String(), `"days":1`) ||
		!strings.Contains(growthRec.Body.String(), `"metric_contract_version":"verified-exact-ledger-v2"`) ||
		!strings.Contains(growthRec.Body.String(), `"unavailable_metrics":["lapsed"]`) ||
		!strings.Contains(growthRec.Body.String(), `"partial_metrics":["unsubbed"]`) {
		t.Fatalf("growth response status=%d body=%s", growthRec.Code, growthRec.Body.String())
	}

	seriesB, err := repo.GetGrowthHistory(ctx, tenantB, 1)
	if err != nil {
		t.Fatalf("read tenant B one-day growth: %v", err)
	}
	if len(seriesB) != 1 || seriesB[0].Total != 1 || seriesB[0].Unsubbed != 1 {
		t.Fatalf("tenant B series = %#v, want isolated total=1/unsubbed=1", seriesB)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open idempotency verification: %v", err)
	}
	var rows int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_growth_verified_history WHERE tenant_id = $1::uuid`, tenantA).Scan(&rows); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("count idempotent snapshot rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("concurrent/repeated snapshots wrote %d rows, want exactly 1", rows)
	}
	var legacyRows int
	var legacyVersion string
	var legacyUnsubbed int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*), min(metric_contract_version), max(unsubbed_count)
  FROM subscriber_growth_history
 WHERE tenant_id = $1::uuid`, tenantA).Scan(
		&legacyRows, &legacyVersion, &legacyUnsubbed,
	); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("read retained legacy growth row: %v", err)
	}
	if legacyRows != 1 || legacyVersion != "legacy-heuristic-v1" || legacyUnsubbed != 888 {
		t.Fatalf("legacy audit row changed: rows=%d version=%q unsubbed=%d", legacyRows, legacyVersion, legacyUnsubbed)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit idempotency verification: %v", err)
	}

	dayBeforeYesterday := now.AddDate(0, 0, -2)
	tomorrow := now.AddDate(0, 0, 1)
	putGrowthHistoryPoint(t, ctx, pool, tenantA, yesterday, 3, 2, 1, 0)
	putGrowthHistoryPoint(t, ctx, pool, tenantA, dayBeforeYesterday, 2, 1, 0, 0)
	putGrowthHistoryPoint(t, ctx, pool, tenantA, tomorrow, 999, 999, 999, 0)
	twoDays, err := repo.GetGrowthHistory(ctx, tenantA, 2)
	if err != nil {
		t.Fatalf("read exact two-day window: %v", err)
	}
	if len(twoDays) != 2 || twoDays[0].Date != yesterday.Format("2006-01-02") || twoDays[1].Date != today {
		t.Fatalf("two-day UTC window = %#v, want exactly yesterday+today", twoDays)
	}
	response, err := assembleGrowthResponse(2, twoDays)
	if err != nil {
		t.Fatalf("assemble two-day response: %v", err)
	}
	if response.TotalAdded != twoDays[0].Added+twoDays[1].Added ||
		response.TotalUnsubbed != twoDays[0].Unsubbed+twoDays[1].Unsubbed ||
		response.Delta != twoDays[1].Total-twoDays[0].Total {
		t.Fatalf("response arithmetic diverged: response=%#v series=%#v", response, twoDays)
	}

	rejectHistoryMutation := func(query string) {
		t.Helper()
		tx, txErr := db.WithTenant(ctx, pool, tenantA)
		if txErr != nil {
			t.Fatalf("open corrupt-history transaction: %v", txErr)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, txErr = tx.Exec(ctx, query, tenantA, yesterday.Format("2006-01-02")); txErr == nil {
			t.Fatalf("verified-history constraint accepted corrupt mutation: %s", query)
		}
	}
	rejectHistoryMutation(`UPDATE subscriber_growth_verified_history SET lapsed_count=1 WHERE tenant_id=$1::uuid AND snapshot_date=$2::date`)
	rejectHistoryMutation(`UPDATE subscriber_growth_verified_history SET evaluated_at=clock_timestamp()+interval '1 day' WHERE tenant_id=$1::uuid AND snapshot_date=$2::date`)
	rejectHistoryMutation(`UPDATE subscriber_growth_verified_history SET added_count=-1 WHERE tenant_id=$1::uuid AND snapshot_date=$2::date`)
	rejectHistoryMutation(`UPDATE subscriber_growth_verified_history SET metric_contract_version='legacy-heuristic-v1' WHERE tenant_id=$1::uuid AND snapshot_date=$2::date`)
	if finalSeries, err := repo.GetGrowthHistory(ctx, tenantA, 2); err != nil || len(finalSeries) != 2 {
		t.Fatalf("verified series changed after rejected corruption: series=%#v err=%v", finalSeries, err)
	}
}
