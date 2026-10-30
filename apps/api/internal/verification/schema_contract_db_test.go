// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestVerificationResultContractMigrationPinsInternalAmbiguityAndIdentityBounds(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "2001_verification_result_contract.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read verification result contract migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"verification_cache_email_contract_check",
		"verification_cache_semantics_contract_check",
		"verification_job_items_email_contract_check",
		"verification_job_items_projection_contract_check",
		"verification_contract_text_valid",
		"provider_response_ambiguous",
		"role_based_accept_all",
		"ai_agent_mailbox",
		"mx_forward",
		"email = lower(btrim(email))",
		"NOT VALID",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing %q", required)
		}
	}
}

func TestVerificationPolicyRejectableContractExcludesValidEvidence(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "2005_verification_policy_rejectable_contract.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read verification policy contract migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"verification_policy_rejectable_statuses_contract_check",
		"cardinality(forms_reject_statuses) BETWEEN 1 AND 6",
		"'invalid', 'catch_all', 'spamtrap'",
		"'abuse', 'do_not_mail', 'unknown'",
		"NOT VALID",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("policy contract migration missing %q", required)
		}
	}
	if strings.Contains(sql, "'valid'") {
		t.Fatal("policy rejection allowlist unexpectedly contains valid")
	}
}

func TestVerificationSubscriberIdentityPredicateMigrationIsTenantBoundAndNarrow(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "2006_verification_subscriber_email_identity_predicate.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read verification subscriber identity migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"postwave_verification_identity_resolver",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION BYPASSRLS",
		"GRANT SELECT (tenant_id, email) ON public.subscriber_emails",
		"pg_catalog.current_setting('app.tenant_id', true)",
		"verification_subscriber_email_identity_exists",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog, pg_temp",
		"SET row_security = off",
		"OWNER TO postwave_verification_identity_resolver",
		"FROM PUBLIC, postwave_public, postwave_app",
		"TO postwave_app",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("subscriber identity migration missing %q", required)
		}
	}
	if strings.Contains(sql, "EXECUTE FORMAT") || strings.Contains(sql, "EXECUTE IMMEDIATE") {
		t.Fatal("subscriber identity predicate unexpectedly contains dynamic SQL")
	}
}

func TestDBVerificationSubscriberIdentityPredicateSecurityContract(t *testing.T) {
	pool := verificationDB(t)
	ctx := context.Background()
	var owner string
	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	var securityDefiner, stable, returnsBool, namesPgTemp, rowSecurityOn bool
	var appExecute, publicExecute, anonymousExecute, ownerCanCreate bool
	var tableSelect, tenantColumnSelect, emailColumnSelect bool
	if err := pool.QueryRow(ctx, `
SELECT owner.rolname,
       owner.rolcanlogin, owner.rolsuper, owner.rolcreatedb,
       owner.rolcreaterole, owner.rolinherit, owner.rolreplication,
       owner.rolbypassrls,
       procedure.prosecdef,
       procedure.provolatile = 's',
       procedure.prorettype = 'pg_catalog.bool'::regtype,
		COALESCE('search_path=pg_catalog, pg_temp' = ANY(procedure.proconfig), false),
		COALESCE('row_security=off' = ANY(procedure.proconfig), false),
       has_function_privilege(
           'postwave_app',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ),
       has_function_privilege(
           'public',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ),
       has_function_privilege(
           'postwave_public',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ),
       has_schema_privilege(owner.rolname, 'public', 'CREATE'),
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'SELECT'),
       has_column_privilege(
           owner.rolname, 'public.subscriber_emails', 'tenant_id', 'SELECT'
       ),
       has_column_privilege(
           owner.rolname, 'public.subscriber_emails', 'email', 'SELECT'
       )
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
 WHERE procedure.oid =
       'public.verification_subscriber_email_identity_exists(uuid,text)'::regprocedure`,
	).Scan(
		&owner,
		&canLogin, &superuser, &createDB, &createRole, &inherit, &replication, &bypassRLS,
		&securityDefiner, &stable, &returnsBool, &namesPgTemp, &rowSecurityOn,
		&appExecute, &publicExecute, &anonymousExecute, &ownerCanCreate,
		&tableSelect, &tenantColumnSelect, &emailColumnSelect,
	); err != nil {
		t.Fatalf("inspect verification identity predicate: %v", err)
	}
	if owner != "postwave_verification_identity_resolver" || canLogin || superuser ||
		createDB || createRole || inherit || replication || !bypassRLS ||
		!securityDefiner || !stable || !returnsBool || !namesPgTemp || !rowSecurityOn ||
		!appExecute || publicExecute || anonymousExecute || ownerCanCreate || tableSelect ||
		!tenantColumnSelect || !emailColumnSelect {
		t.Fatalf("unsafe verification identity predicate metadata: owner=%q login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypass=%v definer=%v stable=%v bool=%v pgtemp=%v row_security=%v app_exec=%v public_exec=%v anonymous_exec=%v owner_create=%v table_select=%v tenant_column=%v email_column=%v",
			owner, canLogin, superuser, createDB, createRole, inherit, replication,
			bypassRLS, securityDefiner, stable, returnsBool, namesPgTemp,
			rowSecurityOn, appExecute, publicExecute, anonymousExecute,
			ownerCanCreate, tableSelect, tenantColumnSelect, emailColumnSelect)
	}

	var memberships, unexpectedColumnPrivileges int
	var writePrivilege bool
	if err := pool.QueryRow(ctx, `
SELECT (
           SELECT count(*)
             FROM pg_catalog.pg_auth_members AS membership
            WHERE membership.member = owner.oid OR membership.roleid = owner.oid
       ),
       (
           SELECT count(*)
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = 'public.subscriber_emails'::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND (
                  (
                      attribute.attname NOT IN ('tenant_id', 'email') AND
                      has_column_privilege(
                          owner.rolname, 'public.subscriber_emails',
                          attribute.attname, 'SELECT'
                      )
                  ) OR
                  has_column_privilege(
                      owner.rolname, 'public.subscriber_emails',
                      attribute.attname, 'INSERT'
                  ) OR
                  has_column_privilege(
                      owner.rolname, 'public.subscriber_emails',
                      attribute.attname, 'UPDATE'
                  ) OR
                  has_column_privilege(
                      owner.rolname, 'public.subscriber_emails',
                      attribute.attname, 'REFERENCES'
                  )
              )
       ),
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'INSERT') OR
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'UPDATE') OR
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'DELETE') OR
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'TRUNCATE') OR
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'REFERENCES') OR
       has_table_privilege(owner.rolname, 'public.subscriber_emails', 'TRIGGER')
  FROM pg_catalog.pg_roles AS owner
 WHERE owner.rolname = 'postwave_verification_identity_resolver'`,
	).Scan(&memberships, &unexpectedColumnPrivileges, &writePrivilege); err != nil {
		t.Fatalf("inspect verification identity resolver grants: %v", err)
	}
	if memberships != 0 || unexpectedColumnPrivileges != 0 || writePrivilege {
		t.Fatalf("verification identity resolver memberships=%d unexpected_columns=%d write=%v",
			memberships, unexpectedColumnPrivileges, writePrivilege)
	}
}

func TestDBVerificationResultContractRejectsMalformedNewCacheAndJobWrites(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	ctx := context.Background()

	var installed int
	if err := pool.QueryRow(ctx, `
SELECT count(*)
  FROM pg_constraint
 WHERE conname IN (
     'verification_cache_email_contract_check',
     'verification_cache_semantics_contract_check',
     'verification_job_items_email_contract_check',
     'verification_job_items_projection_contract_check'
 )`).Scan(&installed); err != nil {
		t.Fatalf("inspect result constraints: %v", err)
	}
	if installed != 4 {
		t.Fatalf("installed verification result constraints=%d, want 4; apply migration 2001", installed)
	}

	assertRejected := func(name, statement string, args ...any) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			tx, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatalf("begin tenant transaction: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, statement, args...); err == nil {
				t.Fatal("malformed new write passed the database contract")
			}
		})
	}

	assertRejected("noncanonical cache identity", `
INSERT INTO verification_cache (tenant_id, email, status, provider, expires_at)
VALUES ($1::uuid, 'Person@Example.com', 'valid', 'zerobounce', now() + interval '1 day')`, tenantID)
	assertRejected("contradictory cache semantics", `
INSERT INTO verification_cache (
    tenant_id, email, status, sub_status, disposable, provider, expires_at
) VALUES (
    $1::uuid, 'person@example.com', 'valid', 'disposable', true,
    'zerobounce', now() + interval '1 day'
)`, tenantID)
	assertRejected("unsafe cache enrichment", `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, first_name, expires_at
) VALUES (
    $1::uuid, 'person@example.com', 'valid', 'zerobounce', E'safe\nforged',
    now() + interval '1 day'
)`, tenantID)
	assertRejected("bidi cache enrichment", `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, first_name, expires_at
) VALUES (
    $1::uuid, 'bidi@example.com', 'valid', 'zerobounce', U&'safe\202Eforged',
    now() + interval '1 day'
)`, tenantID)
	assertRejected("private-use cache enrichment", `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, first_name, expires_at
) VALUES (
    $1::uuid, 'private@example.com', 'valid', 'zerobounce', U&'safe\E000forged',
    now() + interval '1 day'
)`, tenantID)
	assertRejected("impossible local valid result", `
INSERT INTO verification_cache (tenant_id, email, status, provider, expires_at)
VALUES ($1::uuid, 'person@example.com', 'valid', 'local', now() + interval '1 day')`, tenantID)
	assertRejected("contradictory do-not-mail accept-all result", `
INSERT INTO verification_cache (
    tenant_id, email, status, sub_status, provider, expires_at
) VALUES (
    $1::uuid, 'accept-all@example.com', 'do_not_mail', 'accept_all',
    'zerobounce', now() + interval '1 day'
)`, tenantID)

	store := newStore(t, pool, nil)
	job, err := store.CreateJob(ctx, tenantID, JobSpec{
		Source: JobSourceInline, Emails: []string{"person@example.com"},
	})
	if err != nil {
		t.Fatalf("create canonical job: %v", err)
	}
	assertRejected("noncanonical durable item identity", `
UPDATE verification_job_items
   SET email = 'Person@Example.com'
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, tenantID, job.ID)
	assertRejected("foreign durable item provider", `
UPDATE verification_job_items
   SET provider = 'future_provider'
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, tenantID, job.ID)
	assertRejected("bidi durable job provenance", `
UPDATE verification_jobs
   SET source_ref = U&'safe\202Eforged'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, job.ID)
	assertRejected("private-use durable job error", `
UPDATE verification_jobs
   SET error = U&'safe\E000forged'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, job.ID)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin canonical vocabulary transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, row := range []struct {
		email, status, subStatus string
	}{
		{"alternate@example.com", string(StatusValid), string(SubStatusAlternate)},
		{"gold@example.com", string(StatusValid), string(SubStatusGold)},
		{"agent@example.com", string(StatusValid), string(SubStatusAIAgentMailbox)},
		{"role@example.com", string(StatusCatchAll), string(SubStatusRoleBasedAcceptAll)},
		{"forward@example.com", string(StatusDoNotMail), string(SubStatusMXForward)},
	} {
		if _, err := tx.Exec(ctx, `
INSERT INTO verification_cache (
    tenant_id, email, status, sub_status, provider, expires_at
) VALUES ($1::uuid, $2, $3, $4, 'zerobounce', now() + interval '1 day')`,
			tenantID, row.email, row.status, row.subStatus); err != nil {
			t.Fatalf("canonical provider vocabulary %s/%s rejected: %v", row.status, row.subStatus, err)
		}
	}
}

func TestDBVerificationPolicyContractRejectsValidEvidenceAsARejectionRule(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	ctx := context.Background()

	var installed bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'verification_policy_rejectable_statuses_contract_check'
)`).Scan(&installed); err != nil {
		t.Fatalf("inspect policy rejection constraint: %v", err)
	}
	if !installed {
		t.Fatal("verification policy rejection constraint is not installed; apply migration 2005")
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO verification_policy (tenant_id, forms_reject_statuses)
VALUES ($1::uuid, ARRAY['valid']::text[])`, tenantID); err == nil {
		t.Fatal("database accepted valid evidence as a signup rejection rule")
	}
}
