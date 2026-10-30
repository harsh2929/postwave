// SPDX-License-Identifier: AGPL-3.0-only

package db_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Every capability the code presents must be one the schema grants.
//
// Six of this session's bugs were one shape: Go opens a transaction, sets an
// `app.*` GUC to name a capability, and runs a query — and NO policy or
// function reads that GUC. The query then falls back to the tenant predicate
// with no tenant set, matches `tenant_id = NULL`, and returns nothing.
//
// Nothing errors. A sweep that returns zero rows is what an idle worker looks
// like; a lookup that returns zero rows is what "not found" looks like. The
// broken state and the healthy state are identical from outside, which is why
// each of these survived until somebody compared the two lists:
//
//	1900  pii_scan_runtime_contract  — FOR SHARE not lockable under tenant RLS
//	1902  audit_log                  — app.audit_trim_worker read by nothing
//	1905  gift_subscriptions         — app.public_gift_token read by nothing
//	1906  analytics_integrations     — app.analytics_worker read by nothing
//	1907  lead_integrations          — app.lead_account_id/campaign_id, 11 providers
//
// So the comparison is now a test. A new capability GUC that nothing reads
// fails here rather than shipping as a silently inert feature.
//
// DELIBERATELY DB-BACKED. The question is not "does the string appear
// somewhere" but "does this database grant it", and only the database can
// answer that.
var gucSetPattern = regexp.MustCompile(`set_config\(\s*'(app\.[a-z_]+)'`)

// Capability GUCs that are genuinely decorative: set for symmetry with their
// siblings, with the policy admitting on a broader key and the Go query
// narrowing further. RLS being wider than the query is sound — RLS is the outer
// bound — so these are not inert paths.
//
// ENUMERATED, and the list may only SHRINK. Every entry is a claim that nothing
// needs to read this; a new one is a claim somebody has to make deliberately.
var decorativeGUCs = map[string]string{
	"app.crm_webhook_app_id": "the HubSpot webhook policy admits on portal_id; " +
		"the Go query narrows by hubspot_app_id, so RLS is the outer bound and " +
		"this value is set for symmetry with app.crm_webhook_portal_id",
}

// releaseHeldGUCs are exact capabilities retained solely by archived adapters.
// Migration 1993 deliberately removed every support-provider lookup policy:
// the shared application role can set app.* itself, so those policies were not
// an authorization boundary. Production mounts the entire provider family as
// a zero-read, zero-side-effect 503 hold before any adapter can run. Keep the
// exact list closed so a new inert capability still fails this test, and fail
// below if a held capability silently becomes schema-readable again.
const supportRoute41HoldReason = "Route41 archived support-provider adapter; production is held before lookup and migration 1993 removed its caller-settable-GUC policy"

var releaseHeldGUCs = map[string]string{
	"app.support_ada_ai_agent_domain":                   supportRoute41HoldReason,
	"app.support_ada_webhook_id":                        supportRoute41HoldReason,
	"app.support_asana_webhook_id":                      supportRoute41HoldReason,
	"app.support_asana_workspace_id":                    supportRoute41HoldReason,
	"app.support_clickup_webhook_id":                    supportRoute41HoldReason,
	"app.support_clickup_workspace_id":                  supportRoute41HoldReason,
	"app.support_crisp_webhook_id":                      supportRoute41HoldReason,
	"app.support_crisp_website_id":                      supportRoute41HoldReason,
	"app.support_drift_webhook_id":                      supportRoute41HoldReason,
	"app.support_drift_workspace_id":                    supportRoute41HoldReason,
	"app.support_freshchat_domain":                      supportRoute41HoldReason,
	"app.support_freshchat_freshworks_domain":           supportRoute41HoldReason,
	"app.support_freshchat_full_domain":                 supportRoute41HoldReason,
	"app.support_freshchat_webhook_id":                  supportRoute41HoldReason,
	"app.support_freshdesk_domain":                      supportRoute41HoldReason,
	"app.support_freshdesk_full_domain":                 supportRoute41HoldReason,
	"app.support_freshdesk_webhook_id":                  supportRoute41HoldReason,
	"app.support_front_inbox_id":                        supportRoute41HoldReason,
	"app.support_front_webhook_id":                      supportRoute41HoldReason,
	"app.support_gladly_bare_domain":                    supportRoute41HoldReason,
	"app.support_gladly_organization_domain":            supportRoute41HoldReason,
	"app.support_gladly_webhook_id":                     supportRoute41HoldReason,
	"app.support_gorgias_bare_domain":                   supportRoute41HoldReason,
	"app.support_gorgias_domain":                        supportRoute41HoldReason,
	"app.support_gorgias_integration_id":                supportRoute41HoldReason,
	"app.support_groove_mailbox_id":                     supportRoute41HoldReason,
	"app.support_groove_webhook_id":                     supportRoute41HoldReason,
	"app.support_helpcrunch_organization_id":            supportRoute41HoldReason,
	"app.support_helpcrunch_webhook_id":                 supportRoute41HoldReason,
	"app.support_helpscout_mailbox_id":                  supportRoute41HoldReason,
	"app.support_helpscout_webhook_id":                  supportRoute41HoldReason,
	"app.support_hubspot_portal_id":                     supportRoute41HoldReason,
	"app.support_hubspot_webhook_id":                    supportRoute41HoldReason,
	"app.support_ingest_token":                          supportRoute41HoldReason,
	"app.support_intercom_workspace_id":                 supportRoute41HoldReason,
	"app.support_jira_service_site_id":                  supportRoute41HoldReason,
	"app.support_jira_service_webhook_id":               supportRoute41HoldReason,
	"app.support_kayako_domain":                         supportRoute41HoldReason,
	"app.support_kayako_full_domain":                    supportRoute41HoldReason,
	"app.support_kayako_webhook_id":                     supportRoute41HoldReason,
	"app.support_kustomer_organization_id":              supportRoute41HoldReason,
	"app.support_kustomer_webhook_id":                   supportRoute41HoldReason,
	"app.support_linear_webhook_id":                     supportRoute41HoldReason,
	"app.support_linear_workspace_id":                   supportRoute41HoldReason,
	"app.support_livechat_account_id":                   supportRoute41HoldReason,
	"app.support_livechat_webhook_id":                   supportRoute41HoldReason,
	"app.support_olark_site_id":                         supportRoute41HoldReason,
	"app.support_olark_webhook_id":                      supportRoute41HoldReason,
	"app.support_provider":                              supportRoute41HoldReason,
	"app.support_reamaze_account_domain":                supportRoute41HoldReason,
	"app.support_reamaze_webhook_id":                    supportRoute41HoldReason,
	"app.support_salesforce_service_cloud_instance_url": supportRoute41HoldReason,
	"app.support_salesforce_service_cloud_webhook_id":   supportRoute41HoldReason,
	"app.support_tidio_project_public_key":              supportRoute41HoldReason,
	"app.support_tidio_webhook_id":                      supportRoute41HoldReason,
	"app.support_worker":                                supportRoute41HoldReason,
	"app.support_zendesk_subdomain":                     supportRoute41HoldReason,
	"app.support_zendesk_webhook_id":                    supportRoute41HoldReason,
	"app.support_zoho_desk_organization_id":             supportRoute41HoldReason,
	"app.support_zoho_desk_webhook_id":                  supportRoute41HoldReason,
}

func TestEveryCapabilityGUCIsReadBySomething(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping capability GUC contract test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	// What the Go tree SETS.
	// THE WHOLE REPOSITORY, not just apps/api.
	//
	// A first version scanned only this module and would have missed every
	// capability presented from elsewhere — `app.platform_admin` is set by
	// services/migration, and scanning apps/api alone reported it as a
	// capability nobody presents. A guard against inert capabilities that
	// cannot see half the callers is itself the thing it exists to catch.
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	roots := []string{}
	for _, dir := range []string{"apps", "services", "packages"} {
		full := filepath.Join(repoRoot, dir)
		if _, statErr := os.Stat(full); statErr == nil {
			roots = append(roots, full)
		}
	}
	if len(roots) < 3 {
		t.Fatalf("only found %d of the three source roots under %s; the scan is "+
			"not reaching the tree", len(roots), repoRoot)
	}
	args := append([]string{"-rhoE", `set_config\(\s*'app\.[a-z_]+'`}, roots...)
	args = append(args, "--include=*.go", "--exclude=*_test.go")
	out, err := exec.Command("grep", args...).Output()
	if err != nil {
		t.Fatalf("scan for set_config: %v", err)
	}
	set := map[string]bool{}
	for _, m := range gucSetPattern.FindAllStringSubmatch(string(out), -1) {
		set[m[1]] = true
	}
	if len(set) < 50 {
		// A floor. If the scan stops matching, "every GUC is read" would be
		// vacuously true — the exact failure this test exists to catch.
		t.Fatalf("found only %d app.* GUCs set in the Go tree; the scan is not "+
			"reaching the source and this check is measuring nothing", len(set))
	}

	// What the DATABASE reads — policies and function bodies alike, and
	// whitespace-tolerant, because `current_setting(` and the quoted name are
	// not always on the same line (the tag-membership trigger is not, and an
	// adjacent-only pattern reported app.actor_id as unread).
	rows, err := pool.Query(ctx, `
SELECT DISTINCT m[1] FROM pg_proc p,
LATERAL regexp_matches(p.prosrc, 'current_setting\s*\(\s*''(app\.[a-z_]+)''', 'g') m
WHERE p.prosrc IS NOT NULL
UNION
SELECT DISTINCT m[1] FROM pg_policy pol,
LATERAL regexp_matches(
    COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
    COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
    'current_setting\s*\(\s*''(app\.[a-z_]+)''', 'g') m`)
	if err != nil {
		t.Fatalf("read GUCs referenced by the schema: %v", err)
	}
	defer rows.Close()
	read := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		read[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(read) < 50 {
		t.Fatalf("the schema references only %d app.* GUCs; the catalog query is "+
			"not finding them and this check is measuring nothing", len(read))
	}

	var unread []string
	for guc := range set {
		if read[guc] || decorativeGUCs[guc] != "" || releaseHeldGUCs[guc] != "" {
			continue
		}
		unread = append(unread, guc)
	}
	sort.Strings(unread)
	for _, guc := range unread {
		t.Errorf("%s is set by the application and read by NO policy and NO "+
			"function. The transaction that sets it presents a capability the "+
			"schema does not grant, so its query falls through to the tenant "+
			"predicate with no tenant and matches nothing — silently, because an "+
			"empty result is indistinguishable from having no work to do. Either "+
			"add the policy that reads it, or record it in decorativeGUCs with "+
			"the reason nothing needs to.", guc)
	}

	// And the decorative list may only shrink.
	for guc := range decorativeGUCs {
		if read[guc] {
			t.Errorf("%s is now read by the schema and must be removed from "+
				"decorativeGUCs, so that list keeps meaning what it says", guc)
		}
		if !set[guc] {
			t.Errorf("%s is in decorativeGUCs but nothing sets it any more; drop "+
				"the entry rather than leaving a claim about code that is gone", guc)
		}
	}
	for guc := range releaseHeldGUCs {
		if read[guc] {
			t.Errorf("%s is now read by the schema and must be removed from "+
				"releaseHeldGUCs; restoring a capability requires a fresh security review "+
				"and removal of the Route41 production hold", guc)
		}
		if !set[guc] {
			t.Errorf("%s is in releaseHeldGUCs but archived production code no longer "+
				"sets it; remove the stale exemption", guc)
		}
	}
	if !strings.HasPrefix(strings.Join(unread, ""), "app.") && len(unread) == 0 {
		t.Logf("capability GUC contract: %d set, %d referenced by the schema", len(set), len(read))
	}
}
