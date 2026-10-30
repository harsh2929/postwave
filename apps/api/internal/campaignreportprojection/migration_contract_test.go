// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectionMigrationContainsDurableBoundaries(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(filepath.Join("..", "..", "..", "..",
		"infra", "migrations", "1959_campaign_report_canonical_projection.sql")))
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	for _, required := range []string{
		"campaign_report_event_projection_identities",
		"campaign_report_projection_runs",
		"campaign_report_event_projections",
		"FOREIGN KEY (tenant_id, subscriber_event_id, subscriber_event_at)",
		"FOREIGN KEY (tenant_id, reconciliation_run_id)",
		"fence_event_id",
		"append_campaign_report_event_projection",
		"SECURITY DEFINER",
		"pg_advisory_xact_lock",
		"adopted_legacy",
		"inserted_projection",
		"projection replay conflicts with immutable evidence",
		"projection event is outside the active run lease/fence",
		"multiple exact legacy campaign report rows",
		"campaign_report_projection_append_only_guard",
		"campaign_report_projected_row_immutable_guard",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"app.outbox_worker",
		"app.campaign_report_projection_worker",
		"REVOKE ALL ON campaign_report_event_projection_identities",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing %q", required)
		}
	}
	if strings.Contains(sql, "ALTER TABLE campaign_report_events ADD COLUMN") {
		t.Fatal("projection migration must not force a partitioned-table rewrite")
	}
	repositoryRaw, err := os.ReadFile("repository.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"id <= $2", "ProcessBatch", "maxBatchSize"} {
		if !strings.Contains(string(repositoryRaw), required) {
			t.Errorf("bounded repository is missing %q", required)
		}
	}
}

func TestProjectionMutationMigrationContainsGovernedBoundaries(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(filepath.Join("..", "..", "..", "..",
		"infra", "migrations", "1964_campaign_report_projection_mutations.sql")))
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	for _, required := range []string{
		"campaign_report_projection_mutation_requests",
		"campaign_report_projection_mutation_receipts",
		"campaign_report_event_projection_heads",
		"campaign_report_projection_mutation_authorizations",
		"campaign_report_projection_repoint_subscriber_events",
		"campaign_report_projection_privacy_erase_subscriber_events",
		"campaign_report_projection_rollback_delete",
		"append_campaign_report_event_projection_immutable_v1",
		"existing campaign report projection diverged before mutation-head adoption",
		"campaign report projection mutation request replay conflicts",
		"campaign report projection mutation receipt chain is incomplete",
		"privacy projection mutation requires a non-routable erased.invalid target",
		"linked rollback canonical event lacks exact migration ownership",
		"REVOKE UPDATE (subscriber_email, user_agent, ip)",
		"REVOKE ALL ON FUNCTION campaign_report_projection_mutation_evidence_guard()",
		"REVOKE ALL ON FUNCTION campaign_report_projection_append_only_guard()",
		"REVOKE ALL ON FUNCTION campaign_report_projection_run_guard()",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"app.campaign_report_projection_mutation_reader",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("projection mutation migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT UPDATE (subscriber_email, user_agent, ip)",
		"GRANT INSERT ON campaign_report_projection_mutation_receipts",
		"GRANT UPDATE ON campaign_report_event_projection_heads",
		"GRANT EXECUTE ON FUNCTION append_campaign_report_event_projection_immutable_v1",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("projection mutation migration contains unsafe authority %q", forbidden)
		}
	}
}

func TestProjectionMutationCallersUseTheGovernedAuthority(t *testing.T) {
	repositoryRoot := filepath.Clean(filepath.Join("..", "..", "..", ".."))
	for _, caller := range []struct {
		path      string
		required  []string
		forbidden []string
	}{
		{
			path: "apps/api/internal/privacy/erasure.go",
			required: []string{
				"campaign_report_projection_privacy_erase_subscriber_events",
			},
			forbidden: []string{"UPDATE subscriber_events"},
		},
		{
			path: "apps/api/internal/merge/apply.go",
			required: []string{
				"campaign_report_projection_repoint_subscriber_events",
				"'subscriber_merge'",
			},
			forbidden: []string{"UPDATE subscriber_events"},
		},
		{
			path: "apps/api/internal/subscribers/merge.go",
			required: []string{
				"campaign_report_projection_repoint_subscriber_events",
				"projectionMutationEmailRotation",
				"projectionMutationSubscriberMerge",
				"projectionMutationAnonymousStitch",
			},
			forbidden: []string{"UPDATE subscriber_events"},
		},
		{
			path: "apps/api/internal/subscribers/merge_canonical.go",
			required: []string{
				"repointSubscriberEmailForPurpose",
				"projectionMutationSubscriberMerge",
			},
		},
		{
			path: "apps/api/internal/subscribers/anonymous_stitch.go",
			required: []string{
				"repointProjectedSubscriberEvents",
				"projectionMutationAnonymousStitch",
				"campaign_report_projection_repoint_subscriber_events",
			},
			forbidden: []string{"UPDATE subscriber_events"},
		},
		{
			path: "services/migration/internal/translator/listmonk/import_state.go",
			required: []string{
				"campaign_report_projection_rollback_delete",
			},
			forbidden: []string{"DELETE FROM campaign_report_events"},
		},
	} {
		raw, err := os.ReadFile(filepath.Join(repositoryRoot, caller.path))
		if err != nil {
			t.Fatalf("read %s: %v", caller.path, err)
		}
		content := string(raw)
		for _, marker := range caller.required {
			if !strings.Contains(content, marker) {
				t.Errorf("%s is missing governed mutation marker %q", caller.path, marker)
			}
		}
		for _, marker := range caller.forbidden {
			if strings.Contains(content, marker) {
				t.Errorf("%s retains direct projection mutation %q", caller.path, marker)
			}
		}
	}
}
