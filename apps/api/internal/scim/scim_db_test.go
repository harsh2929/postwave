// SPDX-License-Identifier: AGPL-3.0-only
//
// SCIM token-mint integration test. The pure-function tests cover the
// SCIM filter parser; this one exercises the DB path that production
// SCIM clients hit on every authenticated request:
//
//   1. MintToken writes a sha256(token) row to scim_tokens.
//   2. The bearerAuth middleware re-hashes the bearer and looks the
//      row up — both halves must produce identical sha256 bytes.

package scim

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

func newSCIMTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed scim tests")
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

func seedSCIMTenant(t *testing.T, pool *pgxpool.Pool) (string, func()) {
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
		id, "scim-test-"+randHex(t), "SCIM test"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = conn.Exec(ctx, `DELETE FROM scim_tokens WHERE tenant_id = $1::uuid`, id)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	}
	return id, cleanup
}

// MintToken must persist a sha256(raw) row whose bytes match an
// independent re-hash of the returned raw token. This is the
// exact invariant the bearerAuth middleware relies on.
func TestMintToken_PersistsHashedToken(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanup := seedSCIMTenant(t, pool)
	defer cleanup()

	raw, prefix, err := MintToken(context.Background(), pool, tenantID, "", "ci test")
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("MintToken returned empty raw token")
	}
	if len(prefix) != 8 {
		t.Errorf("prefix=%q want 8-char prefix", prefix)
	}
	if !startsWith(raw, prefix) {
		t.Errorf("prefix %q is not a prefix of raw token %q", prefix, raw)
	}

	// Verify the stored sha256 matches an independent re-hash.
	want := sha256.Sum256([]byte(raw))

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var got []byte
	err = tx.QueryRow(context.Background(),
		`SELECT token_sha256 FROM scim_tokens
		   WHERE tenant_id = $1::uuid AND token_prefix = $2`,
		tenantID, prefix).Scan(&got)
	if err != nil {
		t.Fatalf("read back token: %v", err)
	}
	if string(got) != string(want[:]) {
		t.Errorf("stored sha256 does not match re-hash of raw token")
	}
}

// Two mints for the same tenant must produce different prefixes (and
// different raw tokens). Verifies the randomToken source has enough
// entropy + isn't deterministic.
func TestMintToken_UniqueAcrossCalls(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanup := seedSCIMTenant(t, pool)
	defer cleanup()

	raw1, prefix1, err := MintToken(context.Background(), pool, tenantID, "", "first")
	if err != nil {
		t.Fatalf("first MintToken: %v", err)
	}
	raw2, prefix2, err := MintToken(context.Background(), pool, tenantID, "", "second")
	if err != nil {
		t.Fatalf("second MintToken: %v", err)
	}
	if raw1 == raw2 {
		t.Error("two MintToken calls produced identical raw token (entropy failure)")
	}
	if prefix1 == prefix2 {
		t.Error("two MintToken calls produced identical prefix")
	}
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// TestBearerAuth_RegionMismatchReturns421 covers the multi-region
// audit HIGH #5 follow-up: when a tenant's pinned data_region does
// not match this API instance's region, the SCIM bearer middleware
// must respond 421 with a Location header pointing at the correct
// region's host. The chi-level regions.EnforceRegion middleware
// can't catch this because SCIM resolves its tenant *inside*
// bearerAuth, AFTER router dispatch.
//
// The test stands up a real DB-backed tenant + scim_token, then
// drives a request through bearerAuth with a RegionLookup callback
// that pretends the tenant lives in a different region. Two
// assertions pin the behaviour:
//  1. Response status is 421 Misdirected Request.
//  2. Location header is the correct region's host (what an SDK
//     retries against).
func TestBearerAuth_RegionMismatchReturns421(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanup := seedSCIMTenant(t, pool)
	defer cleanup()

	rawToken, _, err := MintToken(context.Background(), pool, tenantID, "", "region-mismatch test")
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}

	// regionLookup returns a region we know does NOT match
	// regions.Current() (which is us-east-1 by default in tests).
	wrongRegion := regions.EUCentral1
	deps := &Deps{
		Pool: pool,
		RegionLookup: func(tid string) (regions.Region, error) {
			if tid != tenantID {
				t.Errorf("RegionLookup got %q, want %q", tid, tenantID)
			}
			return wrongRegion, nil
		},
	}

	// Wrap bearerAuth around a sentinel that flips a flag if
	// reached. A 421 must short-circuit BEFORE we hit downstream.
	var downstreamFired bool
	mw := deps.bearerAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		downstreamFired = true
	}))
	req := httptest.NewRequest(http.MethodGet, "/scim/v2/Users", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusMisdirectedRequest {
		t.Fatalf("status = %d, want 421 (body=%s)", rec.Code, rec.Body.String())
	}
	if downstreamFired {
		t.Error("downstream handler was reached despite region mismatch")
	}
	wantHost := regions.HostFor(wrongRegion)
	if got := rec.Header().Get("Location"); got != wantHost {
		t.Errorf("Location header = %q, want %q", got, wantHost)
	}
	if got := rec.Header().Get("X-Postwave-Region"); got != string(wrongRegion) {
		t.Errorf("X-Postwave-Region = %q, want %q", got, string(wrongRegion))
	}
}

// TestBearerAuth_RegionMatchProceeds asserts the happy path: when
// RegionLookup returns the same region as regions.Current(), the
// downstream handler runs and the request context carries the
// resolved tenant id.
func TestBearerAuth_RegionMatchProceeds(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanup := seedSCIMTenant(t, pool)
	defer cleanup()

	rawToken, _, err := MintToken(context.Background(), pool, tenantID, "", "region-match test")
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}

	deps := &Deps{
		Pool: pool,
		RegionLookup: func(string) (regions.Region, error) {
			return regions.Current(), nil
		},
	}
	var seenTenant string
	mw := deps.bearerAuth(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seenTenant = tenantIDFromContext(r.Context())
	}))
	req := httptest.NewRequest(http.MethodGet, "/scim/v2/Users", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if seenTenant != tenantID {
		t.Errorf("downstream saw tenant %q, want %q", seenTenant, tenantID)
	}
}

// TestBearerAuth_NilRegionLookupDisablesCheck asserts the fall-back
// path: a Deps with nil RegionLookup must NOT 421 — that's what
// single-region deployments rely on. Without this guarantee, every
// SCIM call in a non-multi-region deploy would 500 or 421 by
// accident.
func TestBearerAuth_NilRegionLookupDisablesCheck(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanup := seedSCIMTenant(t, pool)
	defer cleanup()

	rawToken, _, err := MintToken(context.Background(), pool, tenantID, "", "no region lookup")
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}

	deps := &Deps{Pool: pool, RegionLookup: nil}
	mw := deps.bearerAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/scim/v2/Users", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (nil RegionLookup must skip the check); body=%s",
			rec.Code, rec.Body.String())
	}
}
