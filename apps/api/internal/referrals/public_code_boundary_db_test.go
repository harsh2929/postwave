// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newReferralBoundaryPools(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for referral boundary DB proof")
	}
	ctx := context.Background()
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect postwave_app database: %v", err)
	}
	t.Cleanup(appPool.Close)
	adminPool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect administrative database: %v", err)
	}
	t.Cleanup(adminPool.Close)

	var appUser string
	if err := appPool.QueryRow(ctx, `SELECT current_user`).Scan(&appUser); err != nil {
		t.Fatalf("inspect application role: %v", err)
	}
	if appUser != "postwave_app" {
		t.Skipf("DATABASE_URL must authenticate as postwave_app; got %q", appUser)
	}
	return appPool, adminPool
}

func seedReferralBoundaryTenant(t *testing.T, adminPool *pgxpool.Pool, tenantID string) {
	t.Helper()
	slug := "referral-boundary-" + strings.ReplaceAll(tenantID, "-", "")
	if _, err := adminPool.Exec(context.Background(), `
INSERT INTO public.tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Referral boundary test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, slug); err != nil {
		t.Fatalf("seed referral boundary tenant: %v", err)
	}
}

func seedReferralBoundarySubscriber(
	t *testing.T,
	appPool *pgxpool.Pool,
	tenantID, email string,
) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, appPool, tenantID)
	if err != nil {
		t.Fatalf("open subscriber tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO public.subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'unknown')
RETURNING id::text`, tenantID, email).Scan(&subscriberID); err != nil {
		t.Fatalf("seed referral boundary subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit referral boundary subscriber: %v", err)
	}
	return subscriberID
}

func nextUnusedReferralRandomToken(t *testing.T, appPool *pgxpool.Pool) string {
	t.Helper()
	for attempt := 0; attempt < 32; attempt++ {
		token, err := GenerateCode()
		if err != nil {
			t.Fatalf("generate referral token: %v", err)
		}
		var exists bool
		if err := appPool.QueryRow(context.Background(), `
SELECT EXISTS (SELECT 1 FROM public.referral_code_resolve($1))`, token).Scan(&exists); err != nil {
			t.Fatalf("check generated referral token: %v", err)
		}
		if !exists {
			return token
		}
	}
	t.Fatal("could not generate an unused referral token")
	return ""
}

func insertReferralCodeDirect(
	ctx context.Context,
	appPool *pgxpool.Pool,
	tenantID, subscriberID, code string,
	desired *string,
) error {
	tx, err := db.WithTenant(ctx, appPool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '3s'`); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO public.referral_codes
       (tenant_id, subscriber_id, code, desired_code)
VALUES ($1::uuid, $2, $3, $4)`, tenantID, subscriberID, code, desired)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func referralTokenDiagnostic(
	t *testing.T,
	adminPool *pgxpool.Pool,
	token string,
) string {
	t.Helper()
	var codeRows, registryRows, resolverRows int
	var registryOwners string
	err := adminPool.QueryRow(context.Background(), `
SELECT (SELECT count(*)::int
          FROM public.referral_codes
         WHERE code = $1 OR desired_code = $1),
       (SELECT count(*)::int
          FROM public.referral_code_tokens
         WHERE token = $1),
       (SELECT count(*)::int
          FROM public.referral_code_resolve($1)),
       COALESCE((
           SELECT string_agg(
               token_kind || ':' || tenant_id::text || ':' || subscriber_id,
               ',' ORDER BY token_kind
           )
             FROM public.referral_code_tokens
            WHERE token = $1
       ), '')`, token).Scan(&codeRows, &registryRows, &resolverRows, &registryOwners)
	if err != nil {
		return "diagnostic_error=" + err.Error()
	}
	canonical, valid := canonicalizeReferralLookupCode(token)
	return fmt.Sprintf(
		"raw=%q canonical=%q valid=%v code_rows=%d registry_rows=%d resolver_rows=%d registry=%q",
		token, canonical, valid, codeRows, registryRows, resolverRows, registryOwners,
	)
}

// TestReferralPublicCodeBoundary_DB exercises the real postwave_app role. It
// proves exact public resolution without table visibility, one race-safe
// random/branded namespace, bounded contention, and post-merge ownership.
func TestReferralPublicCodeBoundary_DB(t *testing.T) {
	appPool, adminPool := newReferralBoundaryPools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	seedReferralBoundaryTenant(t, adminPool, tenantA)
	seedReferralBoundaryTenant(t, adminPool, tenantB)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = adminPool.Exec(cleanupCtx, `
DELETE FROM public.tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantA, tenantB)
	})

	repo := &Repo{Pool: appPool}
	ownerA := uuid.NewString()
	ownerB := uuid.NewString()
	randomA, err := repo.EnsureCode(ctx, tenantA, ownerA)
	if err != nil {
		t.Fatalf("mint tenant A code: %v", err)
	}
	brandedA := "brand-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if err := repo.SetDesiredCode(ctx, tenantA, ownerA, brandedA); err != nil {
		t.Fatalf("set tenant A branded code: %v", err)
	}
	randomB, err := repo.EnsureCode(ctx, tenantB, ownerB)
	if err != nil {
		t.Fatalf("mint tenant B code: %v", err)
	}

	var bareRows int
	if err := appPool.QueryRow(ctx, `SELECT count(*)::int FROM public.referral_codes`).Scan(&bareRows); err != nil {
		t.Fatalf("bare referral_codes count: %v", err)
	}
	if bareRows != 0 {
		t.Fatalf("bare postwave_app referral_codes rows = %d, want zero", bareRows)
	}
	if err := appPool.QueryRow(ctx, `SELECT count(*)::int FROM public.referral_code_tokens`).Scan(&bareRows); err == nil || referralCodeSQLState(err) != "42501" {
		t.Fatalf("direct private-registry read error = %v, want SQLSTATE 42501", err)
	}

	resolvedTenant, resolvedSubscriber, err := repo.CodeOwner(ctx, strings.ToUpper(randomA))
	if err != nil || resolvedTenant != tenantA || resolvedSubscriber != ownerA {
		t.Fatalf("resolve random code = (%q,%q,%v), want (%q,%q,nil); %s",
			resolvedTenant, resolvedSubscriber, err, tenantA, ownerA,
			referralTokenDiagnostic(t, adminPool, randomA))
	}
	if _, _, err := repo.CodeOwner(ctx, brandedA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("random-only CodeOwner accepted branded token: %v", err)
	}
	resolvedTenant, resolvedSubscriber, err = repo.CodeOwnerByAny(ctx, "  "+strings.ToUpper(brandedA)+"  ")
	if err != nil || resolvedTenant != tenantA || resolvedSubscriber != ownerA {
		t.Fatalf("resolve branded code = (%q,%q,%v), want (%q,%q,nil)",
			resolvedTenant, resolvedSubscriber, err, tenantA, ownerA)
	}
	resolvedTenant, resolvedSubscriber, err = repo.CodeOwnerByAny(ctx, randomB)
	if err != nil || resolvedTenant != tenantB || resolvedSubscriber != ownerB {
		t.Fatalf("resolve cross-tenant random code = (%q,%q,%v), want (%q,%q,nil)",
			resolvedTenant, resolvedSubscriber, err, tenantB, ownerB)
	}
	// The public referral runtime sits behind the OperationalRuntimeAvailable
	// compile-time release boundary (referrals.go). Two separate contracts are
	// asserted so neither can drift silently:
	//
	//  1. Exposure: while the boundary is closed, MountPublicRoutes mounts the
	//     widget path only as the stable 503 release hold, so no widget byte is
	//     served. Once the boundary opens, that same mounted path must serve
	//     the widget.
	//  2. Behaviour: the widget handler must derive the canonical branded share
	//     URL from real database resolution under the postwave_app role. That is
	//     the property this DB boundary test exists to prove, and it is asserted
	//     at full strength in both release states by dispatching to the handler
	//     directly — the release boundary withholds the route, not correctness.
	publicDeps := &Deps{
		Repo:         repo,
		ShareBaseURL: "https://share.example.test",
	}
	widgetPath := "/api/public/r/" + strings.ToUpper(brandedA) + "/widget.js"
	wantShareURL := "https://share.example.test/r/" + brandedA

	mountedRouter := chi.NewRouter()
	publicDeps.MountPublicRoutes(mountedRouter)
	mountedResponse := httptest.NewRecorder()
	mountedRouter.ServeHTTP(
		mountedResponse,
		httptest.NewRequest(http.MethodGet, widgetPath, nil),
	)
	if OperationalRuntimeAvailable {
		if mountedResponse.Code != http.StatusOK ||
			!strings.Contains(mountedResponse.Body.String(), wantShareURL) {
			t.Fatalf("released public widget route status=%d body=%q, want canonical branded share URL",
				mountedResponse.Code, mountedResponse.Body.String())
		}
	} else if mountedResponse.Code != http.StatusServiceUnavailable ||
		!strings.Contains(mountedResponse.Body.String(), OperationalRuntimeHoldCode) ||
		strings.Contains(mountedResponse.Body.String(), wantShareURL) {
		t.Fatalf("gated public widget route status=%d body=%q, want the 503 %q hold and no share URL while the referral operational runtime release boundary is closed",
			mountedResponse.Code, mountedResponse.Body.String(), OperationalRuntimeHoldCode)
	}

	widgetRouter := chi.NewRouter()
	widgetRouter.Get("/api/public/r/{code}/widget.js", publicDeps.WidgetJS)
	widgetResponse := httptest.NewRecorder()
	widgetRouter.ServeHTTP(
		widgetResponse,
		httptest.NewRequest(http.MethodGet, widgetPath, nil),
	)
	if widgetResponse.Code != http.StatusOK ||
		!strings.Contains(widgetResponse.Body.String(), wantShareURL) {
		t.Fatalf("public widget status=%d body=%q, want canonical branded share URL",
			widgetResponse.Code, widgetResponse.Body.String())
	}

	// Pin an easy-to-miss canonicalization edge: PostgreSQL escape strings do
	// not define \v. Building the trim set from chr(11) must preserve literal
	// letter-v token boundaries while still trimming a vertical-tab wrapper.
	var edgeToken string
	for attempt := 0; attempt < 32; attempt++ {
		candidate := nextUnusedReferralRandomToken(t, appPool)
		candidate = "v" + candidate[1:7] + "v"
		var exists bool
		if err := appPool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM public.referral_code_resolve($1))`, candidate).Scan(&exists); err != nil {
			t.Fatalf("probe v-boundary token: %v", err)
		}
		if !exists {
			edgeToken = candidate
			break
		}
	}
	if edgeToken == "" {
		t.Fatal("could not produce unused v-boundary token")
	}
	edgeOwner := uuid.NewString()
	if err := insertReferralCodeDirect(ctx, appPool, tenantB, edgeOwner, edgeToken, nil); err != nil {
		t.Fatalf("insert v-boundary token: %v", err)
	}
	var edgeTenant, edgeSubscriber, edgeKind string
	if err := appPool.QueryRow(ctx, `
SELECT tenant_id::text, subscriber_id, token_kind
  FROM public.referral_code_resolve(
       pg_catalog.chr(11) || $1 || pg_catalog.chr(11)
  )`, edgeToken).Scan(&edgeTenant, &edgeSubscriber, &edgeKind); err != nil {
		t.Fatalf("resolve vertical-tab wrapped v-boundary token: %v", err)
	}
	if edgeTenant != tenantB || edgeSubscriber != edgeOwner || edgeKind != "code" {
		t.Fatalf("v-boundary owner = (%q,%q,%q), want (%q,%q,code)",
			edgeTenant, edgeSubscriber, edgeKind, tenantB, edgeOwner)
	}

	tenantTx, err := db.WithTenant(ctx, appPool, tenantA)
	if err != nil {
		t.Fatalf("open tenant isolation probe: %v", err)
	}
	defer func() { _ = tenantTx.Rollback(ctx) }()
	var tenantRows, leakedRows int
	if err := tenantTx.QueryRow(ctx, `SELECT count(*)::int FROM public.referral_codes`).Scan(&tenantRows); err != nil {
		t.Fatalf("count tenant referral codes: %v", err)
	}
	if err := tenantTx.QueryRow(ctx, `
SELECT count(*)::int FROM public.referral_codes WHERE code = $1`, randomB).Scan(&leakedRows); err != nil {
		t.Fatalf("probe cross-tenant referral code: %v", err)
	}
	if tenantRows != 1 || leakedRows != 0 {
		t.Fatalf("tenant table visibility rows=%d leaked=%d, want one/zero", tenantRows, leakedRows)
	}
	_ = tenantTx.Rollback(ctx)

	invalidCodes := []string{
		"", "ab", "-abc", "abc-", "a--bc", "abc/def", "snow-☃",
		strings.Repeat("a", 33), "definitely-unknown",
	}
	for _, invalid := range invalidCodes {
		if _, _, err := repo.CodeOwnerByAny(ctx, invalid); !errors.Is(err, ErrNotFound) {
			t.Errorf("lookup %q error = %v, want ErrNotFound", invalid, err)
		}
		var count int
		if err := appPool.QueryRow(ctx, `
SELECT count(*)::int FROM public.referral_code_resolve($1)`, invalid).Scan(&count); err != nil {
			t.Errorf("direct resolver invalid %q: %v", invalid, err)
		} else if count != 0 {
			t.Errorf("direct resolver invalid %q returned %d rows", invalid, count)
		}
	}

	var appCanResolve, publicCanResolve, appCanSync, publicRoleCanResolve bool
	if err := adminPool.QueryRow(ctx, `
SELECT pg_catalog.has_function_privilege(
           'postwave_app', 'public.referral_code_resolve(text)', 'EXECUTE'
       ),
       EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(
                COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
            ) AS acl
            WHERE proc.oid = 'public.referral_code_resolve(text)'::regprocedure
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
       ),
       pg_catalog.has_function_privilege(
           'postwave_app', 'public.referral_code_tokens_sync()', 'EXECUTE'
       ),
       pg_catalog.has_function_privilege(
           'postwave_public', 'public.referral_code_resolve(text)', 'EXECUTE'
       )`).Scan(&appCanResolve, &publicCanResolve, &appCanSync, &publicRoleCanResolve); err != nil {
		t.Fatalf("inspect referral function ACLs: %v", err)
	}
	if !appCanResolve || publicCanResolve || appCanSync || publicRoleCanResolve {
		t.Fatalf("unsafe function ACLs appResolve=%v PUBLIC=%v appSync=%v postwavePublic=%v",
			appCanResolve, publicCanResolve, appCanSync, publicRoleCanResolve)
	}

	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	if err := adminPool.QueryRow(ctx, `
SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
       rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
 WHERE rolname = 'postwave_referral_code_definer'`).Scan(
		&canLogin, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS,
	); err != nil {
		t.Fatalf("inspect referral definer role: %v", err)
	}
	if canLogin || superuser || createDB || createRole || inherit || replication || !bypassRLS {
		t.Fatalf("unsafe referral definer attributes login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypassrls=%v",
			canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	var unsafeFunctionMetadata, unexpectedOwnedObjects int
	if err := adminPool.QueryRow(ctx, `
WITH expected(oid, volatility) AS (
    VALUES
      ('public.referral_code_resolve(text)'::regprocedure::oid, 's'::"char"),
      ('public.referral_code_tokens_sync()'::regprocedure::oid, 'v'::"char")
)
SELECT count(*)::int
  FROM expected
  JOIN pg_catalog.pg_proc AS proc ON proc.oid = expected.oid
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = proc.proowner
  JOIN pg_catalog.pg_language AS language ON language.oid = proc.prolang
 WHERE owner.rolname <> 'postwave_referral_code_definer'
    OR NOT proc.prosecdef
    OR proc.provolatile <> expected.volatility
    -- pg_temp is REQUIRED here, and listed last. Omitting it does not narrow the
    -- search path, it widens it: PostgreSQL searches the caller's temp schema
    -- anyway, and searches it FIRST for relation and type names, so a caller can
    -- shadow an unqualified type in the body and run its own SQL as this definer
    -- role. That was exploited against this schema (see migration 1915), so
    -- 'search_path=pg_catalog' — the value this test used to pin — is the unsafe
    -- one. The exact-match is kept deliberately: the point is that this metadata
    -- cannot drift silently, which is why changing it had to be a decision.
    OR proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
    OR language.lanname <> 'plpgsql'`).Scan(&unsafeFunctionMetadata); err != nil {
		t.Fatalf("inspect referral function metadata: %v", err)
	}
	if err := adminPool.QueryRow(ctx, `
WITH definer AS (
    SELECT oid FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_referral_code_definer'
), allowed_functions AS (
    SELECT 'public.referral_code_resolve(text)'::regprocedure::oid AS oid
    UNION ALL
    SELECT 'public.referral_code_tokens_sync()'::regprocedure::oid
)
SELECT (
         SELECT count(*) FROM pg_catalog.pg_class
          WHERE relowner = (SELECT oid FROM definer)
       ) + (
         SELECT count(*) FROM pg_catalog.pg_namespace
          WHERE nspowner = (SELECT oid FROM definer)
       ) + (
         SELECT count(*) FROM pg_catalog.pg_proc
          WHERE proowner = (SELECT oid FROM definer)
            AND oid NOT IN (SELECT oid FROM allowed_functions)
       )`).Scan(&unexpectedOwnedObjects); err != nil {
		t.Fatalf("inspect referral definer ownership: %v", err)
	}
	if unsafeFunctionMetadata != 0 || unexpectedOwnedObjects != 0 {
		t.Fatalf("unsafe referral function metadata=%d unexpected owned objects=%d",
			unsafeFunctionMetadata, unexpectedOwnedObjects)
	}

	// Concurrent first-use requests for one subscriber must converge on the
	// single tenant/subscriber row and return the same committed token.
	ensureOwner := uuid.NewString()
	ensureResults := make(chan string, 8)
	ensureErrors := make(chan error, 8)
	var ensureWG sync.WaitGroup
	for index := 0; index < 8; index++ {
		ensureWG.Add(1)
		go func() {
			defer ensureWG.Done()
			ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer ensureCancel()
			code, ensureErr := repo.EnsureCode(ensureCtx, tenantA, ensureOwner)
			if ensureErr != nil {
				ensureErrors <- ensureErr
				return
			}
			ensureResults <- code
		}()
	}
	ensureWG.Wait()
	close(ensureResults)
	close(ensureErrors)
	for ensureErr := range ensureErrors {
		t.Fatalf("concurrent EnsureCode: %v", ensureErr)
	}
	ensuredCode := ""
	for code := range ensureResults {
		if ensuredCode == "" {
			ensuredCode = code
		}
		if code != ensuredCode {
			t.Fatalf("concurrent EnsureCode returned %q and %q", ensuredCode, code)
		}
	}
	if ensuredCode == "" {
		t.Fatal("concurrent EnsureCode returned no code")
	}
	ensureTx, err := db.WithTenant(ctx, appPool, tenantA)
	if err != nil {
		t.Fatalf("open EnsureCode verification scope: %v", err)
	}
	var ensuredRows int
	if err := ensureTx.QueryRow(ctx, `
SELECT count(*)::int FROM public.referral_codes
 WHERE tenant_id = $1::uuid AND subscriber_id = $2`, tenantA, ensureOwner).Scan(&ensuredRows); err != nil {
		_ = ensureTx.Rollback(ctx)
		t.Fatalf("count concurrent EnsureCode rows: %v", err)
	}
	_ = ensureTx.Rollback(ctx)
	if ensuredRows != 1 {
		t.Fatalf("concurrent EnsureCode rows = %d, want one", ensuredRows)
	}

	// Existing random token -> desired token must fail globally, even across
	// tenants, without making the other tenant's identity visible.
	crossToken := nextUnusedReferralRandomToken(t, appPool)
	crossOwnerA := uuid.NewString()
	if err := insertReferralCodeDirect(ctx, appPool, tenantA, crossOwnerA, crossToken, nil); err != nil {
		t.Fatalf("seed cross-column random token: %v", err)
	}
	crossOwnerB := uuid.NewString()
	if _, err := repo.EnsureCode(ctx, tenantB, crossOwnerB); err != nil {
		t.Fatalf("mint reverse owner random token: %v", err)
	}
	if err := repo.SetDesiredCode(ctx, tenantB, crossOwnerB, crossToken); !errors.Is(err, ErrCodeTaken) {
		t.Fatalf("desired-vs-random collision error = %v, want ErrCodeTaken", err)
	}

	// Existing desired token -> random token is denied by the same registry
	// primary key; this direction was not covered by the historical indexes.
	reverseToken := nextUnusedReferralRandomToken(t, appPool)
	if err := repo.SetDesiredCode(ctx, tenantA, ownerA, reverseToken); err != nil {
		t.Fatalf("seed reverse desired token: %v", err)
	}
	reverseCode := reverseToken
	if err := insertReferralCodeDirect(ctx, appPool, tenantB, uuid.NewString(), reverseCode, nil); err == nil || referralCodeSQLState(err) != "23505" {
		t.Fatalf("random-vs-desired collision error = %v, want SQLSTATE 23505", err)
	}

	// Two concurrent cross-column claims serialize on the registry token. One
	// transaction commits and one receives a unique violation; both can never
	// become resolvable.
	sharedToken := nextUnusedReferralRandomToken(t, appPool)
	otherToken := nextUnusedReferralRandomToken(t, appPool)
	for otherToken == sharedToken {
		otherToken = nextUnusedReferralRandomToken(t, appPool)
	}
	concurrentOwnerA := uuid.NewString()
	concurrentOwnerB := uuid.NewString()
	type claimResult struct {
		owner string
		err   error
	}
	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	results := make(chan claimResult, 2)
	var claimWG sync.WaitGroup
	claim := func(tenantID, owner, code string, desired *string) {
		defer claimWG.Done()
		ready <- struct{}{}
		<-start
		claimCtx, claimCancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer claimCancel()
		results <- claimResult{owner: owner, err: insertReferralCodeDirect(
			claimCtx, appPool, tenantID, owner, code, desired,
		)}
	}
	claimWG.Add(2)
	go claim(tenantA, concurrentOwnerA, sharedToken, nil)
	go claim(tenantB, concurrentOwnerB, otherToken, &sharedToken)
	<-ready
	<-ready
	close(start)
	claimWG.Wait()
	close(results)
	successfulOwner := ""
	failures := 0
	for result := range results {
		if result.err == nil {
			if successfulOwner != "" {
				t.Fatalf("both concurrent cross-column claims committed (%s and %s)", successfulOwner, result.owner)
			}
			successfulOwner = result.owner
			continue
		}
		if referralCodeSQLState(result.err) != "23505" {
			t.Fatalf("concurrent losing claim error = %v, want SQLSTATE 23505", result.err)
		}
		failures++
	}
	if successfulOwner == "" || failures != 1 {
		t.Fatalf("concurrent claim outcome winner=%q failures=%d, want one/one", successfulOwner, failures)
	}
	_, resolvedSubscriber, err = repo.CodeOwnerByAny(ctx, sharedToken)
	if err != nil || resolvedSubscriber != successfulOwner {
		t.Fatalf("concurrent token owner = (%q,%v), want (%q,nil); %s",
			resolvedSubscriber, err, successfulOwner,
			referralTokenDiagnostic(t, adminPool, sharedToken))
	}

	// Hold the exact advisory namespace lock used by the trigger. SetDesiredCode
	// must stop after its fixed retry budget and surface a retryable sentinel.
	busyToken := nextUnusedReferralRandomToken(t, appPool)
	lockTx, err := adminPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin contention lock: %v", err)
	}
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	if _, err := lockTx.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('postwave:referral-code-token:' || $1, 1772::bigint)
)`, busyToken); err != nil {
		t.Fatalf("hold referral token advisory lock: %v", err)
	}
	started := time.Now()
	busyErr := repo.SetDesiredCode(ctx, tenantA, ownerA, busyToken)
	elapsed := time.Since(started)
	if !errors.Is(busyErr, ErrCodeContention) {
		t.Fatalf("contended desired-code error = %v, want ErrCodeContention", busyErr)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("bounded desired-code contention took %s, want <= 5s", elapsed)
	}
	_ = lockTx.Rollback(ctx)

	// A code retained on a merged tombstone must resolve to the final live
	// survivor after the exact global token lookup crosses back into tenant RLS.
	primaryID := seedReferralBoundarySubscriber(
		t, appPool, tenantA,
		"ref-primary-"+strings.ReplaceAll(uuid.NewString(), "-", "")+"@example.test",
	)
	duplicateID := seedReferralBoundarySubscriber(
		t, appPool, tenantA,
		"ref-duplicate-"+strings.ReplaceAll(uuid.NewString(), "-", "")+"@example.test",
	)
	credited, err := repo.CreditConversionWithIP(
		ctx, strings.ToUpper(randomA), primaryID, "203.0.113.177",
	)
	if err != nil || !credited {
		t.Fatalf("public random-code credit result=(%v,%v), want (true,nil)", credited, err)
	}
	if _, err := repo.CreditConversionForTenantWithIP(
		ctx, tenantB, randomA, primaryID, "203.0.113.178",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant credit error = %v, want ErrNotFound", err)
	}
	creditTx, err := db.WithTenant(ctx, appPool, tenantA)
	if err != nil {
		t.Fatalf("open credit verification scope: %v", err)
	}
	var creditedRows int
	if err := creditTx.QueryRow(ctx, `
SELECT count(*)::int
  FROM public.referral_conversions
 WHERE tenant_id = $1::uuid
   AND referrer_subscriber_id = $2
   AND referee_subscriber_id = $3::text
   AND credit_status = 'credited'`, tenantA, ownerA, primaryID).Scan(&creditedRows); err != nil {
		_ = creditTx.Rollback(ctx)
		t.Fatalf("verify public referral credit: %v", err)
	}
	_ = creditTx.Rollback(ctx)
	if creditedRows != 1 {
		t.Fatalf("public referral credited rows = %d, want one", creditedRows)
	}
	mergedCode, err := repo.EnsureCode(ctx, tenantA, duplicateID)
	if err != nil {
		t.Fatalf("mint merged-source code: %v", err)
	}
	mergeTx, err := db.WithTenant(ctx, appPool, tenantA)
	if err != nil {
		t.Fatalf("open merged-owner tenant scope: %v", err)
	}
	if _, err := mergeTx.Exec(ctx, `
UPDATE public.subscribers
   SET status = 'blocklisted',
       archived_at = pg_catalog.clock_timestamp(),
       merged_into_subscriber_id = $3::uuid,
       merged_at = pg_catalog.clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantA, duplicateID, primaryID); err != nil {
		_ = mergeTx.Rollback(ctx)
		t.Fatalf("mark referral owner merged: %v", err)
	}
	if err := mergeTx.Commit(ctx); err != nil {
		t.Fatalf("commit merged referral owner: %v", err)
	}
	resolvedTenant, resolvedSubscriber, err = repo.CodeOwner(ctx, mergedCode)
	if err != nil || resolvedTenant != tenantA || resolvedSubscriber != primaryID {
		t.Fatalf("merged code owner = (%q,%q,%v), want (%q,%q,nil); %s",
			resolvedTenant, resolvedSubscriber, err, tenantA, primaryID,
			referralTokenDiagnostic(t, adminPool, mergedCode))
	}

	// Public redirect click accounting re-enters the resolved tenant instead
	// of depending on the removed cross-tenant RLS policy/GUC.
	clickRequest := httptest.NewRequest("GET", "/api/public/r/"+strings.ToUpper(randomA), nil)
	clickRequest.Header.Set("User-Agent", "referral-boundary-test")
	repo.RecordClick(ctx, tenantA, strings.ToUpper(randomA), clickRequest)
	clickTx, err := db.WithTenant(ctx, appPool, tenantA)
	if err != nil {
		t.Fatalf("open click verification scope: %v", err)
	}
	defer func() { _ = clickTx.Rollback(ctx) }()
	var clicks int64
	var clickRows int
	if err := clickTx.QueryRow(ctx, `
SELECT clicks_count FROM public.referral_codes
 WHERE tenant_id = $1::uuid AND subscriber_id = $2`, tenantA, ownerA).Scan(&clicks); err != nil {
		t.Fatalf("read referral click count: %v", err)
	}
	if err := clickTx.QueryRow(ctx, `
SELECT count(*)::int FROM public.referral_clicks
 WHERE tenant_id = $1::uuid AND code = $2`, tenantA, randomA).Scan(&clickRows); err != nil {
		t.Fatalf("read referral click ledger: %v", err)
	}
	if clicks != 1 || clickRows != 1 {
		t.Fatalf("click accounting count=%d ledger=%d, want one/one", clicks, clickRows)
	}
	_ = clickTx.Rollback(ctx)

	var registryMismatch int
	if err := adminPool.QueryRow(ctx, `
SELECT count(*)::int
  FROM public.referral_code_tokens AS token
  LEFT JOIN public.referral_codes AS referral
    ON referral.id = token.referral_code_id
 WHERE referral.id IS NULL
    OR token.tenant_id <> referral.tenant_id
    OR token.subscriber_id <> referral.subscriber_id
    OR (token.token_kind = 'code' AND token.token <> referral.code)
    OR (token.token_kind = 'desired' AND token.token <> referral.desired_code)`).Scan(&registryMismatch); err != nil {
		t.Fatalf("inspect referral registry consistency: %v", err)
	}
	if registryMismatch != 0 {
		t.Fatalf("private referral registry mismatch rows = %d", registryMismatch)
	}

	t.Logf("verified public referral boundary for tenants %s/%s (%s, %s)",
		tenantA, tenantB, randomA, fmt.Sprintf("%.3fs bounded contention", elapsed.Seconds()))
}

func TestReferralCodeCanonicalization(t *testing.T) {
	tests := []struct {
		raw  string
		want string
		ok   bool
	}{
		{raw: " ABCD2345 ", want: "abcd2345", ok: true},
		{raw: "\tABCD2345\r", want: "abcd2345", ok: true},
		{raw: "brand-code", want: "brand-code", ok: true},
		{raw: "a--b", ok: false},
		{raw: "a/b", ok: false},
		{raw: "☃-code", ok: false},
		{raw: "ab", ok: false},
		{raw: strings.Repeat("a", 65), ok: false},
	}
	for _, test := range tests {
		got, ok := canonicalizeReferralLookupCode(test.raw)
		if got != test.want || ok != test.ok {
			t.Errorf("canonicalize %q = (%q,%v), want (%q,%v)",
				test.raw, got, ok, test.want, test.ok)
		}
	}
}

func TestReferralCodeContentionWrapping(t *testing.T) {
	// The database-backed test proves the sentinel is produced. Keep the
	// operator-facing retry contract and diagnostic cause pinned without a
	// database dependency.
	wrapped := referralCodeContentionError(pgx.ErrTxClosed)
	if !errors.Is(wrapped, ErrCodeContention) || !errors.Is(wrapped, pgx.ErrTxClosed) {
		t.Fatal("contention wrapper lost sentinel or PostgreSQL cause identity")
	}
}
