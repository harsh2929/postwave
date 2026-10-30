package migrationrunner

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAssessSafetyBlocksDestructiveOperations(t *testing.T) {
	files := []MigrationFile{
		{
			Version: "0099_bad",
			SQL: strings.Join([]string{
				"BEGIN;",
				"ALTER TABLE subscribers",
				"  DROP COLUMN email;",
				"DELETE FROM audit_log;",
				"TRUNCATE TABLE campaigns;",
				"DROP TABLE tenants;",
				"COMMIT;",
			}, "\n"),
		},
	}
	findings := AssessSafety(files)
	if len(findings) != 4 {
		t.Fatalf("findings = %d, want 4: %+v", len(findings), findings)
	}
	for _, f := range findings {
		if f.Severity != SafetyBlocker {
			t.Fatalf("finding %s severity = %s, want blocker", f.Rule, f.Severity)
		}
	}
	if findings[0].Line != 2 {
		t.Fatalf("first finding line = %d, want start line 2", findings[0].Line)
	}
}

func TestAssessSafetyWarnsForRollbackRisk(t *testing.T) {
	files := []MigrationFile{
		{
			Version: "0099_risky",
			SQL: strings.Join([]string{
				"BEGIN;",
				"ALTER TABLE campaigns RENAME COLUMN subject TO title;",
				"ALTER TABLE subscribers",
				"  ALTER COLUMN created_at",
				"  TYPE timestamptz;",
				"ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
				"CREATE UNIQUE INDEX users_email_key ON users (email);",
				"COMMIT;",
			}, "\n"),
		},
	}
	findings := AssessSafety(files)
	if len(findings) != 4 {
		t.Fatalf("findings = %d, want 4: %+v", len(findings), findings)
	}
	for _, f := range findings {
		if f.Severity != SafetyWarning {
			t.Fatalf("finding %s severity = %s, want warning", f.Rule, f.Severity)
		}
	}
}

func TestAssessSafetyWarnsForDirectUniqueConstraintBuilds(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		sql      string
		wantRule bool
	}{
		{
			name: "named table constraint",
			sql: `ALTER TABLE outbound_webhooks
			      ADD CONSTRAINT outbound_webhooks_tenant_id_id_key
			      UNIQUE (tenant_id,id);`,
			wantRule: true,
		},
		{
			name:     "anonymous table constraint",
			sql:      `ALTER TABLE outbound_webhooks ADD UNIQUE (tenant_id,id);`,
			wantRule: true,
		},
		{
			name: "nulls not distinct table constraint",
			sql: `ALTER TABLE outbound_webhooks
			      ADD CONSTRAINT outbound_webhooks_url_key
			      UNIQUE NULLS NOT DISTINCT (tenant_id,url);`,
			wantRule: true,
		},
		{
			name: "concurrent index adoption",
			sql: `ALTER TABLE outbound_webhooks
			      ADD CONSTRAINT outbound_webhooks_tenant_id_id_key
			      UNIQUE USING INDEX outbound_webhooks_tenant_id_id_key;`,
		},
		{
			name: "new table inline constraint",
			sql: `CREATE TABLE outbound_webhook_playground_fires (
			        tenant_id uuid NOT NULL,
			        fire_id uuid NOT NULL,
			        UNIQUE (tenant_id,fire_id)
			      );`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			findings := AssessSafety([]MigrationFile{{
				Version: "2007_unique_constraint_probe",
				SQL:     test.sql,
			}})
			var found bool
			for _, finding := range findings {
				if finding.Rule == "add-nonconcurrent-unique-constraint" {
					found = true
					if finding.Severity != SafetyWarning {
						t.Fatalf("finding severity = %s, want warning", finding.Severity)
					}
				}
			}
			if found != test.wantRule {
				t.Fatalf("direct UNIQUE finding=%v, want %v: %+v", found, test.wantRule, findings)
			}
		})
	}
}

func TestAssessSafetyMatchesMultilineAlterClauses(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		sql      string
		wantRule string
	}{
		{
			name:     "drop column",
			sql:      "ALTER\nTABLE subscribers\nDROP\nCOLUMN email;",
			wantRule: "drop-column",
		},
		{
			name:     "rename column",
			sql:      "ALTER TABLE subscribers\nRENAME\nCOLUMN email TO address;",
			wantRule: "rename-table-or-column",
		},
		{
			name:     "alter column type",
			sql:      "ALTER TABLE subscribers\nALTER COLUMN created_at\nTYPE timestamptz;",
			wantRule: "alter-column-type",
		},
		{
			name:     "set not null",
			sql:      "ALTER TABLE subscribers\nALTER COLUMN email\nSET NOT NULL;",
			wantRule: "set-not-null",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			findings := AssessSafety([]MigrationFile{{
				Version: "0104_multiline_alter",
				SQL:     test.sql,
			}})
			if len(findings) != 1 || findings[0].Rule != test.wantRule {
				t.Fatalf("findings = %+v, want one %s finding", findings, test.wantRule)
			}
		})
	}
}

func TestAssessSafetyIgnoresCommentsAndAllowedDrops(t *testing.T) {
	files := []MigrationFile{
		{
			Version: "0099_safe",
			SQL: strings.Join([]string{
				"BEGIN;",
				"-- DROP TABLE subscribers;",
				"/* DELETE FROM tenants; */",
				"DROP POLICY IF EXISTS tenant_isolation ON subscribers;",
				"DROP TRIGGER IF EXISTS set_updated_at ON campaigns;",
				"ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS preview_text text;",
				"COMMIT;",
			}, "\n"),
		},
	}
	if findings := AssessSafety(files); len(findings) != 0 {
		t.Fatalf("findings = %+v, want none", findings)
	}
}

func TestAssessSafetyDoesNotTreatRevokedTruncatePrivilegeAsDataLoss(t *testing.T) {
	files := []MigrationFile{{
		Version: "0100_revoke_privileges",
		SQL:     "REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES ON events FROM postwave_app;",
	}}
	if findings := AssessSafety(files); len(findings) != 0 {
		t.Fatalf("findings = %+v, want none", findings)
	}
}

func TestAssessSafetyDoesNotTreatRoutineBodyAsApplyTimeDeletion(t *testing.T) {
	files := []MigrationFile{{
		Version: "0101_runtime_trigger",
		SQL: strings.Join([]string{
			"BEGIN;",
			"CREATE OR REPLACE FUNCTION clear_runtime_value()",
			"RETURNS trigger LANGUAGE plpgsql AS $$",
			"BEGIN",
			"  DELETE FROM runtime_values WHERE id = OLD.id;",
			"  RETURN OLD;",
			"END;",
			"$$;",
			"CREATE TRIGGER runtime_cleanup AFTER DELETE ON parents",
			"FOR EACH ROW EXECUTE FUNCTION clear_runtime_value();",
			"COMMIT;",
		}, "\n"),
	}}
	if findings := AssessSafety(files); len(findings) != 0 {
		t.Fatalf("findings = %+v, want no apply-time destructive finding", findings)
	}
}

func TestAssessSafetyScansDestructiveSQLAfterRoutineDefinition(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		sql  string
	}{
		{
			name: "closing delimiter shares line",
			sql: strings.Join([]string{
				"CREATE FUNCTION runtime_cleanup() RETURNS void LANGUAGE plpgsql AS $$",
				"BEGIN DELETE FROM runtime_values; END;",
				"$$; DELETE FROM subscribers;",
			}, "\n"),
		},
		{
			name: "one line dollar body",
			sql:  "CREATE FUNCTION runtime_cleanup() RETURNS void LANGUAGE sql AS $$ DELETE FROM runtime_values $$; DELETE FROM subscribers;",
		},
		{
			name: "single quoted body",
			sql:  "CREATE FUNCTION runtime_cleanup() RETURNS void LANGUAGE sql AS 'DELETE FROM runtime_values'; DELETE FROM subscribers;",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			findings := AssessSafety([]MigrationFile{{
				Version: "0103_trailing_delete",
				SQL:     test.sql,
			}})
			if len(findings) != 1 || findings[0].Rule != "delete-from" {
				t.Fatalf("findings = %+v, want trailing delete-from blocker", findings)
			}
			if !strings.Contains(findings[0].Snippet, "DELETE FROM subscribers") {
				t.Fatalf("finding scanned wrong statement: %+v", findings[0])
			}
		})
	}
}

func TestAssessSafetyStillBlocksDeleteInsideDoBlock(t *testing.T) {
	files := []MigrationFile{{
		Version: "0102_apply_time_delete",
		SQL: strings.Join([]string{
			"DO $$",
			"BEGIN",
			"  DELETE FROM runtime_values;",
			"END;",
			"$$;",
		}, "\n"),
	}}
	findings := AssessSafety(files)
	if len(findings) != 1 || findings[0].Rule != "delete-from" {
		t.Fatalf("findings = %+v, want delete-from blocker", findings)
	}
}

func TestAssessSafetyDowngradesExactReviewedGeneratedColumnRebuild(t *testing.T) {
	file := MigrationFile{
		Version:  reviewedPartitionRebuildVersion,
		Checksum: reviewedPartitionRebuildChecksum,
	}
	findings := assessStatement(file, 582, reviewedPartitionRebuildSQL)
	if len(findings) != 1 {
		t.Fatalf("findings = %+v, want one", findings)
	}
	if findings[0].Severity != SafetyWarning || findings[0].Rule != "drop-generated-column-rebuild" {
		t.Fatalf("finding = %+v, want reviewed warning", findings[0])
	}
}

func TestAssessSafetyDowngradesReviewedGeneratedColumnRebuildInsidePinnedDOBlock(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Version != reviewedPartitionRebuildVersion {
			continue
		}
		findings := AssessSafety([]MigrationFile{file})
		var reviewed int
		for _, finding := range findings {
			if finding.Severity == SafetyBlocker {
				t.Fatalf("pinned migration retained blocker: %+v", finding)
			}
			if finding.Rule == "drop-generated-column-rebuild" {
				reviewed++
			}
		}
		if reviewed != 1 {
			t.Fatalf("reviewed findings = %d, want 1: %+v", reviewed, findings)
		}
		return
	}
	t.Fatalf("migration %s not found", reviewedPartitionRebuildVersion)
}

func TestAssessSafetyRejectsChangedGeneratedColumnRebuild(t *testing.T) {
	file := MigrationFile{
		Version:  reviewedPartitionRebuildVersion,
		Checksum: "changed",
	}
	findings := assessStatement(file, 582, reviewedPartitionRebuildSQL)
	if len(findings) != 1 {
		t.Fatalf("findings = %+v, want one", findings)
	}
	if findings[0].Severity != SafetyBlocker || findings[0].Rule != "drop-column" {
		t.Fatalf("finding = %+v, want destructive blocker", findings[0])
	}
}

func TestAssessSafetyAllowsOnlyChecksumPinnedRevealOnceReplayPurge(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Version != reviewedRevealOnceReplayPurgeVersion {
			continue
		}
		findings := AssessSafety([]MigrationFile{file})
		var reviewed int
		for _, finding := range findings {
			if finding.Severity == SafetyBlocker {
				t.Fatalf("pinned reveal-once replay purge retained blocker: %+v", finding)
			}
			if finding.Rule == "delete-reveal-once-replay-incident-data" {
				reviewed++
			}
		}
		if reviewed != 1 {
			t.Fatalf("reviewed purge findings=%d, want 1: %+v", reviewed, findings)
		}

		changedChecksum := file
		changedChecksum.Checksum = "changed"
		changedFindings := AssessSafety([]MigrationFile{changedChecksum})
		if len(changedFindings) != 1 ||
			changedFindings[0].Severity != SafetyBlocker ||
			changedFindings[0].Rule != "delete-from" {
			t.Fatalf("checksum drift findings=%+v, want delete blocker", changedFindings)
		}
		return
	}
	t.Fatalf("migration %s not found", reviewedRevealOnceReplayPurgeVersion)
}

func TestAssessSafetyRejectsReviewedGeneratedColumnRebuildVersionDrift(t *testing.T) {
	file := MigrationFile{
		Version:  "0340_unreviewed_partition_rebuild",
		Checksum: reviewedPartitionRebuildChecksum,
	}
	findings := assessStatement(file, 1, reviewedPartitionRebuildSQL)
	if len(findings) != 1 || findings[0].Severity != SafetyBlocker || findings[0].Rule != "drop-column" {
		t.Fatalf("findings = %+v, want destructive blocker", findings)
	}
}

func TestAssessSafetyRejectsReviewedGeneratedColumnRebuildStatementDrift(t *testing.T) {
	file := MigrationFile{
		Version:  reviewedPartitionRebuildVersion,
		Checksum: reviewedPartitionRebuildChecksum,
	}
	changed := "EXECUTE 'ALTER TABLE audit_log_legacy DROP COLUMN IF EXISTS payload';"
	findings := assessStatement(file, 1, changed)
	if len(findings) != 1 || findings[0].Severity != SafetyBlocker || findings[0].Rule != "drop-column" {
		t.Fatalf("findings = %+v, want destructive blocker", findings)
	}
}

func TestAssessSafetyRejectsAdditionalDropInsideReviewedDOBlock(t *testing.T) {
	file := MigrationFile{
		Version:  reviewedPartitionRebuildVersion,
		Checksum: reviewedPartitionRebuildChecksum,
	}
	sql := strings.Join([]string{
		"DO $$ BEGIN",
		reviewedPartitionRebuildSQL,
		"EXECUTE 'ALTER TABLE audit_log_legacy DROP COLUMN IF EXISTS payload';",
		"END $$;",
	}, " ")
	findings := assessStatement(file, 1, sql)
	if len(findings) != 1 || findings[0].Severity != SafetyBlocker || findings[0].Rule != "drop-column" {
		t.Fatalf("findings = %+v, want destructive blocker", findings)
	}
}

func TestRepositoryMigrationsContainNoUnreviewedSafetyBlocker(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, finding := range AssessSafety(files) {
		if finding.Severity == SafetyBlocker {
			t.Errorf("unreviewed migration blocker: %+v", finding)
		}
	}
}

func TestUnsafeMigrationErrorSummarizesFirstFinding(t *testing.T) {
	err := (&ErrUnsafeMigration{Findings: []SafetyFinding{{
		Version: "0099_bad",
		Line:    2,
		Rule:    "drop-table",
	}}}).Error()
	if !strings.Contains(err, "0099_bad line 2 drop-table") {
		t.Fatalf("unexpected error: %s", err)
	}
}

func TestUnsafeMigrationErrorSummarizesFirstActualBlocker(t *testing.T) {
	err := (&ErrUnsafeMigration{Findings: []SafetyFinding{
		{
			Version:  "0007_warning",
			Line:     86,
			Severity: SafetyWarning,
			Rule:     "create-unique-index",
		},
		{
			Version:  "0339_blocker",
			Line:     144,
			Severity: SafetyBlocker,
			Rule:     "drop-column",
		},
	}}).Error()
	if !strings.Contains(err, "0339_blocker line 144 drop-column") {
		t.Fatalf("unexpected error: %s", err)
	}
}

func TestAssessRollbackPlansParsesExplicitStrategy(t *testing.T) {
	files := []MigrationFile{{
		Version: "0100_additive",
		SQL: strings.Join([]string{
			"-- rollback-strategy: expand-contract - previous release keeps reading old column",
			"BEGIN;",
			"ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS nickname text;",
			"COMMIT;",
		}, "\n"),
	}}
	plans := AssessRollbackPlans(files, nil)
	if len(plans) != 1 {
		t.Fatalf("plans = %d, want 1", len(plans))
	}
	if !plans[0].Explicit || plans[0].Strategy != RollbackStrategyExpandContract {
		t.Fatalf("plan = %+v, want explicit expand-contract", plans[0])
	}
	if !strings.Contains(plans[0].Details, "previous release") {
		t.Fatalf("details not parsed: %+v", plans[0])
	}
}

func TestAssessRollbackPlansKeepsHyphenatedStrategiesIntact(t *testing.T) {
	tests := []struct {
		name     string
		comment  string
		strategy string
		detail   string
	}{
		{
			name:     "no-op with parenthetical detail",
			comment:  "-- rollback-strategy: no-op (additive index; safe to leave in place)",
			strategy: RollbackStrategyNoOp,
			detail:   "additive index",
		},
		{
			name:     "no-op with em dash",
			comment:  "-- rollback-strategy: no-op — additive table; prior releases ignore it",
			strategy: RollbackStrategyNoOp,
			detail:   "additive table",
		},
		{
			name:     "expand-contract with comma",
			comment:  "-- rollback-strategy: expand-contract, read-side only",
			strategy: RollbackStrategyExpandContract,
			detail:   "read-side only",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plans := AssessRollbackPlans([]MigrationFile{{Version: "0100_contract", SQL: tt.comment}}, nil)
			if len(plans) != 1 {
				t.Fatalf("plans = %d, want 1", len(plans))
			}
			if !plans[0].Explicit || plans[0].Strategy != tt.strategy {
				t.Fatalf("plan = %+v, want explicit %s", plans[0], tt.strategy)
			}
			if !strings.Contains(plans[0].Details, tt.detail) {
				t.Fatalf("details = %q, want substring %q", plans[0].Details, tt.detail)
			}
		})
	}
}

func TestAssessRollbackPlansNormalizesChecksumPreservingLegacyContracts(t *testing.T) {
	tests := []struct {
		version string
		comment string
	}{
		{
			version: "0425_subscriber_attribute_history",
			comment: "-- rollback-strategy: additive table; prior releases ignore it",
		},
		{
			version: "0389_tenant_goals",
			comment: "-- rollback-strategy: DROP TABLE tenant_goals — additive table",
		},
	}

	for _, tt := range tests {
		plans := AssessRollbackPlans([]MigrationFile{{Version: tt.version, SQL: tt.comment}}, nil)
		if len(plans) != 1 || !plans[0].Explicit || !plans[0].Legacy {
			t.Fatalf("plan = %+v, want explicit legacy contract", plans)
		}
		if plans[0].Strategy != RollbackStrategyNoOp {
			t.Fatalf("strategy = %q, want no-op", plans[0].Strategy)
		}
		if findings := AssessRollbackContracts(plans); len(findings) != 0 {
			t.Fatalf("contract findings = %+v, want none", findings)
		}
	}
}

func TestAssessRollbackPlansRejectsManualDDLOnNewMigration(t *testing.T) {
	plans := AssessRollbackPlans([]MigrationFile{{
		Version: "1736_bad_manual_contract",
		SQL:     "-- rollback-strategy: DROP TABLE subscribers",
	}}, nil)
	findings := AssessRollbackContracts(plans)
	if len(findings) != 1 || findings[0].Rule != "rollback-contract-invalid" {
		t.Fatalf("findings = %+v, want one invalid contract", findings)
	}
}

func TestAssessRollbackPlansInfersRiskyMigrationContract(t *testing.T) {
	files := []MigrationFile{{
		Version: "0101_rename",
		SQL:     "ALTER TABLE campaigns RENAME COLUMN subject TO title;",
	}}
	findings := AssessSafety(files)
	plans := AssessRollbackPlans(files, findings)
	if len(plans) != 1 {
		t.Fatalf("plans = %d, want 1", len(plans))
	}
	if plans[0].Explicit {
		t.Fatalf("expected inferred plan: %+v", plans[0])
	}
	if plans[0].Strategy != RollbackStrategyExpandContract || plans[0].Risk != "rollback-risk" {
		t.Fatalf("unexpected plan: %+v", plans[0])
	}
	contractFindings := AssessRollbackContracts(plans)
	if len(contractFindings) != 1 || contractFindings[0].Rule != "rollback-contract-inferred" {
		t.Fatalf("contract findings = %+v", contractFindings)
	}
}

func TestAssessRollbackContractsBlocksInvalidStrategy(t *testing.T) {
	files := []MigrationFile{{
		Version: "0102_bad_contract",
		SQL:     "-- rollback-strategy: wing-it\nBEGIN; SELECT 1; COMMIT;",
	}}
	plans := AssessRollbackPlans(files, nil)
	findings := AssessRollbackContracts(plans)
	if len(findings) != 1 {
		t.Fatalf("findings = %+v, want one invalid strategy finding", findings)
	}
	if findings[0].Severity != SafetyBlocker || findings[0].Rule != "rollback-contract-invalid" {
		t.Fatalf("unexpected finding: %+v", findings[0])
	}
}
