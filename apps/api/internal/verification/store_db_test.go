// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the verification store, cache, and job runner.
// Skip without DATABASE_URL (the established pg-backed pattern).
//
// These run as the NON-PRIVILEGED postwave_app role wherever the
// DATABASE_URL says so, which is what makes the RLS assertions
// meaningful — a superuser connection bypasses RLS entirely and would
// turn every isolation test into a false pass.

package verification

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func verificationDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed verification tests")
	}
	pool, err := db.New(context.Background(), url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// newTenant creates a throwaway tenant and registers its teardown.
// Every verification_* table cascades on tenant_id, so deleting the
// tenant is the whole cleanup.
func newTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	id := insertTenant(t, pool)
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		ctx2, err := db.WithTenant(cleanupCtx, pool, id)
		if err != nil {
			return
		}
		defer func() { _ = ctx2.Rollback(cleanupCtx) }()
		_, _ = ctx2.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
		_ = ctx2.Commit(cleanupCtx)
	})
	return id
}

// insertTenant creates a throwaway tenant without registering a teardown.
//
// The tenants table is itself RLS-protected, so the id is minted
// client-side and the GUC bound to it before the INSERT — the same
// pattern the other pg-backed suites use.
func insertTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	slug := "vt-" + hex.EncodeToString(buf)
	id := uuid.NewString()

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, id)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		id, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	return id
}

func newStore(t *testing.T, pool *db.Pool, secrets SecretResolver) *Store {
	t.Helper()
	return &Store{Pool: pool, Secrets: secrets}
}

func mustTenantVerificationSecretName(t *testing.T, tenantID, provider, credentialID string) string {
	t.Helper()
	name, err := tenantVerificationSecretName(tenantID, provider, credentialID)
	if err != nil {
		t.Fatalf("tenantVerificationSecretName: %v", err)
	}
	return name
}

func TestDBUpsertAndReadProviderConfig(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	saved, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider:      ProviderZeroBounce,
		CredentialRef: "zb-primary",
		Enabled:       true,
		Settings:      ProviderSettings{CacheTTLDays: 45, DegradeOnFailure: true},
	})
	if err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	if saved.Provider != ProviderZeroBounce || !saved.Enabled {
		t.Fatalf("saved = %+v", saved)
	}
	if saved.Settings.CacheTTLDays != 45 || !saved.Settings.DegradeOnFailure {
		t.Fatalf("settings did not round-trip through JSONB: %+v", saved.Settings)
	}

	got, err := s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if got == nil || got.CredentialRef != "zb-primary" {
		t.Fatalf("EnabledProvider = %+v", got)
	}
}

func TestDBConfigureProviderPersistsProbedBalanceAndNormalizedSettings(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secretName := mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "zb-probed")
	s := newStore(t, pool, &fakeSecrets{values: map[string]string{secretName: "zb-key"}})
	s.vendorFactory = func(cfg ProviderConfig, key string) (Verifier, error) {
		if key != "zb-key" || cfg.Settings.IPAddress != "2001:db8::1" {
			t.Fatalf("staged provider cfg=%+v key=%q", cfg, key)
		}
		return &fakeVerifier{name: ProviderZeroBounce, credits: 321}, nil
	}

	saved, err := s.ConfigureProvider(context.Background(), tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-probed", Enabled: true,
		Settings: ProviderSettings{IPAddress: "  2001:db8::1  ", CacheTTLDays: 30},
	})
	if err != nil {
		t.Fatalf("ConfigureProvider: %v", err)
	}
	if saved.LastBalance == nil || *saved.LastBalance != 321 || saved.LastBalanceAt == nil {
		t.Fatalf("saved probed balance = %+v", saved)
	}
	if saved.Settings.IPAddress != "2001:db8::1" {
		t.Fatalf("saved IPAddress=%q, want normalized address", saved.Settings.IPAddress)
	}
}

func TestDBEnabledProviderReturnsNilWhenUnconfigured(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	got, err := s.EnabledProvider(context.Background(), tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil for an unconfigured tenant", got)
	}
}

func TestDBEnablingSecondProviderDisablesTheFirst(t *testing.T) {
	// The schema allows at most one enabled provider per tenant. If
	// UpsertProvider did not disable the incumbent, this would fail
	// with a unique-violation instead of switching vendors.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderKickbox, CredentialRef: "kb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	active, err := s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if active == nil || active.Provider != ProviderKickbox {
		t.Fatalf("active provider = %+v, want kickbox", active)
	}

	all, err := s.ListProviders(ctx, tenant)
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("ListProviders returned %d, want 2 (both retained, one disabled)", len(all))
	}
	enabled := 0
	for _, p := range all {
		if p.Enabled {
			enabled++
		}
	}
	if enabled != 1 {
		t.Fatalf("%d providers enabled, want exactly 1", enabled)
	}
}

func TestDBProviderConfigIsTenantIsolated(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenantA, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "tenant-a-key", Enabled: true,
	}); err != nil {
		t.Fatalf("upsert for A: %v", err)
	}

	got, err := s.EnabledProvider(ctx, tenantB)
	if err != nil {
		t.Fatalf("EnabledProvider(B): %v", err)
	}
	if got != nil {
		t.Fatalf("tenant B can see tenant A's provider config: %+v", got)
	}
	listed, err := s.ListProviders(ctx, tenantB)
	if err != nil {
		t.Fatalf("ListProviders(B): %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("tenant B listed %d of tenant A's configs", len(listed))
	}
}

func TestDBRecordBalanceAndErrorRoundTrip(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := s.RecordBalance(ctx, tenant, ProviderZeroBounce, 4242); err != nil {
		t.Fatalf("RecordBalance: %v", err)
	}

	got, err := s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if got.LastBalance == nil || *got.LastBalance != 4242 {
		t.Fatalf("LastBalance = %v, want 4242", got.LastBalance)
	}
	if got.LastBalanceAt == nil {
		t.Fatal("LastBalanceAt not set")
	}

	s.RecordProviderError(ctx, tenant, ProviderZeroBounce, fmt.Errorf("credential detail that must not persist: %w", ErrUnauthorized))
	got, err = s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if got.LastError != "provider_unauthorized" {
		t.Fatalf("LastError = %q", got.LastError)
	}
}

func TestDBChangingCredentialRefClearsStaleErrorAndBalance(t *testing.T) {
	// Otherwise the settings screen shows a "bad key" banner next to
	// a key the operator has just replaced.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "old-key", Enabled: true,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	_ = s.RecordBalance(ctx, tenant, ProviderZeroBounce, 10)
	s.RecordProviderError(ctx, tenant, ProviderZeroBounce, errors.New("bad key"))

	saved, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "new-key", Enabled: true,
	})
	if err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	if saved.LastError != "" {
		t.Fatalf("LastError = %q, want cleared after a credential change", saved.LastError)
	}
	if saved.LastBalance != nil {
		t.Fatalf("LastBalance = %v, want cleared after a credential change", *saved.LastBalance)
	}
}

func TestDBDeleteProviderReportsWhetherAnythingWasRemoved(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderKickbox, CredentialRef: "kb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	removed, err := s.DeleteProvider(ctx, tenant, ProviderKickbox)
	if err != nil {
		t.Fatalf("DeleteProvider: %v", err)
	}
	if !removed {
		t.Fatal("DeleteProvider reported nothing removed")
	}
	removed, err = s.DeleteProvider(ctx, tenant, ProviderKickbox)
	if err != nil {
		t.Fatalf("second DeleteProvider: %v", err)
	}
	if removed {
		t.Fatal("DeleteProvider reported a removal for a row that no longer exists")
	}
}

func TestDBUpsertRejectsUnknownProviderBeforeTouchingTheDatabase(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	if _, err := s.UpsertProvider(context.Background(), tenant, ProviderConfig{
		Provider: "sendgrid", CredentialRef: "ref-x", Enabled: true,
	}); err == nil {
		t.Fatal("expected an error for an unknown provider")
	}
}

// --- cache ---

func newCache(t *testing.T, s *Store, tenant string) *TenantCache {
	t.Helper()
	return &TenantCache{Store: s, TenantID: tenant, TTL: DefaultCacheTTL}
}

func TestDBCachePutThenGetRoundTrip(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)
	ctx := context.Background()

	score := 7
	in := Result{
		Email: "person@example.com", Status: StatusCatchAll, SubStatus: SubStatusAcceptAll,
		Score: &score, Domain: "example.com", FreeEmail: true, MXFound: true,
		MXRecord: "mx.example.com", FirstName: "Ada", LastName: "Lovelace",
		Gender: "female", Country: "UK", City: "London",
		Provider: ProviderZeroBounce, CheckedAt: time.Now().UTC().Truncate(time.Second),
	}
	if err := c.Put(ctx, []Result{in}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := c.Get(ctx, []string{"person@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	hit, ok := got["person@example.com"]
	if !ok {
		t.Fatal("cache miss immediately after a write")
	}
	if hit.Status != StatusCatchAll || hit.SubStatus != SubStatusAcceptAll {
		t.Fatalf("status round trip: %+v", hit)
	}
	if hit.Score == nil || *hit.Score != 7 {
		t.Fatalf("Score = %v, want 7", hit.Score)
	}
	if hit.FirstName != "Ada" || hit.City != "London" {
		t.Fatalf("enrichment round trip: %+v", hit)
	}
}

func TestDBCachePutRejectsAnEmptyNormalizedIdentity(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	cache := newCache(t, newStore(t, pool, nil), tenant)

	err := cache.Put(context.Background(), []Result{{
		Email: " \t", Status: StatusUnknown, Provider: ProviderLocal,
	}})
	if err == nil {
		t.Fatal("Put accepted an empty normalized cache identity")
	}
}

func TestDBCacheMatchesRegardlessOfAddressCasing(t *testing.T) {
	// A list re-imported with different casing must still hit; if it
	// did not, the whole list would be re-verified at full price.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)
	ctx := context.Background()

	if err := c.Put(ctx, []Result{{
		Email: "Person@Example.COM", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := c.Get(ctx, []string{"PERSON@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	hit, ok := got["PERSON@example.com"]
	if !ok {
		t.Fatalf("cache miss across casing; got keys %v", got)
	}
	// The returned key must be the caller's spelling, because that is
	// what the chain looks up.
	if hit.Email != "PERSON@example.com" {
		t.Fatalf("Email = %q, want the caller's spelling", hit.Email)
	}
}

func TestDBCacheIgnoresExpiredEntries(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	past := &TenantCache{
		Store: s, TenantID: tenant, TTL: time.Hour,
		Now: func() time.Time { return time.Now().UTC().Add(-48 * time.Hour) },
	}
	if err := past.Put(ctx, []Result{{
		Email: "stale@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	live := newCache(t, s, tenant)
	got, err := live.Get(ctx, []string{"stale@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expired entry was served: %+v", got)
	}
}

func TestDBCachePutCollapsesDuplicateAddressesInOneBatch(t *testing.T) {
	// Postgres rejects an INSERT whose ON CONFLICT target is hit twice
	// in a single statement, and real batches do contain duplicates.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)

	err := c.Put(context.Background(), []Result{
		{Email: "dup@example.com", Status: StatusValid, Provider: ProviderZeroBounce},
		{Email: "DUP@example.com", Status: StatusInvalid, Provider: ProviderZeroBounce},
	})
	if err != nil {
		t.Fatalf("Put with duplicates: %v", err)
	}
}

func TestDBCacheIsTenantIsolated(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	if err := newCache(t, s, tenantA).Put(ctx, []Result{{
		Email: "secret@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := newCache(t, s, tenantB).Get(ctx, []string{"secret@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("tenant B read tenant A's cached verdict: %+v", got)
	}
}

func TestDBCacheInvalidateForcesRecheck(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)
	ctx := context.Background()

	if err := c.Put(ctx, []Result{{
		Email: "a@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	n, err := c.Invalidate(ctx, []string{"A@Example.com"})
	if err != nil {
		t.Fatalf("Invalidate: %v", err)
	}
	if n != 1 {
		t.Fatalf("Invalidate removed %d rows, want 1 (casing must not matter)", n)
	}
	got, err := c.Get(ctx, []string{"a@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("entry survived invalidation")
	}
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin snapshot assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var snapshots int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM email_health_snapshots
 WHERE tenant_id=$1::uuid AND email='a@example.com'`, tenant).Scan(&snapshots); err != nil {
		t.Fatalf("count snapshots: %v", err)
	}
	if snapshots != 1 {
		t.Fatalf("derived health snapshot count after cache invalidation = %d, want 1", snapshots)
	}
}

func TestDBCacheSummaryGroupsByStatus(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)
	ctx := context.Background()

	if err := c.Put(ctx, []Result{
		{Email: "a@example.com", Status: StatusValid, Provider: ProviderZeroBounce},
		{Email: "b@example.com", Status: StatusValid, Provider: ProviderZeroBounce},
		{Email: "c@example.com", Status: StatusInvalid, Provider: ProviderZeroBounce},
	}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	sum, err := c.Summary(ctx)
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if sum.Total != 3 {
		t.Fatalf("Total = %d, want 3", sum.Total)
	}
	if sum.ByStatus["valid"] != 2 || sum.ByStatus["invalid"] != 1 {
		t.Fatalf("ByStatus = %v", sum.ByStatus)
	}
}

func TestDBCacheRejectsStatusOutsideTheClosedSet(t *testing.T) {
	// The CHECK constraint is the last line of defence if a driver
	// mapping ever lets an unmapped vendor string through.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	c := newCache(t, s, tenant)

	err := c.Put(context.Background(), []Result{{
		Email: "x@example.com", Status: Status("totally_made_up"), Provider: ProviderZeroBounce,
	}})
	if err == nil {
		t.Fatal("the database accepted a status outside the closed set")
	}
}

func TestDBUsageRollupAccumulatesAcrossBatches(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	first := ChainStats{Total: 10, CreditsSpent: 6, LocalFiltered: 3, CacheHits: 1}
	second := ChainStats{Total: 5, CreditsSpent: 2, LocalFiltered: 2, CacheHits: 1}
	if err := s.RecordUsage(ctx, tenant, ProviderZeroBounce, first); err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}
	if err := s.RecordUsage(ctx, tenant, ProviderZeroBounce, second); err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}

	points, err := s.Usage(ctx, tenant, 7)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if len(points) != 1 {
		t.Fatalf("got %d points, want 1 day", len(points))
	}
	if points[0].Verified != 15 || points[0].CreditsSpent != 8 {
		t.Fatalf("rollup did not accumulate: %+v", points[0])
	}
	if points[0].LocalFiltered != 5 || points[0].CacheHits != 2 {
		t.Fatalf("rollup did not accumulate savings: %+v", points[0])
	}
}

func TestDBPurgeExpiredRemovesOnlyExpiredRows(t *testing.T) {
	pool, admin, tenant := purgeDB(t)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	stale := &TenantCache{
		Store: s, TenantID: tenant, TTL: time.Hour,
		Now: func() time.Time { return time.Now().UTC().Add(-48 * time.Hour) },
	}
	if err := stale.Put(ctx, []Result{{
		Email: "old@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put stale: %v", err)
	}
	if err := stale.Put(ctx, []Result{{
		Email: "terminal@example.com", Status: StatusInvalid,
		SubStatus: SubStatusMailboxNotFound, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put stale terminal: %v", err)
	}
	live := newCache(t, s, tenant)
	if err := live.Put(ctx, []Result{{
		Email: "new@example.com", Status: StatusValid, Provider: ProviderZeroBounce,
	}}); err != nil {
		t.Fatalf("Put live: %v", err)
	}

	run := purgeOwnRows(t, s, admin, tenant, 1000)
	if run.removed != 1 {
		t.Fatalf("PurgeExpired removed %d rows, want exactly 1 expired row", run.removed)
	}
	// Only the expired reusable verdict goes. The live verdict, the expired
	// terminal verdict still inside retention, and every derived health
	// snapshot the three writes materialized all stay.
	requirePurgeRemoved(t, run.gone, purgeFootprint{
		"verification_cache": {"old@example.com"},
	})

	got, err := live.Get(ctx, []string{"new@example.com"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got) != 1 {
		t.Fatal("PurgeExpired removed a live entry")
	}

	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin retained-terminal read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var retained int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM verification_cache
 WHERE tenant_id=$1::uuid AND email='terminal@example.com'
   AND status='invalid' AND expires_at <= now()`, tenant).Scan(&retained); err != nil {
		t.Fatalf("read retained terminal cache: %v", err)
	}
	if retained != 1 {
		t.Fatalf("retained terminal cache rows = %d, want 1", retained)
	}
}

func TestDBPurgeExpiredBoundsTerminalAndDerivedAddressEvidence(t *testing.T) {
	pool, admin, tenant := purgeDB(t)
	s := newStore(t, pool, nil)
	ctx := context.Background()
	ancient := time.Now().UTC().Add(-VerificationEvidenceRetention - 48*time.Hour)

	cache := &TenantCache{Store: s, TenantID: tenant, TTL: time.Hour, Now: func() time.Time { return ancient }}
	if err := cache.Put(ctx, []Result{{
		Email: "ancient-invalid@example.com", Status: StatusInvalid,
		SubStatus: SubStatusMailboxNotFound, Provider: ProviderZeroBounce, CheckedAt: ancient,
	}}); err != nil {
		t.Fatalf("Put ancient terminal: %v", err)
	}
	createdBy := uuid.NewString()
	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"ancient-job@example.com"},
		SourceRef: "retention-source", IdempotencyKey: "retention-job-key",
		CreatedBy: &createdBy,
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	healthDBExec(t, pool, tenant, `
UPDATE verification_jobs
   SET status='canceled', completed_at=$3, source_ref='retention-source'
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenant, job.ID, ancient)

	run := purgeOwnRows(t, s, admin, tenant, 1000)
	if run.removed != 3 {
		t.Fatalf("PurgeExpired removed %d PII rows, want cache + snapshot + job item", run.removed)
	}
	requirePurgeRemoved(t, run.gone, purgeFootprint{
		"verification_cache":     {"ancient-invalid@example.com"},
		"email_health_snapshots": {"ancient-invalid@example.com"},
		"verification_job_items": {job.ID + " ancient-job@example.com"},
	})

	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin retention assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cacheRows, snapshotRows, itemRows int
	var sourceRef, idempotencyKey, fingerprint string
	var retainedCreatedBy *string
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM verification_cache WHERE tenant_id=$1::uuid`, tenant).Scan(&cacheRows); err != nil {
		t.Fatalf("count cache: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM email_health_snapshots WHERE tenant_id=$1::uuid`, tenant).Scan(&snapshotRows); err != nil {
		t.Fatalf("count snapshots: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM verification_job_items WHERE tenant_id=$1::uuid AND job_id=$2::uuid`, tenant, job.ID).Scan(&itemRows); err != nil {
		t.Fatalf("count job items: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT source_ref, idempotency_key, request_fingerprint, created_by::text
  FROM verification_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenant, job.ID).
		Scan(&sourceRef, &idempotencyKey, &fingerprint, &retainedCreatedBy); err != nil {
		t.Fatalf("read scrubbed job: %v", err)
	}
	if cacheRows != 0 || snapshotRows != 0 || itemRows != 0 {
		t.Fatalf("retained rows cache=%d snapshots=%d items=%d", cacheRows, snapshotRows, itemRows)
	}
	if sourceRef != "" || idempotencyKey != "" || fingerprint != "" {
		t.Fatalf("terminal job metadata not scrubbed: ref=%q key=%q fingerprint=%q", sourceRef, idempotencyKey, fingerprint)
	}
	if retainedCreatedBy != nil {
		t.Fatalf("terminal job actor metadata not scrubbed: created_by=%q", *retainedCreatedBy)
	}
}

func TestDBPurgeExpiredDeletesExpiredSignupAttemptReceipts(t *testing.T) {
	pool, admin, tenant := purgeDB(t)
	s := newStore(t, pool, nil)
	ctx := context.Background()
	formID := newVerificationSignupForm(t, s, tenant)
	claim, err := s.beginSignupAttempt(
		ctx, tenant, formID, "expired@example.com", "opaque-expired-attempt-01",
		signupFingerprint("expired"),
	)
	if err != nil || !claim.IdentityOwner || claim.Attempt.State != signupAttemptStatePending {
		t.Fatalf("beginSignupAttempt claim=%+v err=%v", claim, err)
	}

	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin receipt expiry: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE verification_signup_attempts
   SET created_at = now() - interval '23 hours',
       expires_at = now() - interval '1 minute'
 WHERE tenant_id=$1::uuid AND form_id=$2::uuid`, tenant, formID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("expire attempt receipt: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE verification_signup_identities
   SET created_at = now() - interval '23 hours',
       expires_at = now() - interval '1 minute'
 WHERE tenant_id=$1::uuid`, tenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("expire identity receipt: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit receipt expiry: %v", err)
	}

	run := purgeOwnRows(t, s, admin, tenant, 1)
	if run.removed != 1 {
		t.Fatalf("PurgeExpired removed %d rows, want the one expired signup identity", run.removed)
	}
	// Every receipt the fixture seeded goes, and nothing else: the identity is
	// deleted and its attempt cascades with it.
	seededIdentities := run.before["verification_signup_identities"]
	seededAttempts := run.before["verification_signup_attempts"]
	if len(seededIdentities) != 1 || len(seededAttempts) != 1 {
		t.Fatalf("fixture seeded identities=%q attempts=%q, want one of each", seededIdentities, seededAttempts)
	}
	requirePurgeRemoved(t, run.gone, purgeFootprint{
		"verification_signup_identities": seededIdentities,
		"verification_signup_attempts":   seededAttempts,
	})
	readTx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin receipt count: %v", err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	var attempts, identities int
	if err := readTx.QueryRow(ctx, `
SELECT count(*) FROM verification_signup_attempts
 WHERE tenant_id=$1::uuid AND form_id=$2::uuid`, tenant, formID).Scan(&attempts); err != nil {
		t.Fatalf("count attempt receipts: %v", err)
	}
	if err := readTx.QueryRow(ctx, `
SELECT count(*) FROM verification_signup_identities
 WHERE tenant_id=$1::uuid`, tenant).Scan(&identities); err != nil {
		t.Fatalf("count identity receipts: %v", err)
	}
	if attempts != 0 || identities != 0 {
		t.Fatalf("expired signup receipts retained attempts=%d identities=%d", attempts, identities)
	}
}

func TestDBPurgeExpiredBoundsTerminalJobMetadataScrub(t *testing.T) {
	pool, admin, tenant := purgeDB(t)
	s := newStore(t, pool, nil)
	ctx := context.Background()
	ancient := time.Now().UTC().Add(-VerificationEvidenceRetention - 48*time.Hour)

	for i := 0; i < 2; i++ {
		job, err := s.CreateJob(ctx, tenant, JobSpec{
			Source: JobSourceInline, Emails: []string{fmt.Sprintf("bounded-%d@example.com", i)},
			SourceRef:      fmt.Sprintf("bounded-source-%d", i),
			IdempotencyKey: fmt.Sprintf("bounded-key-%d", i),
		})
		if err != nil {
			t.Fatalf("CreateJob(%d): %v", i, err)
		}
		healthDBExec(t, pool, tenant, `
UPDATE verification_jobs
   SET status='canceled', completed_at=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenant, job.ID, ancient)
	}

	run := purgeOwnRows(t, s, admin, tenant, 1)
	// The same limit bounds the terminal item delete: exactly one of the two
	// ancient jobs' items goes, and nothing else. LIMIT without ORDER BY may
	// pick either item; which one is not part of the contract.
	boundedItems := run.gone["verification_job_items"]
	if len(run.before["verification_job_items"]) != 2 || len(boundedItems) != 1 {
		t.Fatalf("bounded item delete removed %q of %q, want exactly one",
			boundedItems, run.before["verification_job_items"])
	}
	requirePurgeRemoved(t, run.gone, purgeFootprint{"verification_job_items": boundedItems})
	if run.removed != 1 {
		t.Fatalf("PurgeExpired removed %d rows, want the one bounded job item", run.removed)
	}
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin scrub count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var scrubbed, retained int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE source_ref=''),
       count(*) FILTER (WHERE source_ref<>'')
  FROM verification_jobs
 WHERE tenant_id=$1::uuid AND status='canceled'`, tenant).Scan(&scrubbed, &retained); err != nil {
		t.Fatalf("count bounded scrubs: %v", err)
	}
	if scrubbed != 1 || retained != 1 {
		t.Fatalf("bounded metadata scrub scrubbed=%d retained=%d, want 1/1", scrubbed, retained)
	}
}

func TestDBBuildChainUsesConfiguredVendorAndCache(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "zb-primary"): "zb-key",
	}}
	s := newStore(t, pool, secrets)
	ctx := context.Background()

	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	chain, err := s.BuildChain(ctx, tenant)
	if err != nil {
		t.Fatalf("BuildChain: %v", err)
	}
	if chain.Vendor == nil || chain.Vendor.Name() != ProviderZeroBounce {
		t.Fatalf("Vendor = %v", chain.Vendor)
	}
	if chain.Cache == nil {
		t.Fatal("Cache = nil; a pool-backed chain must be cached")
	}
	if chain.Local == nil {
		t.Fatal("Local = nil")
	}
}
