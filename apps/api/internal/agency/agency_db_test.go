// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newAgencyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type seededTenant struct {
	ID   string
	Slug string
}

func seedTenant(t *testing.T, pool *pgxpool.Pool, agency bool, parentID string) seededTenant {
	t.Helper()
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("generate id: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, id); err != nil {
		t.Fatalf("bind seed tenant: %v", err)
	}
	slug := "agency-test-" + randSuffix(t)
	var parent *string
	if parentID != "" {
		parent = &parentID
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, is_agency_account, parent_tenant_id)
VALUES ($1::uuid, $2, $3, 'studio', $4, $5::uuid)`,
		id, slug, "Agency test "+slug, agency, parent); err != nil {
		t.Fatalf("insert seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, id)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, id); err == nil {
			_ = cleanup.Commit(context.Background())
		}
	})
	return seededTenant{ID: id, Slug: slug}
}

func agencyContext(tenantID string) context.Context {
	return middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID: tenantID, Slug: "agency-test", Name: "Agency test", Tier: "studio",
	})
}

func restrictedRuntimeRole(t *testing.T, pool *pgxpool.Pool) bool {
	t.Helper()
	var superuser, bypass bool
	if err := pool.QueryRow(t.Context(), `
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
	).Scan(&superuser, &bypass); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	return !superuser && !bypass
}

func TestAgencyRosterDefinerIsolationAndPagination(t *testing.T) {
	pool := newAgencyTestPool(t)
	parentA := seedTenant(t, pool, true, "")
	childA1 := seedTenant(t, pool, false, parentA.ID)
	childA2 := seedTenant(t, pool, false, parentA.ID)
	parentB := seedTenant(t, pool, true, "")
	childB := seedTenant(t, pool, false, parentB.ID)
	nonAgency := seedTenant(t, pool, false, "")
	_ = childB

	d := &Deps{Pool: pool}
	firstReq := httptest.NewRequest(http.MethodGet, "/api/v1/agency/children?limit=1", nil).
		WithContext(agencyContext(parentA.ID))
	first := httptest.NewRecorder()
	d.ListChildren(first, firstReq)
	if first.Code != http.StatusOK {
		t.Fatalf("first page: status=%d body=%s", first.Code, first.Body.String())
	}
	var page1 childrenResponse
	if err := json.Unmarshal(first.Body.Bytes(), &page1); err != nil {
		t.Fatalf("decode first page: %v", err)
	}
	if page1.Count != 1 || !page1.HasMore || page1.NextCursor == "" || len(page1.Children) != 1 {
		t.Fatalf("first page metadata=%+v", page1)
	}
	if !strings.Contains(first.Body.String(), `"next_cursor"`) {
		t.Fatalf("continuation page omitted next_cursor: %s", first.Body.String())
	}
	secondReq := httptest.NewRequest(http.MethodGet,
		"/api/v1/agency/children?limit=1&cursor="+page1.NextCursor, nil).
		WithContext(agencyContext(parentA.ID))
	second := httptest.NewRecorder()
	d.ListChildren(second, secondReq)
	if second.Code != http.StatusOK {
		t.Fatalf("second page: status=%d body=%s", second.Code, second.Body.String())
	}
	var page2 childrenResponse
	if err := json.Unmarshal(second.Body.Bytes(), &page2); err != nil {
		t.Fatalf("decode second page: %v", err)
	}
	if page2.Count != 1 || page2.HasMore || page2.NextCursor != "" ||
		page2.Children[0].ID == page1.Children[0].ID {
		t.Fatalf("second page metadata=%+v", page2)
	}
	if strings.Contains(second.Body.String(), `"next_cursor"`) {
		t.Fatalf("terminal page emitted next_cursor: %s", second.Body.String())
	}
	want := map[string]bool{childA1.ID: true, childA2.ID: true}
	if !want[page1.Children[0].ID] || !want[page2.Children[0].ID] {
		t.Fatalf("parent A received wrong roster: %+v %+v", page1.Children, page2.Children)
	}

	deniedReq := httptest.NewRequest(http.MethodGet, "/api/v1/agency/children", nil).
		WithContext(agencyContext(nonAgency.ID))
	denied := httptest.NewRecorder()
	d.ListChildren(denied, deniedReq)
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "not_agency") {
		t.Fatalf("non-agency list: status=%d body=%s", denied.Code, denied.Body.String())
	}

	if !restrictedRuntimeRole(t, pool) {
		t.Skip("direct RLS assertions require TEST_DATABASE_URL with postwave_app")
	}
	tx, err := db.WithTenant(t.Context(), pool, parentA.ID)
	if err != nil {
		t.Fatalf("parent scope: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var directChildren int
	if err := tx.QueryRow(t.Context(), `
SELECT count(*) FROM tenants WHERE parent_tenant_id = $1::uuid`, parentA.ID,
	).Scan(&directChildren); err != nil {
		t.Fatalf("direct child query: %v", err)
	}
	if directChildren != 0 {
		t.Fatalf("ambient parent tenants policy exposed %d child rows", directChildren)
	}
	var crossRoster int
	if err := tx.QueryRow(t.Context(), `
SELECT count(*) FROM agency_list_children($1::uuid, NULL, NULL, 201)`, parentB.ID,
	).Scan(&crossRoster); err != nil {
		t.Fatalf("cross roster call: %v", err)
	}
	if crossRoster != 0 {
		t.Fatalf("parent A enumerated %d parent B roster rows", crossRoster)
	}
}

func TestAgencyRosterFailsClosedOnHostileLegacyRow(t *testing.T) {
	pool := newAgencyTestPool(t)
	parent := seedTenant(t, pool, true, "")
	valid := seedTenant(t, pool, false, parent.ID)
	hostile := seedTenant(t, pool, false, parent.ID)

	tx, err := db.WithTenant(t.Context(), pool, hostile.ID)
	if err != nil {
		t.Fatalf("hostile child scope: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
UPDATE tenants
   SET slug = $2,
       name = $3
 WHERE id = $1::uuid`, hostile.ID, "INVALID-LEGACY-SLUG", strings.Repeat("LEAK-ME-", 20)); err != nil {
		t.Fatalf("store hostile legacy child: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit hostile legacy child: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/agency/children", nil).
		WithContext(agencyContext(parent.ID))
	recorder := httptest.NewRecorder()
	(&Deps{Pool: pool}).ListChildren(recorder, req)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("hostile roster status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "LEAK-ME") ||
		strings.Contains(recorder.Body.String(), valid.ID) ||
		strings.Contains(recorder.Body.String(), `"children"`) {
		t.Fatalf("hostile roster leaked raw or partial projection: %s", recorder.Body.String())
	}
}

func TestAgencyLegacyAggregatorCannotRevealEvents(t *testing.T) {
	pool := newAgencyTestPool(t)
	if !restrictedRuntimeRole(t, pool) {
		t.Skip("RLS assertion requires TEST_DATABASE_URL with postwave_app")
	}
	parent := seedTenant(t, pool, true, "")
	child := seedTenant(t, pool, false, parent.ID)

	childTx, err := db.WithTenant(t.Context(), pool, child.ID)
	if err != nil {
		t.Fatalf("child scope: %v", err)
	}
	if _, err := childTx.Exec(t.Context(), `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2, 'opened', now())`, child.ID, "agency-isolation@example.test"); err != nil {
		_ = childTx.Rollback(t.Context())
		t.Fatalf("seed subscriber event: %v", err)
	}
	if err := childTx.Commit(t.Context()); err != nil {
		t.Fatalf("commit event: %v", err)
	}
	historyTx, err := db.WithTenant(t.Context(), pool, child.ID)
	if err != nil {
		t.Fatalf("child history scope: %v", err)
	}
	if _, err := historyTx.Exec(t.Context(), `
INSERT INTO tenant_billing_mode_history
  (tenant_id, parent_tenant_id, prev_mode, new_mode, reason)
VALUES ($1::uuid, $2::uuid, 'self', 'parent', 'rls isolation fixture')`,
		child.ID, parent.ID); err != nil {
		_ = historyTx.Rollback(t.Context())
		t.Fatalf("seed billing history: %v", err)
	}
	if err := historyTx.Commit(t.Context()); err != nil {
		t.Fatalf("commit billing history: %v", err)
	}

	parentTx, err := db.WithTenant(t.Context(), pool, parent.ID)
	if err != nil {
		t.Fatalf("parent scope: %v", err)
	}
	defer func() { _ = parentTx.Rollback(t.Context()) }()
	if _, err := parentTx.Exec(t.Context(),
		`SELECT set_config('app.agency_aggregator', $1, true)`, parent.ID); err != nil {
		t.Fatalf("set attacker-controlled legacy GUC: %v", err)
	}
	var visible int
	if err := parentTx.QueryRow(t.Context(), `
SELECT count(*) FROM subscriber_events WHERE tenant_id = $1::uuid`, child.ID,
	).Scan(&visible); err != nil {
		t.Fatalf("event query: %v", err)
	}
	if visible != 0 {
		t.Fatalf("legacy app.agency_aggregator exposed %d child events", visible)
	}
	var visibleHistory int
	if err := parentTx.QueryRow(t.Context(), `
SELECT count(*) FROM tenant_billing_mode_history WHERE tenant_id = $1::uuid`, child.ID,
	).Scan(&visibleHistory); err != nil {
		t.Fatalf("billing history query: %v", err)
	}
	if visibleHistory != 0 {
		t.Fatalf("parent scope exposed %d child billing-history rows", visibleHistory)
	}
	var forbiddenPolicies int
	if err := parentTx.QueryRow(t.Context(), `
SELECT count(*) FROM pg_policies
 WHERE schemaname = 'public'
   AND policyname IN ('subscriber_events_agency_aggregator',
                      'subscriber_events_agency_parent_select',
                      'tenant_agency_children_select')`,
	).Scan(&forbiddenPolicies); err != nil {
		t.Fatalf("inspect policies: %v", err)
	}
	if forbiddenPolicies != 0 {
		t.Fatalf("%d ambient agency policies remain", forbiddenPolicies)
	}
	var legacyView *string
	if err := parentTx.QueryRow(t.Context(),
		`SELECT to_regclass('public.agency_child_usage_v')::text`).Scan(&legacyView); err != nil {
		t.Fatalf("inspect legacy view: %v", err)
	}
	if legacyView != nil {
		t.Fatalf("legacy globally enumerable view remains: %s", *legacyView)
	}
	var indexValid, indexReady bool
	if err := parentTx.QueryRow(t.Context(), `
SELECT i.indisvalid, i.indisready
  FROM pg_index AS i
  JOIN pg_class AS c ON c.oid = i.indexrelid
 WHERE c.relname = 'idx_tenants_agency_roster_page'`,
	).Scan(&indexValid, &indexReady); err != nil {
		t.Fatalf("inspect roster paging index: %v", err)
	}
	if !indexValid || !indexReady {
		t.Fatalf("roster paging index valid=%v ready=%v", indexValid, indexReady)
	}
}

func TestAgencyDatabaseInvariants(t *testing.T) {
	pool := newAgencyTestPool(t)
	one := seedTenant(t, pool, false, "")
	two := seedTenant(t, pool, false, "")

	setBrandingDomain := func(tenantID string) error {
		tx, err := db.WithTenant(t.Context(), pool, tenantID)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		if _, err := tx.Exec(t.Context(), `
UPDATE tenants
   SET whitelabel_enabled = true,
       whitelabel_custom_domain = 'collision.customer.example'
 WHERE id = $1::uuid`, tenantID); err != nil {
			return err
		}
		return tx.Commit(t.Context())
	}
	if err := setBrandingDomain(one.ID); err != nil {
		t.Fatalf("reserve first domain: %v", err)
	}
	err := setBrandingDomain(two.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("duplicate custom domain error=%v, want SQLSTATE 23505", err)
	}

	tx, err := db.WithTenant(t.Context(), pool, two.ID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	_, err = tx.Exec(t.Context(), `UPDATE tenants SET billing_mode = 'parent' WHERE id = $1::uuid`, two.ID)
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" ||
		pgErr.ConstraintName != "tenants_parent_billing_requires_parent" {
		t.Fatalf("orphan parent billing error=%v, want invariant violation", err)
	}
}

func TestAgencyBrandingReadSanitizesLegacyValues(t *testing.T) {
	pool := newAgencyTestPool(t)
	tenant := seedTenant(t, pool, false, "")
	d := &Deps{Pool: pool}

	setStored := func(values ...any) {
		t.Helper()
		tx, err := db.WithTenant(t.Context(), pool, tenant.ID)
		if err != nil {
			t.Fatalf("tenant branding scope: %v", err)
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		if _, err := tx.Exec(t.Context(), `
UPDATE tenants
   SET whitelabel_enabled = true,
       whitelabel_brand_name = $2,
       whitelabel_custom_domain = $3,
       whitelabel_logo_url = $4,
       whitelabel_primary_color = $5,
       whitelabel_support_email = $6,
       whitelabel_legal_entity = $7,
       agency_branding_updated_at = clock_timestamp(),
       agency_branding_revision = agency_branding_revision + 1
 WHERE id = $1::uuid`, append([]any{tenant.ID}, values...)...); err != nil {
			t.Fatalf("store legacy branding: %v", err)
		}
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatalf("commit legacy branding: %v", err)
		}
	}
	read := func() brandingFields {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/agency/branding", nil).
			WithContext(agencyContext(tenant.ID))
		recorder := httptest.NewRecorder()
		d.GetBranding(recorder, req)
		if recorder.Code != http.StatusOK {
			t.Fatalf("get branding status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var got brandingFields
		if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode branding: %v", err)
		}
		if !got.Enabled || got.UpdatedAt.IsZero() || got.ETag == "" ||
			recorder.Header().Get("ETag") != got.ETag {
			t.Fatalf("branding truth/header lost: header=%q body=%+v", recorder.Header().Get("ETag"), got)
		}
		return got
	}

	setStored(
		"spoof\u202e", "localhost", "https://127.0.0.1/auditor.png",
		"#FFFFFF", "Display <audit@customer.example>", strings.Repeat("L", 201),
	)
	hostile := read()
	if hostile.BrandName != "" || hostile.CustomDomain != "" || hostile.LogoURL != "" ||
		hostile.PrimaryColor != "" || hostile.SupportEmail != "" || hostile.LegalEntity != "" {
		t.Fatalf("unsafe legacy branding escaped projection: %+v", hostile)
	}

	setStored(
		"Customer Audit", "BÜCHER.Example.COM", "https://ASSETS.Example.COM/logo.svg",
		"#1d4ed8", "Audit@Customer.Example.COM", "Customer Limited",
	)
	valid := read()
	if valid.BrandName != "Customer Audit" || valid.CustomDomain != "xn--bcher-kva.example.com" ||
		valid.LogoURL != "https://assets.example.com/logo.svg" || valid.PrimaryColor != "#1D4ED8" ||
		valid.SupportEmail != "Audit@customer.example.com" || valid.LegalEntity != "Customer Limited" {
		t.Fatalf("valid legacy branding was not normalized: %+v", valid)
	}
	if valid.ETag == hostile.ETag || valid.UpdatedAt.Equal(hostile.UpdatedAt) {
		t.Fatalf("branding change did not advance its validator: before=%+v after=%+v", hostile, valid)
	}

	// The generic tenants trigger advances updated_at for every tenant update.
	// That unrelated activity must not change branding's body timestamp or ETag.
	tx, err := db.WithTenant(t.Context(), pool, tenant.ID)
	if err != nil {
		t.Fatalf("tenant update scope: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var tenantUpdatedBefore, tenantUpdatedAfter time.Time
	if err := tx.QueryRow(t.Context(), `SELECT updated_at FROM tenants WHERE id = $1::uuid`, tenant.ID).
		Scan(&tenantUpdatedBefore); err != nil {
		t.Fatalf("read tenant updated_at: %v", err)
	}
	if err := tx.QueryRow(t.Context(), `
UPDATE tenants SET name = name WHERE id = $1::uuid RETURNING updated_at`, tenant.ID,
	).Scan(&tenantUpdatedAfter); err != nil {
		t.Fatalf("touch unrelated tenant field: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit unrelated tenant update: %v", err)
	}
	if !tenantUpdatedAfter.After(tenantUpdatedBefore) {
		t.Fatalf("generic tenant timestamp did not advance: before=%s after=%s",
			tenantUpdatedBefore, tenantUpdatedAfter)
	}
	stable := read()
	if !stable.UpdatedAt.Equal(valid.UpdatedAt) || stable.ETag != valid.ETag {
		t.Fatalf("unrelated tenant update changed branding validator: before=%+v after=%+v", valid, stable)
	}
}

func TestAgencyRosterDefinerLeastPrivilege(t *testing.T) {
	pool := newAgencyTestPool(t)
	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	if err := pool.QueryRow(t.Context(), `
SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
       rolreplication, rolbypassrls
  FROM pg_roles
 WHERE rolname = 'postwave_agency_roster_definer'`,
	).Scan(&canLogin, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS); err != nil {
		t.Fatalf("inspect roster definer: %v", err)
	}
	if canLogin || superuser || createDB || createRole || inherit || replication || !bypassRLS {
		t.Fatalf("unsafe roster definer attributes login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypass=%v",
			canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	var memberships int
	if err := pool.QueryRow(t.Context(), `
SELECT count(*)
  FROM pg_auth_members
 WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')
    OR roleid = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')`,
	).Scan(&memberships); err != nil {
		t.Fatalf("inspect roster definer memberships: %v", err)
	}
	if memberships != 0 {
		t.Fatalf("roster definer has %d role memberships", memberships)
	}

	var schemaCreate, eventPrivilege, historyPrivilege bool
	if err := pool.QueryRow(t.Context(), `
SELECT has_schema_privilege('postwave_agency_roster_definer', 'public', 'CREATE'),
       has_table_privilege('postwave_agency_roster_definer', 'public.subscriber_events',
                           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
       has_table_privilege('postwave_agency_roster_definer', 'public.tenant_billing_mode_history',
                           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
	).Scan(&schemaCreate, &eventPrivilege, &historyPrivilege); err != nil {
		t.Fatalf("inspect definer privileges: %v", err)
	}
	if schemaCreate || eventPrivilege || historyPrivilege {
		t.Fatalf("definer privilege expansion schema_create=%v subscriber_events=%v billing_history=%v",
			schemaCreate, eventPrivilege, historyPrivilege)
	}
	var tablePrivileges, sequencePrivileges, unexpectedOwners int
	if err := pool.QueryRow(t.Context(), `
SELECT count(*)
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND has_table_privilege(
       'postwave_agency_roster_definer', c.oid,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
   )`,
	).Scan(&tablePrivileges); err != nil {
		t.Fatalf("inspect definer table privileges: %v", err)
	}
	if err := pool.QueryRow(t.Context(), `
WITH sequences AS MATERIALIZED (
    SELECT c.oid
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
)
SELECT count(*)
  FROM sequences
 WHERE has_sequence_privilege(
     'postwave_agency_roster_definer', oid, 'USAGE,SELECT,UPDATE'
 )`,
	).Scan(&sequencePrivileges); err != nil {
		t.Fatalf("inspect definer sequence privileges: %v", err)
	}
	if err := pool.QueryRow(t.Context(), `
SELECT
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner = role.oid) +
    (SELECT count(*) FROM pg_catalog.pg_type WHERE typowner = role.oid) +
    (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = role.oid) +
    (SELECT count(*) FROM pg_catalog.pg_proc
      WHERE proowner = role.oid
        AND oid <> 'public.agency_list_children(uuid,timestamptz,uuid,integer)'::regprocedure)
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname = 'postwave_agency_roster_definer'`,
	).Scan(&unexpectedOwners); err != nil {
		t.Fatalf("inspect definer ownership: %v", err)
	}
	if tablePrivileges != 0 || sequencePrivileges != 0 || unexpectedOwners != 0 {
		t.Fatalf("definer authority expansion tables=%d sequences=%d owned_objects=%d",
			tablePrivileges, sequencePrivileges, unexpectedOwners)
	}

	// information_schema.column_privileges intentionally hides grants between
	// unrelated roles from postwave_app. Inspect the catalogue ACL directly so
	// this assertion still exercises the restricted runtime connection.
	rows, err := pool.Query(t.Context(), `
SELECT a.attname
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(a.attacl, pg_catalog.acldefault('c', c.relowner))
 ) AS acl
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
 WHERE n.nspname = 'public'
   AND c.relname = 'tenants'
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND grantee.rolname = 'postwave_agency_roster_definer'
   AND acl.privilege_type = 'SELECT'
   AND NOT acl.is_grantable
 ORDER BY a.attname`)
	if err != nil {
		t.Fatalf("inspect definer column grants: %v", err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatalf("scan definer grant: %v", err)
		}
		columns = append(columns, column)
	}
	wantColumns := []string{
		"billing_mode", "created_at", "id", "is_agency_account", "name",
		"parent_tenant_id", "reseller_markup_bps", "slug", "tier", "updated_at",
		"whitelabel_enabled",
	}
	if fmt.Sprint(columns) != fmt.Sprint(wantColumns) {
		t.Fatalf("definer tenant columns=%v want %v", columns, wantColumns)
	}
	var unexpectedColumnPrivileges int
	if err := pool.QueryRow(t.Context(), `
SELECT count(*)
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(a.attacl, pg_catalog.acldefault('c', c.relowner))
 ) AS acl
  JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
 WHERE n.nspname = 'public'
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND grantee.rolname = 'postwave_agency_roster_definer'
   AND (c.relname <> 'tenants' OR acl.privilege_type <> 'SELECT' OR acl.is_grantable)`,
	).Scan(&unexpectedColumnPrivileges); err != nil {
		t.Fatalf("inspect unexpected definer column privileges: %v", err)
	}
	if unexpectedColumnPrivileges != 0 {
		t.Fatalf("definer has %d unexpected column privileges", unexpectedColumnPrivileges)
	}

	var owner string
	var appExec, publicExec bool
	if err := pool.QueryRow(t.Context(), `
SELECT pg_get_userbyid(p.proowner),
       has_function_privilege(
           'postwave_app',
           'public.agency_list_children(uuid,timestamptz,uuid,integer)',
           'EXECUTE'
       ),
       has_function_privilege(
           'public',
           'public.agency_list_children(uuid,timestamptz,uuid,integer)',
           'EXECUTE'
       )
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'agency_list_children'`,
	).Scan(&owner, &appExec, &publicExec); err != nil {
		t.Fatalf("inspect roster function ACL: %v", err)
	}
	if owner != "postwave_agency_roster_definer" || !appExec || publicExec || owner == "postwave_app" {
		t.Fatalf("roster function owner=%q app_execute=%v public_execute=%v", owner, appExec, publicExec)
	}

	var revisionValid bool
	if err := pool.QueryRow(t.Context(), `
SELECT convalidated
  FROM pg_catalog.pg_constraint
 WHERE conrelid = 'public.tenants'::regclass
   AND conname = 'tenants_agency_branding_revision_nonnegative'`,
	).Scan(&revisionValid); err != nil {
		t.Fatalf("inspect branding revision constraint: %v", err)
	}
	if !revisionValid {
		t.Fatal("branding revision constraint is not validated")
	}
}

func TestAgencyHeldCapabilitiesCommitNoState(t *testing.T) {
	pool := newAgencyTestPool(t)
	parent := seedTenant(t, pool, true, "")
	child := seedTenant(t, pool, false, parent.ID)
	d := &Deps{Pool: pool}

	seedBranding, err := db.WithTenant(t.Context(), pool, parent.ID)
	if err != nil {
		t.Fatalf("parent branding scope: %v", err)
	}
	if _, err := seedBranding.Exec(t.Context(), `
UPDATE tenants SET whitelabel_brand_name = 'Before hold'
 WHERE id = $1::uuid`, parent.ID); err != nil {
		_ = seedBranding.Rollback(t.Context())
		t.Fatalf("seed branding: %v", err)
	}
	if err := seedBranding.Commit(t.Context()); err != nil {
		t.Fatalf("commit branding seed: %v", err)
	}
	getBrandingReq := httptest.NewRequest(http.MethodGet, "/api/v1/agency/branding", nil).
		WithContext(agencyContext(parent.ID))
	getBranding := httptest.NewRecorder()
	d.GetBranding(getBranding, getBrandingReq)
	if getBranding.Code != http.StatusOK {
		t.Fatalf("get branding status=%d body=%s", getBranding.Code, getBranding.Body.String())
	}
	var branding brandingFields
	if err := json.Unmarshal(getBranding.Body.Bytes(), &branding); err != nil {
		t.Fatalf("decode branding: %v", err)
	}
	if branding.ETag == "" || getBranding.Header().Get("ETag") != branding.ETag ||
		!strings.HasSuffix(branding.ETag, ":v0\"") || branding.BrandName != "Before hold" ||
		branding.CustomDomain != "" || branding.LogoURL != "" || branding.SupportEmail != "" ||
		branding.UpdatedAt.IsZero() {
		t.Fatalf("branding contract header=%q body=%+v", getBranding.Header().Get("ETag"), branding)
	}

	assertHeld := func(name, method, path, body string, prepare func(*http.Request), invoke func(http.ResponseWriter, *http.Request)) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(method, path, bytes.NewBufferString(body)).WithContext(agencyContext(parent.ID))
			if body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			if prepare != nil {
				prepare(req)
			}
			recorder := httptest.NewRecorder()
			invoke(recorder, req)
			if recorder.Code != http.StatusServiceUnavailable ||
				recorder.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted {
				t.Fatalf("status=%d outcome=%q body=%s", recorder.Code,
					recorder.Header().Get(MutationOutcomeHeader), recorder.Body.String())
			}
		})
	}

	assertHeld("create", http.MethodPost, "/api/v1/agency/children",
		`{"slug":"held-child","name":"Held child"}`, nil, d.CreateChild)
	assertHeld("billing", http.MethodPost, "/api/v1/agency/billing-mode",
		fmt.Sprintf(`{"target_tenant_id":%q,"mode":"parent","reason":"test hold"}`, child.ID), nil, d.SetBillingMode)
	unlinkReq := httptest.NewRequest(http.MethodDelete, "/api/v1/agency/children/"+child.ID, nil)
	unlinkReq = unlinkReq.WithContext(withChildIDParam(agencyContext(parent.ID), child.ID))
	unlink := httptest.NewRecorder()
	d.UnlinkChild(unlink, unlinkReq)
	if unlink.Code != http.StatusServiceUnavailable || unlink.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted {
		t.Fatalf("unlink status=%d outcome=%q body=%s", unlink.Code,
			unlink.Header().Get(MutationOutcomeHeader), unlink.Body.String())
	}
	assertHeld("branding", http.MethodPatch, "/api/v1/agency/branding",
		`{"brand_name":"Held brand","primary_color":"#1D4ED8"}`,
		func(req *http.Request) { req.Header.Set("If-Match", branding.ETag) }, d.UpdateBranding)

	invoiceReq := httptest.NewRequest(http.MethodGet, "/api/v1/agency/invoice-preview?days=30", nil).
		WithContext(agencyContext(parent.ID))
	invoice := httptest.NewRecorder()
	d.InvoicePreview(invoice, invoiceReq)
	if invoice.Code != http.StatusServiceUnavailable || strings.Contains(invoice.Body.String(), "subtotal_usd") {
		t.Fatalf("invoice hold status=%d body=%s", invoice.Code, invoice.Body.String())
	}

	// The child remains linked and self billed, and no child-create row exists.
	childTx, err := db.WithTenant(t.Context(), pool, child.ID)
	if err != nil {
		t.Fatalf("child scope: %v", err)
	}
	defer func() { _ = childTx.Rollback(t.Context()) }()
	var parentID *string
	var mode string
	if err := childTx.QueryRow(t.Context(), `
SELECT parent_tenant_id::text, billing_mode FROM tenants WHERE id = $1::uuid`, child.ID,
	).Scan(&parentID, &mode); err != nil {
		t.Fatalf("read held child: %v", err)
	}
	if parentID == nil || *parentID != parent.ID || mode != "self" {
		t.Fatalf("held mutations changed child parent=%v mode=%q", parentID, mode)
	}
	var history int
	if err := childTx.QueryRow(t.Context(), `SELECT count(*) FROM tenant_billing_mode_history`).Scan(&history); err != nil {
		t.Fatalf("count history: %v", err)
	}
	if history != 0 {
		t.Fatalf("held mutations wrote %d billing history rows", history)
	}
	_ = childTx.Commit(t.Context())

	parentTx, err := db.WithTenant(t.Context(), pool, parent.ID)
	if err != nil {
		t.Fatalf("parent scope: %v", err)
	}
	defer func() { _ = parentTx.Rollback(t.Context()) }()
	var created int
	if err := parentTx.QueryRow(t.Context(), `
SELECT count(*) FROM agency_list_children($1::uuid, NULL, NULL, 201)
 WHERE slug = 'held-child'`, parent.ID).Scan(&created); err != nil {
		t.Fatalf("count held create: %v", err)
	}
	if created != 0 {
		t.Fatalf("held create wrote %d tenant rows", created)
	}
	var brandAfter string
	var revisionAfter int64
	if err := parentTx.QueryRow(t.Context(), `
SELECT COALESCE(whitelabel_brand_name, ''), agency_branding_revision
  FROM tenants WHERE id = $1::uuid`, parent.ID).Scan(&brandAfter, &revisionAfter); err != nil {
		t.Fatalf("read branding after hold: %v", err)
	}
	if brandAfter != "Before hold" || revisionAfter != 0 {
		t.Fatalf("held branding changed brand=%q revision=%d", brandAfter, revisionAfter)
	}
}
