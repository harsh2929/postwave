// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func pushSuppressionDatabaseURLs(t *testing.T) (string, string) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("PUSH_SUPPRESSIONS_ADMIN_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("PUSH_SUPPRESSIONS_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		adminURL, appURL = sharedTestDatabaseURLs()
	}
	return privatePushSuppressionDatabaseURLs(t, adminURL, appURL)
}

func requirePushSuppressionPGError(t *testing.T, err error, code, constraint string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error=%v, want PostgreSQL error %s/%s", err, code, constraint)
	}
	if pgErr.Code != code || (constraint != "" && pgErr.ConstraintName != constraint) {
		t.Fatalf("error=%v code=%q constraint=%q, want %s/%s", err, pgErr.Code, pgErr.ConstraintName, code, constraint)
	}
}

func TestAuthorityDatabaseContract(t *testing.T) {
	adminURL, appURL := pushSuppressionDatabaseURLs(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("open restricted app pool: %v", err)
	}
	t.Cleanup(app.Close)

	var appRole struct {
		name, super, bypass string
	}
	if err := app.QueryRow(ctx, `SELECT current_user, rolsuper::text, rolbypassrls::text FROM pg_roles WHERE rolname = current_user`).Scan(
		&appRole.name, &appRole.super, &appRole.bypass,
	); err != nil {
		t.Fatalf("inspect app role: %v", err)
	}
	if appRole.super != "false" || appRole.bypass != "false" {
		t.Fatalf("DB proof requires production-like restricted role, got user=%s super=%s bypass=%s", appRole.name, appRole.super, appRole.bypass)
	}

	const revisionDefiner = "postwave_push_suppression_revision_definer"
	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	if err := admin.QueryRow(ctx, `
SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
       rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
 WHERE rolname = $1`, revisionDefiner).Scan(
		&canLogin, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS,
	); err != nil {
		t.Fatalf("inspect revision definer role: %v", err)
	}
	if canLogin || superuser || createDB || createRole || inherit || replication || !bypassRLS {
		t.Fatalf("unsafe revision definer attributes login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypassrls=%v",
			canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	var memberships int
	if err := admin.QueryRow(ctx, `
SELECT count(*)::int
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS role
    ON role.oid = membership.member OR role.oid = membership.roleid
 WHERE role.rolname = $1`, revisionDefiner).Scan(&memberships); err != nil {
		t.Fatalf("inspect revision definer memberships: %v", err)
	}
	if memberships != 0 {
		t.Fatalf("revision definer has %d memberships/members, want zero", memberships)
	}

	var appSelect, appInsert, appUpdate, appDelete, appTruncate bool
	if err := admin.QueryRow(ctx, `
SELECT has_table_privilege($1, 'public.push_suppression_registry_state', 'SELECT'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'INSERT'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'UPDATE'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'DELETE'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'TRUNCATE')`, appRole.name).Scan(
		&appSelect, &appInsert, &appUpdate, &appDelete, &appTruncate,
	); err != nil {
		t.Fatalf("inspect app registry-state ACL: %v", err)
	}
	if !appSelect || appInsert || appUpdate || appDelete || appTruncate {
		t.Fatalf("app registry-state ACL is not SELECT-only: select=%v insert=%v update=%v delete=%v truncate=%v",
			appSelect, appInsert, appUpdate, appDelete, appTruncate)
	}
	var authoritySelect, authorityInsert, authorityUpdate bool
	var authorityDelete, authorityTruncate, authorityReferences, authorityTrigger bool
	if err := admin.QueryRow(ctx, `
SELECT has_table_privilege($1, 'public.push_suppression_authorities', 'SELECT'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'INSERT'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'UPDATE'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'DELETE'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'TRUNCATE'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'REFERENCES'),
       has_table_privilege($1, 'public.push_suppression_authorities', 'TRIGGER')`, appRole.name).Scan(
		&authoritySelect, &authorityInsert, &authorityUpdate, &authorityDelete,
		&authorityTruncate, &authorityReferences, &authorityTrigger,
	); err != nil {
		t.Fatalf("inspect app authority ACL: %v", err)
	}
	if !authoritySelect || !authorityInsert || !authorityUpdate || authorityDelete ||
		authorityTruncate || authorityReferences || authorityTrigger {
		t.Fatalf("unsafe app authority ACL select/insert/update/delete/truncate/references/trigger=%v/%v/%v/%v/%v/%v/%v",
			authoritySelect, authorityInsert, authorityUpdate, authorityDelete,
			authorityTruncate, authorityReferences, authorityTrigger)
	}

	var definerSelect, definerInsert, definerUpdate, definerDelete, definerTruncate bool
	var definerTenantIDSelect, definerTenantNameSelect, definerSchemaUsage, definerSchemaCreate bool
	if err := admin.QueryRow(ctx, `
SELECT has_table_privilege($1, 'public.push_suppression_registry_state', 'SELECT'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'INSERT'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'UPDATE'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'DELETE'),
       has_table_privilege($1, 'public.push_suppression_registry_state', 'TRUNCATE'),
       has_column_privilege($1, 'public.tenants', 'id', 'SELECT'),
       has_column_privilege($1, 'public.tenants', 'name', 'SELECT'),
       has_schema_privilege($1, 'public', 'USAGE'),
       has_schema_privilege($1, 'public', 'CREATE')`, revisionDefiner).Scan(
		&definerSelect, &definerInsert, &definerUpdate, &definerDelete, &definerTruncate,
		&definerTenantIDSelect, &definerTenantNameSelect, &definerSchemaUsage, &definerSchemaCreate,
	); err != nil {
		t.Fatalf("inspect revision definer ACL: %v", err)
	}
	if !definerSelect || !definerInsert || !definerUpdate || definerDelete || definerTruncate ||
		!definerTenantIDSelect || definerTenantNameSelect || !definerSchemaUsage || definerSchemaCreate {
		t.Fatalf("unsafe revision definer ACL state=%v/%v/%v/%v/%v tenant-id/name=%v/%v schema-usage/create=%v/%v",
			definerSelect, definerInsert, definerUpdate, definerDelete, definerTruncate,
			definerTenantIDSelect, definerTenantNameSelect, definerSchemaUsage, definerSchemaCreate)
	}

	var unsafeFunctionMetadata, unexpectedOwnedObjects, publicExecuteACLs int
	var appCanSeed, appCanAdvance bool
	if err := admin.QueryRow(ctx, `
WITH expected(oid) AS (
    VALUES
      ('public.push_suppression_registry_seed_tenant()'::regprocedure::oid),
      ('public.push_suppression_authority_visibility_lock()'::regprocedure::oid)
)
SELECT count(*)::int
  FROM expected
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.oid
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
 WHERE owner.rolname <> $1 OR NOT procedure.prosecdef`, revisionDefiner).Scan(&unsafeFunctionMetadata); err != nil {
		t.Fatalf("inspect revision definer function ownership: %v", err)
	}
	if unsafeFunctionMetadata != 0 {
		t.Fatalf("%d revision functions lost dedicated SECURITY DEFINER ownership", unsafeFunctionMetadata)
	}
	if err := admin.QueryRow(ctx, `
WITH definer AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
), expected(oid) AS (
    VALUES
      ('public.push_suppression_registry_seed_tenant()'::regprocedure::oid),
      ('public.push_suppression_authority_visibility_lock()'::regprocedure::oid)
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
            AND oid NOT IN (SELECT oid FROM expected)
       )`, revisionDefiner).Scan(&unexpectedOwnedObjects); err != nil {
		t.Fatalf("inspect revision definer owned objects: %v", err)
	}
	if unexpectedOwnedObjects != 0 {
		t.Fatalf("revision definer owns %d unexpected objects", unexpectedOwnedObjects)
	}
	if err := admin.QueryRow(ctx, `
WITH expected(oid) AS (
    VALUES
      ('public.push_suppression_registry_seed_tenant()'::regprocedure::oid),
      ('public.push_suppression_authority_visibility_lock()'::regprocedure::oid)
)
SELECT count(*)::int
  FROM expected
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = expected.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(
     COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
 ) AS acl
 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`).Scan(&publicExecuteACLs); err != nil {
		t.Fatalf("inspect revision function PUBLIC ACLs: %v", err)
	}
	if err := admin.QueryRow(ctx, `
SELECT has_function_privilege($1, 'public.push_suppression_registry_seed_tenant()', 'EXECUTE'),
       has_function_privilege($1, 'public.push_suppression_authority_visibility_lock()', 'EXECUTE')`, appRole.name).Scan(
		&appCanSeed, &appCanAdvance,
	); err != nil {
		t.Fatalf("inspect app revision function ACLs: %v", err)
	}
	if publicExecuteACLs != 0 || appCanSeed || appCanAdvance {
		t.Fatalf("unsafe revision function EXECUTE ACLs public=%d app-seed=%v app-advance=%v",
			publicExecuteACLs, appCanSeed, appCanAdvance)
	}

	tenantA, tenantB := uuid.NewString(), uuid.NewString()
	for _, tenantID := range []string{tenantA, tenantB} {
		if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Route43 authority DB proof', $2, 'studio')`, tenantID, "route43-"+tenantID); err != nil {
			t.Fatalf("seed tenant %s: %v", tenantID, err)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = ANY($1::uuid[])`, []string{tenantA, tenantB})
	})
	for _, tenantID := range []string{tenantA, tenantB} {
		var stateRows int
		var revision int64
		if err := admin.QueryRow(ctx, `
SELECT count(*)::int, COALESCE(max(revision), -1)
  FROM push_suppression_registry_state
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&stateRows, &revision); err != nil {
			t.Fatalf("inspect seeded registry state for %s: %v", tenantID, err)
		}
		if stateRows != 1 || revision != 0 {
			t.Fatalf("tenant %s registry seed rows/revision=%d/%d want 1/0", tenantID, stateRows, revision)
		}
	}

	// TRUNCATE bypasses row-level DML triggers and is therefore never a valid
	// authority-domain maintenance operation. Probe each protected table with
	// its own implicit transaction so one expected failure cannot poison the
	// next assertion.
	for _, table := range []string{
		"push_suppression_authorities",
		"push_token_suppressions",
		"push_suppression_registry_state",
		"push_devices",
	} {
		t.Run("truncate "+table+" denied", func(t *testing.T) {
			truncateErr := truncatePrivatePushSuppressionTable(t, ctx, admin, table)
			requirePushSuppressionTruncateRefused(t, truncateErr)
		})
	}

	// The app can read the revision bound for a tenant-scoped list, but only
	// trigger code owned by the dedicated definer may seed or advance it.
	for _, probe := range []struct {
		name string
		sql  string
	}{
		{
			name: "insert registry state",
			sql: `INSERT INTO push_suppression_registry_state (tenant_id, revision)
VALUES ($1::uuid, 0) ON CONFLICT (tenant_id) DO NOTHING`,
		},
		{
			name: "update registry state",
			sql: `UPDATE push_suppression_registry_state
SET revision = revision + 1 WHERE tenant_id = $1::uuid`,
		},
		{
			name: "delete registry state",
			sql:  `DELETE FROM push_suppression_registry_state WHERE tenant_id = $1::uuid`,
		},
	} {
		t.Run(probe.name+" denied", func(t *testing.T) {
			tx, err := db.WithTenant(ctx, app, tenantA)
			if err != nil {
				t.Fatal(err)
			}
			_, dmlErr := tx.Exec(ctx, probe.sql, tenantA)
			_ = tx.Rollback(ctx)
			requirePushSuppressionPGError(t, dmlErr, "42501", "")
		})
	}

	store := &Store{Pool: app}
	meta := db.AuditMeta{TenantID: tenantA, ActorType: "human", ActorLabel: "route43-db-test"}

	// The API projection accepts only a bounded timestamp window. Keep that
	// invariant at the table boundary too, including direct/mixed-version SQL,
	// and retain the creation -> revocation -> update ordering.
	for _, test := range []struct {
		name       string
		createdAt  string
		updatedAt  string
		revokedAt  string
		constraint string
	}{
		{
			name:       "created before projection window",
			createdAt:  "1999-12-31T23:59:59Z",
			updatedAt:  "2000-01-01T00:00:00Z",
			constraint: "push_suppression_authorities_projection_time_check",
		},
		{
			name:       "updated at projection ceiling",
			createdAt:  "2099-12-31T23:59:58Z",
			updatedAt:  "2100-01-01T00:00:00Z",
			constraint: "push_suppression_authorities_projection_time_check",
		},
		{
			name:       "revoked at projection ceiling",
			createdAt:  "2024-01-01T00:00:00Z",
			updatedAt:  "2024-01-01T00:00:00Z",
			revokedAt:  "2100-01-01T00:00:00Z",
			constraint: "push_suppression_authorities_projection_time_check",
		},
		{
			name:       "updated before revocation",
			createdAt:  "2024-01-01T00:00:00Z",
			updatedAt:  "2024-01-01T00:00:00Z",
			revokedAt:  "2099-12-31T23:59:59Z",
			constraint: "push_suppression_authorities_time_check",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			tokenHash := sha256.Sum256([]byte("route43-time-boundary-" + test.name))
			if test.revokedAt == "" {
				_, insertErr := admin.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source,
     created_at, updated_at)
VALUES ($1::uuid, $2, 'apns', 'manual', 'manual', 'dashboard',
	        $3::timestamptz, $4::timestamptz)`,
					tenantA, tokenHash[:], test.createdAt, test.updatedAt)
				requirePushSuppressionPGError(t, insertErr, "23514", test.constraint)
				return
			}

			var authorityID string
			if err := admin.QueryRow(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source,
     created_at, updated_at)
VALUES ($1::uuid, $2, 'apns', 'manual', 'manual', 'dashboard',
        $3::timestamptz, $4::timestamptz)
RETURNING id::text`, tenantA, tokenHash[:], test.createdAt, test.updatedAt).Scan(&authorityID); err != nil {
				t.Fatalf("seed active authority: %v", err)
			}
			_, updateErr := admin.Exec(ctx, `
UPDATE push_suppression_authorities
   SET revoked_at = $2::timestamptz, version = version + 1
 WHERE id = $1::uuid`, authorityID, test.revokedAt)
			requirePushSuppressionPGError(t, updateErr, "23514", test.constraint)
		})
	}

	// A backward wall-clock reading must not wedge a legitimate manual
	// reversal. Simulate it by supplying an in-window timestamp older than the
	// fact; the trigger clamps public evidence and visibility monotonically while
	// the revision records the actual membership transition.
	rollbackDigest := sha256.Sum256([]byte("route43-clock-rollback-reversal"))
	var rollbackAuthorityID string
	if err := admin.QueryRow(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source,
     created_at, updated_at)
VALUES ($1::uuid, $2, 'apns', 'manual', 'manual', 'dashboard',
        '2024-01-01T00:00:00Z'::timestamptz,
        '2024-01-01T00:00:00Z'::timestamptz)
RETURNING id::text`, tenantA, rollbackDigest[:]).Scan(&rollbackAuthorityID); err != nil {
		t.Fatalf("seed clock-rollback authority: %v", err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE push_suppression_authorities
   SET revoked_at = '2001-01-01T00:00:00Z'::timestamptz,
       version = version + 1
 WHERE id = $1::uuid`, rollbackAuthorityID); err != nil {
		t.Fatalf("normalize clock-rollback reversal: %v", err)
	}
	var rollbackMonotonic bool
	if err := admin.QueryRow(ctx, `
SELECT revoked_at >= created_at AND updated_at >= revoked_at AND
       registry_hidden_at >= registry_visible_at AND
       registry_hidden_revision > registry_visible_revision AND version = 2
  FROM push_suppression_authorities
 WHERE id = $1::uuid`, rollbackAuthorityID).Scan(&rollbackMonotonic); err != nil {
		t.Fatalf("inspect clock-rollback reversal: %v", err)
	}
	if !rollbackMonotonic {
		t.Fatal("clock-rollback reversal lost monotonic evidence/revision invariants")
	}

	token := "route43-manual-provider-token-0123456789"
	added, err := store.AddManual(ctx, tenantA, ManualAdd{DeviceToken: token, Platform: "apns"}, meta)
	if err != nil {
		t.Fatalf("add manual authority: %v", err)
	}
	if !added.Created || added.Row.Source != "dashboard" || !added.Row.Reversible || added.Row.Version != 1 {
		t.Fatalf("unexpected manual projection: %+v", added)
	}
	digest := sha256.Sum256([]byte(token))

	// A future provider writer supplies open-ended internal provenance. The
	// public list must collapse it to source=provider while keeping the fact
	// immutable and independent from the dashboard/manual authority.
	var providerID string
	tx, err := db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source, source_event_id)
VALUES ($1::uuid, $2, 'apns', 'provider', 'expired', 'apns.feedback.prod', $3)
RETURNING id::text`, tenantA, digest[:], "evt-"+uuid.NewString()).Scan(&providerID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert provider fact: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
DELETE FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, providerID); err == nil {
		t.Fatal("direct administrative DELETE removed an authority fact while its tenant exists")
	} else {
		requirePushSuppressionPGError(t, err, "23514", "push_suppression_authority_delete_guard")
	}
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	_, appDeleteErr := tx.Exec(ctx, `
DELETE FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, providerID)
	_ = tx.Rollback(ctx)
	requirePushSuppressionPGError(t, appDeleteErr, "42501", "")

	listed, err := store.List(ctx, tenantA, ListFilter{Platform: "apns", Limit: 100}, meta)
	if err != nil {
		t.Fatalf("list authorities: %v", err)
	}
	found := map[string]Row{}
	for _, row := range listed.Items {
		found[row.ID] = row
	}
	if row := found[providerID]; row.Source != "provider" || row.Reversible || row.LockedReason != "provider_authority" {
		t.Fatalf("provider provenance was not minimized/locked: %+v", row)
	}
	if row := found[added.Row.ID]; row.Source != "dashboard" || !row.Reversible || row.LockedReason != "" {
		t.Fatalf("manual projection lost reversibility: %+v", row)
	}

	if _, err := store.RemoveManual(ctx, tenantA, RemoveRequest{ID: providerID, ExpectedVersion: 1}, meta); err == nil {
		t.Fatal("dashboard removed provider authority")
	} else {
		var locked *LockedError
		if !errors.As(err, &locked) || locked.Reason != "provider_authority" {
			t.Fatalf("provider removal error=%v", err)
		}
	}
	receipt, err := store.RemoveManual(ctx, tenantA, RemoveRequest{ID: added.Row.ID, ExpectedVersion: 1}, meta)
	if err != nil {
		t.Fatalf("remove manual authority: %v", err)
	}
	if !receipt.OK || receipt.TenantID != tenantA || receipt.ID != added.Row.ID || receipt.Version != 2 || !receipt.StillSuppressed {
		t.Fatalf("manual reversal receipt failed to retain stronger hold: %+v", receipt)
	}
	if _, err := store.RemoveManual(ctx, tenantA, RemoveRequest{ID: added.Row.ID, ExpectedVersion: 1}, meta); !errors.Is(err, ErrStale) {
		t.Fatalf("stale manual reversal error=%v want ErrStale", err)
	}

	// Advisory locking plus the partial unique index makes concurrent dashboard
	// retries converge on one active manual authority and one stable id.
	raceToken := "route43-concurrent-add-token-0123456789"
	const workers = 8
	start := make(chan struct{})
	results := make(chan AddResult, workers)
	errorsCh := make(chan error, workers)
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			result, addErr := store.AddManual(context.Background(), tenantA, ManualAdd{DeviceToken: raceToken, Platform: "fcm"}, meta)
			results <- result
			errorsCh <- addErr
		}()
	}
	close(start)
	group.Wait()
	close(results)
	close(errorsCh)
	for addErr := range errorsCh {
		if addErr != nil {
			t.Fatalf("concurrent add: %v", addErr)
		}
	}
	createdCount := 0
	convergedID := ""
	for result := range results {
		if result.Created {
			createdCount++
		}
		if convergedID == "" {
			convergedID = result.Row.ID
		} else if result.Row.ID != convergedID {
			t.Fatalf("concurrent retries returned different active facts: %s != %s", result.Row.ID, convergedID)
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent retries reported created=%d want 1", createdCount)
	}

	// The same CAS version cannot be consumed twice; the loser observes stale
	// state after the row lock and cannot issue a second successful reversal.
	removeStart := make(chan struct{})
	removeErrors := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-removeStart
			_, removeErr := store.RemoveManual(context.Background(), tenantA, RemoveRequest{ID: convergedID, ExpectedVersion: 1}, meta)
			removeErrors <- removeErr
		}()
	}
	close(removeStart)
	group.Wait()
	close(removeErrors)
	successes, stale := 0, 0
	for removeErr := range removeErrors {
		switch {
		case removeErr == nil:
			successes++
		case errors.Is(removeErr, ErrStale):
			stale++
		default:
			t.Fatalf("concurrent remove error=%v", removeErr)
		}
	}
	if successes != 1 || stale != 1 {
		t.Fatalf("CAS race results success=%d stale=%d", successes, stale)
	}

	// Bulk removal is one transaction. If a later item is provider-locked, an
	// earlier manual revocation and its audit append roll back together.
	bulkManual, err := store.AddManual(ctx, tenantA, ManualAdd{
		DeviceToken: "route43-bulk-rollback-manual-0123456789", Platform: "apns",
	}, meta)
	if err != nil {
		t.Fatalf("seed bulk manual: %v", err)
	}
	const bulkProviderID = "ffffffff-ffff-4fff-bfff-ffffffffffff"
	bulkProviderDigest := sha256.Sum256([]byte("route43-bulk-rollback-provider-0123456789"))
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (id, tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2::uuid, $3, 'apns', 'provider', 'unregistered', 'apns.feedback')`,
		bulkProviderID, tenantA, bulkProviderDigest[:]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed bulk provider: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = store.BulkRemoveManual(ctx, tenantA, []RemoveRequest{
		{ID: bulkManual.Row.ID, ExpectedVersion: 1},
		{ID: bulkProviderID, ExpectedVersion: 1},
	}, meta)
	var bulkLocked *LockedError
	if !errors.As(err, &bulkLocked) || bulkLocked.Reason != "provider_authority" {
		t.Fatalf("bulk locked error=%v", err)
	}
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	var bulkVersion int64
	var bulkRevoked *time.Time
	if err := tx.QueryRow(ctx, `
SELECT version, revoked_at
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, bulkManual.Row.ID).Scan(&bulkVersion, &bulkRevoked); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("verify bulk rollback: %v", err)
	}
	_ = tx.Rollback(ctx)
	if bulkVersion != 1 || bulkRevoked != nil {
		t.Fatalf("bulk conflict committed partial reversal: version=%d revoked_at=%v", bulkVersion, bulkRevoked)
	}

	// Simulate a released binary writing and then rewriting the one-row table.
	// Each change appends a review-locked fact; it cannot replace prior facts.
	// Capture a revision snapshot between the writes, then also add and revoke
	// manual facts. Replaying that revision must preserve the original active
	// membership and the pre-revocation version/updated_at evidence.
	legacyToken := "route43-old-writer-token-abcdefghij"
	legacyDigest := sha256.Sum256([]byte(legacyToken))
	var legacyID string
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO push_token_suppressions
    (tenant_id, device_token_hash, platform, reason, source, source_event_id)
VALUES ($1::uuid, $2, 'fcm', 'expired', 'firebase.feedback', $3)
RETURNING id::text`, tenantA, legacyDigest[:], "old-"+uuid.NewString()).Scan(&legacyID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	snapshotManual, err := store.AddManual(ctx, tenantA, ManualAdd{
		DeviceToken: "route43-snapshot-manual-token-0123456789", Platform: "apns",
	}, meta)
	if err != nil {
		t.Fatalf("seed snapshot manual authority: %v", err)
	}
	snapshotAnchor, err := store.AddManual(ctx, tenantA, ManualAdd{
		DeviceToken: "route43-snapshot-page-anchor-token-0123456789", Platform: "fcm",
	}, meta)
	if err != nil {
		t.Fatalf("seed snapshot page anchor: %v", err)
	}
	snapshot, err := store.List(ctx, tenantA, ListFilter{Limit: 100}, meta)
	if err != nil {
		t.Fatalf("capture authority revision snapshot: %v", err)
	}
	if snapshot.SnapshotRevision <= 0 || snapshot.Total != int64(len(snapshot.Items)) {
		t.Fatalf("unexpected complete snapshot revision=%d total=%d items=%d",
			snapshot.SnapshotRevision, snapshot.Total, len(snapshot.Items))
	}
	snapshotRows := make(map[string]Row, len(snapshot.Items))
	for _, row := range snapshot.Items {
		snapshotRows[row.ID] = row
	}
	firstPage, err := store.List(ctx, tenantA, ListFilter{Limit: 1}, meta)
	if err != nil {
		t.Fatalf("capture first authority snapshot page: %v", err)
	}
	if len(firstPage.Items) != 1 || !firstPage.HasMore || firstPage.Total != snapshot.Total ||
		firstPage.SnapshotRevision != snapshot.SnapshotRevision {
		t.Fatalf("unexpected first snapshot page: %+v complete-revision=%d", firstPage, snapshot.SnapshotRevision)
	}
	manualToRevoke := snapshotManual
	if manualToRevoke.Row.ID == firstPage.Items[0].ID {
		manualToRevoke = snapshotAnchor
	}
	if manualToRevoke.Row.ID == firstPage.Items[0].ID {
		t.Fatal("could not select a pre-snapshot manual authority beyond page one")
	}
	originalManual, ok := snapshotRows[manualToRevoke.Row.ID]
	if !ok || originalManual.Version != 1 || !originalManual.UpdatedAt.Equal(manualToRevoke.Row.UpdatedAt) {
		t.Fatalf("snapshot omitted original manual evidence: row=%+v added=%+v", originalManual, manualToRevoke.Row)
	}

	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE push_token_suppressions
   SET reason = 'unregistered'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, legacyID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer update: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	postSnapshotManual, err := store.AddManual(ctx, tenantA, ManualAdd{
		DeviceToken: "route43-post-snapshot-manual-token-0123456789", Platform: "fcm",
	}, meta)
	if err != nil {
		t.Fatalf("add post-snapshot manual authority: %v", err)
	}
	if _, err := store.RemoveManual(ctx, tenantA, RemoveRequest{
		ID: manualToRevoke.Row.ID, ExpectedVersion: manualToRevoke.Row.Version,
	}, meta); err != nil {
		t.Fatalf("remove pre-snapshot manual authority: %v", err)
	}
	replayedItems := append([]Row(nil), firstPage.Items...)
	page := firstPage
	for page.HasMore {
		last := page.Items[len(page.Items)-1]
		page, err = store.List(ctx, tenantA, ListFilter{
			Limit: 1, SnapshotAt: firstPage.SnapshotAt, SnapshotRevision: firstPage.SnapshotRevision,
			AfterAt: last.CreatedAt, AfterID: last.ID,
		}, meta)
		if err != nil {
			t.Fatalf("continue authority revision snapshot: %v", err)
		}
		if page.Total != snapshot.Total {
			t.Fatalf("snapshot total changed between pages: got=%d want=%d", page.Total, snapshot.Total)
		}
		replayedItems = append(replayedItems, page.Items...)
	}
	if len(replayedItems) != len(snapshot.Items) {
		t.Fatalf("snapshot membership drifted total/items %d/%d -> %d/%d",
			snapshot.Total, len(snapshot.Items), firstPage.Total, len(replayedItems))
	}
	seenReplayed := make(map[string]bool, len(replayedItems))
	for _, row := range replayedItems {
		if seenReplayed[row.ID] {
			t.Fatalf("authority %s appeared twice while paging revision %d", row.ID, firstPage.SnapshotRevision)
		}
		seenReplayed[row.ID] = true
		before, exists := snapshotRows[row.ID]
		if !exists {
			t.Fatalf("post-snapshot authority %s leaked into revision %d", row.ID, firstPage.SnapshotRevision)
		}
		if row.Version != before.Version || !row.UpdatedAt.Equal(before.UpdatedAt) {
			t.Fatalf("snapshot evidence changed for %s: version/time %d/%s -> %d/%s",
				row.ID, before.Version, before.UpdatedAt, row.Version, row.UpdatedAt)
		}
	}
	if _, exists := snapshotRows[postSnapshotManual.Row.ID]; exists {
		t.Fatalf("post-snapshot manual authority %s existed in original snapshot", postSnapshotManual.Row.ID)
	}
	var replayedManual Row
	for _, row := range replayedItems {
		if row.ID == manualToRevoke.Row.ID {
			replayedManual = row
			break
		}
	}
	if replayedManual.ID == "" || replayedManual.Version != 1 ||
		!replayedManual.UpdatedAt.Equal(originalManual.UpdatedAt) {
		t.Fatalf("revoked manual lost historical evidence in snapshot replay: %+v", replayedManual)
	}
	fresh, err := store.List(ctx, tenantA, ListFilter{Limit: 100}, meta)
	if err != nil {
		t.Fatalf("list fresh authority membership: %v", err)
	}
	freshRows := make(map[string]Row, len(fresh.Items))
	for _, row := range fresh.Items {
		freshRows[row.ID] = row
	}
	if fresh.Total != snapshot.Total+1 || int64(len(fresh.Items)) != fresh.Total {
		t.Fatalf("fresh membership total/items=%d/%d want %d", fresh.Total, len(fresh.Items), snapshot.Total+1)
	}
	if _, exists := freshRows[manualToRevoke.Row.ID]; exists {
		t.Fatalf("fresh membership retained revoked manual %s", manualToRevoke.Row.ID)
	}
	if _, exists := freshRows[postSnapshotManual.Row.ID]; !exists {
		t.Fatalf("fresh membership omitted post-snapshot manual %s", postSnapshotManual.Row.ID)
	}
	var legacyFacts int
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND platform = 'fcm' AND device_token_hash = $2
   AND authority = 'legacy_unknown' AND source = 'legacy' AND revoked_at IS NULL`, tenantA, legacyDigest[:]).Scan(&legacyFacts); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if legacyFacts != 2 {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer collision collapsed authority history: facts=%d", legacyFacts)
	}
	command, err := tx.Exec(ctx, `DELETE FROM push_token_suppressions WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, legacyID)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("guarded old delete: %v", err)
	}
	if command.RowsAffected() != 0 {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer deleted a review-locked projection: affected=%d", command.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	nestedConn, err := admin.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer nestedConn.Release()
	if _, err := nestedConn.Exec(ctx, `CREATE TEMP TABLE route43_nested_delete_probe (target_id uuid NOT NULL)`); err != nil {
		t.Fatalf("create nested delete probe: %v", err)
	}
	if _, err := nestedConn.Exec(ctx, `
CREATE FUNCTION pg_temp.route43_nested_delete_probe_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.push_token_suppressions WHERE id = NEW.target_id;
  RETURN NEW;
END
$$`); err != nil {
		t.Fatalf("create nested delete function: %v", err)
	}
	if _, err := nestedConn.Exec(ctx, `
CREATE TRIGGER route43_nested_delete_probe_trg
AFTER INSERT ON route43_nested_delete_probe
FOR EACH ROW EXECUTE FUNCTION pg_temp.route43_nested_delete_probe_fn()`); err != nil {
		t.Fatalf("create nested delete trigger: %v", err)
	}
	if _, err := nestedConn.Exec(ctx, `INSERT INTO route43_nested_delete_probe (target_id) VALUES ($1::uuid)`, legacyID); err != nil {
		t.Fatalf("synthetic nested delete probe: %v", err)
	}
	var legacyProjectionExists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM push_token_suppressions WHERE id = $1::uuid)`, legacyID).Scan(&legacyProjectionExists); err != nil {
		t.Fatal(err)
	}
	if !legacyProjectionExists {
		t.Fatal("unrelated nested trigger bypassed the strong-authority delete guard")
	}

	// Direct SQL cannot revoke a stronger fact through the application role.
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE push_suppression_authorities
   SET revoked_at = clock_timestamp(), version = version + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, providerID); err == nil {
		_ = tx.Rollback(ctx)
		t.Fatal("direct SQL revoked immutable provider authority")
	}
	_ = tx.Rollback(ctx)

	// Tenant B has an active fact, but tenant A's production role cannot see it
	// even with an explicit cross-tenant predicate or write one into B.
	tokenB := sha256.Sum256([]byte("route43-tenant-b-token-0123456789"))
	tx, err = db.WithTenant(ctx, app, tenantB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2, 'fcm', 'manual', 'manual', 'dashboard')`, tenantB, tokenB[:]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant B fact: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, app, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	var crossVisible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_suppression_authorities WHERE tenant_id = $1::uuid`, tenantB).Scan(&crossVisible); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if crossVisible != 0 {
		_ = tx.Rollback(ctx)
		t.Fatalf("RLS leaked %d tenant-B facts into tenant A", crossVisible)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2, 'fcm', 'manual', 'manual', 'dashboard')`, tenantB, digest[:]); err == nil {
		_ = tx.Rollback(ctx)
		t.Fatal("RLS permitted cross-tenant authority insert")
	}
	_ = tx.Rollback(ctx)

	// A no-GUC control-plane tenant deletion must retain ordinary FK cascade
	// semantics; the legacy delete guard permits only the real parent-absent
	// nested cascade, not arbitrary nested deletes.
	if _, err := admin.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantA); err != nil {
		t.Fatalf("no-GUC tenant cascade: %v", err)
	}
	for _, table := range []string{
		"push_suppression_authorities",
		"push_token_suppressions",
		"push_suppression_registry_state",
	} {
		var remaining int
		query := fmt.Sprintf(`SELECT count(*) FROM %s WHERE tenant_id = $1::uuid`, table)
		if err := admin.QueryRow(ctx, query, tenantA).Scan(&remaining); err != nil {
			t.Fatalf("verify %s cascade: %v", table, err)
		}
		if remaining != 0 {
			t.Fatalf("tenant cascade left %d rows in %s", remaining, table)
		}
	}
}

func TestLegacyDeploymentBarrierBlocksWriterUntilAuthoritySyncIsReady(t *testing.T) {
	adminURL, appURL := pushSuppressionDatabaseURLs(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("open restricted app pool: %v", err)
	}
	t.Cleanup(app.Close)

	tenantID := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Route43 legacy barrier proof', $2, 'studio')`,
		tenantID, "route43-barrier-"+tenantID); err != nil {
		t.Fatalf("seed barrier tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})

	barrierTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin deployment barrier: %v", err)
	}
	barrierOpen := true
	defer func() {
		if barrierOpen {
			_ = barrierTx.Rollback(context.Background())
		}
	}()
	// While held, this barrier blocks every tenant INSERT and DELETE in its
	// database, so it is only ever taken in the private one (see
	// authority_isolation_db_test.go), on the connection checked here.
	requireInPrivatePushSuppressionDatabase(t, ctx, barrierTx)
	if _, err := barrierTx.Exec(ctx, `
LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		t.Fatalf("hold tenant deployment barrier: %v", err)
	}
	if _, err := barrierTx.Exec(ctx, `
LOCK TABLE public.push_token_suppressions IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		t.Fatalf("hold legacy deployment barrier: %v", err)
	}
	var grantedBarriers int
	if err := barrierTx.QueryRow(ctx, `
SELECT count(*)::int
  FROM pg_catalog.pg_locks
 WHERE pid = pg_backend_pid()
   AND locktype = 'relation'
   AND mode = 'ShareRowExclusiveLock'
   AND granted
   AND relation IN ('public.tenants'::regclass, 'public.push_token_suppressions'::regclass)`).Scan(
		&grantedBarriers,
	); err != nil {
		t.Fatalf("inspect held deployment barriers: %v", err)
	}
	if grantedBarriers != 2 {
		t.Fatalf("granted deployment barriers=%d want 2", grantedBarriers)
	}

	type writerReady struct {
		pid int
		err error
	}
	type writerResult struct {
		legacyID string
		err      error
	}
	ready := make(chan writerReady, 1)
	done := make(chan writerResult, 1)
	tokenHash := sha256.Sum256([]byte("route43-deployment-barrier-token-0123456789"))
	sourceEventID := "barrier-" + uuid.NewString()
	go func() {
		writerCtx, writerCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer writerCancel()
		writerTx, writerErr := db.WithTenant(writerCtx, app, tenantID)
		if writerErr != nil {
			ready <- writerReady{err: writerErr}
			done <- writerResult{err: writerErr}
			return
		}
		defer func() { _ = writerTx.Rollback(writerCtx) }()
		var pid int
		if writerErr = writerTx.QueryRow(writerCtx, `SELECT pg_backend_pid()`).Scan(&pid); writerErr != nil {
			ready <- writerReady{err: writerErr}
			done <- writerResult{err: writerErr}
			return
		}
		ready <- writerReady{pid: pid}
		var legacyID string
		writerErr = writerTx.QueryRow(writerCtx, `
INSERT INTO push_token_suppressions
    (tenant_id, device_token_hash, platform, reason, source, source_event_id)
VALUES ($1::uuid, $2, 'fcm', 'expired', 'firebase.feedback', $3)
RETURNING id::text`, tenantID, tokenHash[:], sourceEventID).Scan(&legacyID)
		if writerErr == nil {
			writerErr = writerTx.Commit(writerCtx)
		}
		done <- writerResult{legacyID: legacyID, err: writerErr}
	}()

	var writer writerReady
	select {
	case writer = <-ready:
	case <-ctx.Done():
		t.Fatalf("wait for legacy writer backend: %v", ctx.Err())
	}
	if writer.err != nil {
		t.Fatalf("open legacy writer: %v", writer.err)
	}
	waitDeadline := time.Now().Add(5 * time.Second)
	waitingOnBarrier := false
	for time.Now().Before(waitDeadline) {
		if err := admin.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_locks
     WHERE pid = $1
       AND locktype = 'relation'
       AND relation = 'public.push_token_suppressions'::regclass
       AND mode = 'RowExclusiveLock'
       AND NOT granted
)`, writer.pid).Scan(&waitingOnBarrier); err != nil {
			t.Fatalf("inspect legacy writer barrier wait: %v", err)
		}
		if waitingOnBarrier {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waitingOnBarrier {
		t.Fatal("legacy writer was not observed waiting on the SHARE ROW EXCLUSIVE deployment barrier")
	}
	select {
	case result := <-done:
		t.Fatalf("legacy writer completed while deployment barrier was held: %+v", result)
	default:
	}
	var prematureAuthorities int
	if err := admin.QueryRow(ctx, `
SELECT count(*)::int
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND device_token_hash = $2`, tenantID, tokenHash[:]).Scan(
		&prematureAuthorities,
	); err != nil {
		t.Fatalf("inspect authority visibility while barrier held: %v", err)
	}
	if prematureAuthorities != 0 {
		t.Fatalf("legacy sync produced %d authorities before barrier release", prematureAuthorities)
	}

	if err := barrierTx.Commit(ctx); err != nil {
		t.Fatalf("release legacy deployment barrier: %v", err)
	}
	barrierOpen = false
	var result writerResult
	select {
	case result = <-done:
	case <-ctx.Done():
		t.Fatalf("legacy writer did not complete after barrier release: %v", ctx.Err())
	}
	if result.err != nil {
		t.Fatalf("legacy writer after barrier release: %v", result.err)
	}

	var legacyRows, syncedAuthorities int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*)::int
          FROM push_token_suppressions
         WHERE tenant_id = $1::uuid AND id = $2::uuid),
       (SELECT count(*)::int
          FROM push_suppression_authorities
         WHERE tenant_id = $1::uuid
           AND legacy_suppression_id = $2::uuid
           AND device_token_hash = $3
           AND platform = 'fcm'
		   AND authority = 'legacy_unknown'
		   AND reason = 'expired'
		   AND source = 'legacy'
		   AND registry_visible_revision > 0
		   AND revoked_at IS NULL)`, tenantID, result.legacyID, tokenHash[:]).Scan(
		&legacyRows, &syncedAuthorities,
	); err != nil {
		t.Fatalf("verify post-barrier legacy synchronization: %v", err)
	}
	if legacyRows != 1 || syncedAuthorities != 1 {
		t.Fatalf("post-barrier legacy/authority rows=%d/%d want 1/1", legacyRows, syncedAuthorities)
	}
}
