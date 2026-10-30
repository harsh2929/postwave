package views

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCampaignAssuranceOpsFunctionsExecuteAsRestrictedRole_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := readerDB(t) // every physical connection SET ROLEs to postwave_ops

	queries := []string{
		`SELECT * FROM ops_campaign_assurance_runs(NULL, NULL, NULL, NULL, 1)`,
		`SELECT * FROM ops_campaign_assurance_run_detail('71000000-0000-4000-8000-000000000001'::uuid)`,
		`SELECT * FROM ops_campaign_assurance_run_timeline('71000000-0000-4000-8000-000000000001'::uuid, 0, 1)`,
		`SELECT * FROM ops_campaign_assurance_slo_health()`,
	}
	for _, query := range queries {
		rows, err := pool.Query(ctx, query)
		if err != nil {
			t.Fatalf("postwave_ops must execute %q: %v", query, err)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("restricted execution %q: %v", query, err)
		}
	}

	// This catches an accidental SELECT runs.* or any other widening of a
	// function body: the definer owns no table-level SELECT and has only exact
	// column grants. postwave_ops itself must still be denied direct reads.
	if _, err := pool.Exec(ctx, `SELECT id FROM campaign_assurance_runs LIMIT 1`); err == nil ||
		!strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		t.Fatalf("postwave_ops direct assurance read must be permission denied, got %v", err)
	}

	for _, query := range []string{
		`SELECT * FROM ops_campaign_assurance_runs(NULL, NULL, NULL, NULL, 501)`,
		`SELECT * FROM ops_campaign_assurance_runs(NULL, NULL, now(), NULL, 1)`,
		`SELECT * FROM ops_campaign_assurance_run_timeline('71000000-0000-4000-8000-000000000001'::uuid, -1, 1)`,
	} {
		_, err := pool.Exec(ctx, query)
		if postgresCode(err) != "22023" {
			t.Errorf("unbounded/partial query %q error=%v code=%q, want 22023", query, err, postgresCode(err))
		}
	}
}

func TestCampaignAssuranceOpsDatabaseBoundaryAndOutputSchema_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin := adminDB(t)

	var functionCount int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  JOIN pg_roles AS owner ON owner.oid = proc.proowner
  JOIN pg_language AS language ON language.oid = proc.prolang
 WHERE namespace.nspname = 'public'
   AND proc.proname IN (
       'ops_campaign_assurance_runs',
       'ops_campaign_assurance_run_detail',
       'ops_campaign_assurance_run_timeline'
   )
   AND owner.rolname = 'postwave_campaign_assurance_ops_definer'
   AND NOT owner.rolcanlogin
   AND NOT owner.rolsuper
   AND NOT owner.rolbypassrls
   AND proc.prosecdef
   AND proc.provolatile = 's'
   AND proc.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
   AND language.lanname = 'plpgsql'`).Scan(&functionCount); err != nil {
		t.Fatalf("inspect Campaign Assurance ops owners: %v", err)
	}
	if functionCount != 3 {
		t.Fatalf("safe reviewed function count=%d, want 3", functionCount)
	}

	var policyCount int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_policy AS policy
  JOIN pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_roles AS policy_role ON policy_role.oid = policy.polroles[1]
 WHERE namespace.nspname = 'public'
   AND policy_role.rolname = 'postwave_campaign_assurance_ops_definer'
   AND cardinality(policy.polroles) = 1
   AND policy.polcmd = 'r'
   AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
   AND policy.polwithcheck IS NULL
   AND policy.polname IN (
       'campaign_assurance_runs_ops_support_select',
       'campaign_assurance_commands_ops_support_select',
       'campaign_assurance_run_targets_ops_support_select',
       'campaign_assurance_extractions_ops_support_select',
       'campaign_assurance_model_reservations_ops_support_select',
       'campaign_assurance_model_results_ops_support_select',
       'seed_message_observations_ops_support_select',
       'campaign_assurance_progress_events_ops_support_select'
   )`).Scan(&policyCount); err != nil {
		t.Fatalf("inspect Campaign Assurance ops RLS policies: %v", err)
	}
	if policyCount != 8 {
		t.Fatalf("reviewed SELECT-only RLS policy count=%d, want 8", policyCount)
	}

	var unsafeACLCount int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  CROSS JOIN LATERAL aclexplode(
      COALESCE(proc.proacl, acldefault('f', proc.proowner))
  ) AS acl
 WHERE namespace.nspname = 'public'
   AND proc.proname IN (
       'ops_campaign_assurance_runs',
       'ops_campaign_assurance_run_detail',
       'ops_campaign_assurance_run_timeline'
   )
   AND (
       acl.grantee = 0 OR
       acl.privilege_type <> 'EXECUTE' OR
       acl.grantee NOT IN (
           (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops'),
           (SELECT oid FROM pg_roles WHERE rolname = 'postwave_campaign_assurance_ops_definer')
       ) OR
       (acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops')
        AND acl.is_grantable)
   )`).Scan(&unsafeACLCount); err != nil {
		t.Fatalf("inspect Campaign Assurance ops ACL: %v", err)
	}
	if unsafeACLCount != 0 {
		t.Fatalf("Campaign Assurance ops functions have %d unsafe ACL entries", unsafeACLCount)
	}

	var definitions string
	if err := admin.QueryRow(ctx, `
SELECT string_agg(pg_get_functiondef(proc.oid), E'\n')
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
 WHERE namespace.nspname = 'public'
   AND proc.proname IN (
       'ops_campaign_assurance_runs',
       'ops_campaign_assurance_run_detail',
       'ops_campaign_assurance_run_timeline'
   )`).Scan(&definitions); err != nil {
		t.Fatalf("read Campaign Assurance ops definitions: %v", err)
	}
	lowerDefinitions := strings.ToLower(definitions)
	for _, forbidden := range []string{
		"runs.*", ".subject", ".body_html", ".body_text",
		".normalized_extraction", ".raw_output_object_ref",
		".observed_summary_object_ref", ".observed_environment",
		".capability_snapshot", ".metadata", ".mailbox_id",
		".error_message", ".claim_token", ".lease_owner", ".created_by",
	} {
		if strings.Contains(lowerDefinitions, forbidden) {
			t.Errorf("installed function definition references forbidden identifier %q", forbidden)
		}
	}

	restricted := readerDB(t)
	queries := []string{
		`SELECT * FROM ops_campaign_assurance_runs(NULL, NULL, NULL, NULL, 1)`,
		`SELECT * FROM ops_campaign_assurance_run_detail('71000000-0000-4000-8000-000000000001'::uuid)`,
		`SELECT * FROM ops_campaign_assurance_run_timeline('71000000-0000-4000-8000-000000000001'::uuid, 0, 1)`,
	}
	for _, query := range queries {
		rows, err := restricted.Query(ctx, query)
		if err != nil {
			t.Fatalf("inspect output boundary for %q: %v", query, err)
		}
		fields := rows.FieldDescriptions()
		rows.Close()
		if len(fields) == 0 || string(fields[0].Name) != "tenant_id" {
			t.Fatalf("function %q does not lead with tenant_id: %+v", query, fields)
		}
		for _, field := range fields {
			name := strings.ToLower(string(field.Name))
			for _, forbidden := range []string{
				"subject", "body", "normalized_extraction", "raw_output",
				"object_ref", "prompt_text", "provider_payload", "recipient",
				"mailbox", "secret", "error_message", "metadata",
			} {
				if strings.Contains(name, forbidden) {
					t.Errorf("function %q exposes forbidden output column %q", query, name)
				}
			}
		}
	}
}

func postgresCode(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}
