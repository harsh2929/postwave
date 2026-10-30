// SPDX-License-Identifier: AGPL-3.0-only
package migrationrunner

import (
	"regexp"
	"strings"
)

const (
	RollbackStrategyExpandContract = "expand-contract"
	RollbackStrategyRestore        = "restore"
	RollbackStrategyRehearsedJob   = "rehearsed-job"
	RollbackStrategyNoOp           = "no-op"
)

// RollbackPlan records how a forward-only migration is expected to be rolled
// back operationally. Moosewave still does not generate down migrations; this
// contract makes that posture explicit and reviewable in dry-run output.
type RollbackPlan struct {
	Version  string
	Strategy string
	Explicit bool
	Legacy   bool
	Line     int
	Risk     string
	Details  string
}

var (
	rollbackStrategyRe = regexp.MustCompile(`(?im)^\s*--\s*rollback-strategy\s*:\s*([a-z0-9]+(?:[-_][a-z0-9]+)*)([^\r\n]*)$`)
	rollbackDetailRe   = regexp.MustCompile(`(?im)^\s*--\s*rollback-(?:detail|details|plan)\s*:\s*(.+)$`)
)

// These five append-only migrations predate the enumerated rollback contract
// and put their optional hard-rollback DDL directly in the strategy field.
// Their changes are additive and compatible with the prior application, so
// the safe operational rollback is to leave the schema in place. Matching the
// exact version and declaration prefix avoids accepting arbitrary SQL as a
// strategy on new migrations while preserving checksum-tracked history.
var legacyManualRollbackPrefixes = map[string]string{
	"0389_tenant_goals":                   "DROP TABLE tenant_goals",
	"0390_audit_export_schedules":         "DROP TABLE audit_export_schedules; ALTER TABLE",
	"0391_audit_alert_rules_notify_slack": "ALTER TABLE audit_alert_rules DROP COLUMN",
	"0392_segment_size_history":           "DROP TABLE segment_size_history",
	"1000_subscriber_growth_history":      "DROP TABLE subscriber_growth_history",
}

// AssessRollbackPlans derives a rollback contract for every pending migration.
// Migrations can declare one explicitly:
//
//	-- rollback-strategy: expand-contract - old code continues to read old_col
//	-- rollback-details: restore from preflight backup if validation fails
//
// Allowed strategies: expand-contract, restore, rehearsed-job, no-op.
func AssessRollbackPlans(files []MigrationFile, findings []SafetyFinding) []RollbackPlan {
	byVersion := map[string][]SafetyFinding{}
	for _, finding := range findings {
		byVersion[finding.Version] = append(byVersion[finding.Version], finding)
	}
	plans := make([]RollbackPlan, 0, len(files))
	for _, file := range files {
		plan := parseRollbackPlan(file)
		plan.Risk = rollbackRisk(byVersion[file.Version])
		if plan.Strategy == "" {
			plan.Explicit = false
			plan.Strategy = inferRollbackStrategy(plan.Risk)
			plan.Details = inferredRollbackDetails(plan.Risk)
		}
		plans = append(plans, plan)
	}
	return plans
}

// AssessRollbackContracts returns safety findings for invalid or incomplete
// rollback contracts. It is separate from AssessSafety so existing scanner
// tests stay focused on SQL operations while Run/dry-run can combine both.
func AssessRollbackContracts(plans []RollbackPlan) []SafetyFinding {
	var findings []SafetyFinding
	for _, plan := range plans {
		if !isAllowedRollbackStrategy(plan.Strategy) {
			findings = append(findings, SafetyFinding{
				Version:  plan.Version,
				Line:     nonZeroLine(plan.Line),
				Severity: SafetyBlocker,
				Rule:     "rollback-contract-invalid",
				Snippet:  plan.Strategy,
				Message:  "Rollback strategy must be one of expand-contract, restore, rehearsed-job, or no-op.",
			})
			continue
		}
		if plan.Risk != "low" && !plan.Explicit {
			findings = append(findings, SafetyFinding{
				Version:  plan.Version,
				Line:     1,
				Severity: SafetyWarning,
				Rule:     "rollback-contract-inferred",
				Snippet:  plan.Strategy,
				Message:  "Migration has rollback-risk SQL but no explicit rollback-strategy comment; dry-run inferred an operational rollback plan.",
			})
		}
		if plan.Risk != "low" && plan.Explicit && strings.TrimSpace(plan.Details) == "" {
			findings = append(findings, SafetyFinding{
				Version:  plan.Version,
				Line:     nonZeroLine(plan.Line),
				Severity: SafetyWarning,
				Rule:     "rollback-contract-detail-missing",
				Snippet:  plan.Strategy,
				Message:  "Rollback-risk migration declares a strategy but no rollback details for the operator runbook.",
			})
		}
	}
	return findings
}

func parseRollbackPlan(file MigrationFile) RollbackPlan {
	plan := RollbackPlan{Version: file.Version}
	lines := strings.Split(file.SQL, "\n")
	for i, line := range lines {
		match := rollbackStrategyRe.FindStringSubmatch(line)
		if len(match) == 0 {
			continue
		}
		plan.Line = i + 1
		plan.Explicit = true
		plan.Strategy = normalizeRollbackStrategy(match[1])
		if len(match) > 2 {
			plan.Details = trimRollbackDetailPrefix(match[2])
		}
		declaration := strings.TrimSpace(match[1] + match[2])
		switch {
		case plan.Strategy == "additive":
			plan.Legacy = true
			plan.Strategy = RollbackStrategyNoOp
			plan.Details = declaration
		case matchesLegacyManualRollback(file.Version, declaration):
			plan.Legacy = true
			plan.Strategy = RollbackStrategyNoOp
			plan.Details = declaration
		}
		break
	}
	if detail := rollbackDetailRe.FindStringSubmatch(file.SQL); len(detail) > 1 {
		plan.Details = strings.TrimSpace(detail[1])
	}
	return plan
}

func matchesLegacyManualRollback(version, declaration string) bool {
	prefix, ok := legacyManualRollbackPrefixes[version]
	return ok && strings.HasPrefix(strings.ToUpper(declaration), strings.ToUpper(prefix))
}

// trimRollbackDetailPrefix removes punctuation commonly used between the
// strategy token and its explanation. Parsing the strategy token separately
// is important: treating a bare hyphen as the delimiter makes valid values
// such as "no-op" and "expand-contract" backtrack to "no" and "expand".
func trimRollbackDetailPrefix(detail string) string {
	detail = strings.TrimSpace(detail)
	detail = strings.TrimLeft(detail, "-—–:;,")
	return strings.TrimSpace(detail)
}

func rollbackRisk(findings []SafetyFinding) string {
	risk := "low"
	for _, finding := range findings {
		if finding.Severity == SafetyBlocker {
			return "destructive"
		}
		if finding.Severity == SafetyWarning {
			risk = "rollback-risk"
		}
	}
	return risk
}

func inferRollbackStrategy(risk string) string {
	switch risk {
	case "destructive":
		return RollbackStrategyRestore
	case "rollback-risk":
		return RollbackStrategyExpandContract
	default:
		return RollbackStrategyNoOp
	}
}

func inferredRollbackDetails(risk string) string {
	switch risk {
	case "destructive":
		return "Inferred: restore from preflight backup or run a reviewed repair job; destructive SQL is blocked unless --allow-unsafe is used."
	case "rollback-risk":
		return "Inferred: previous release must remain compatible through expand/contract or dual-read/dual-write rollout."
	default:
		return "Inferred: additive/no-op rollback; leave forward migration applied and redeploy previous compatible code."
	}
}

func isAllowedRollbackStrategy(strategy string) bool {
	switch normalizeRollbackStrategy(strategy) {
	case RollbackStrategyExpandContract, RollbackStrategyRestore, RollbackStrategyRehearsedJob, RollbackStrategyNoOp:
		return true
	default:
		return false
	}
}

func normalizeRollbackStrategy(strategy string) string {
	strategy = strings.ToLower(strings.TrimSpace(strategy))
	return strings.ReplaceAll(strategy, "_", "-")
}

func nonZeroLine(line int) int {
	if line <= 0 {
		return 1
	}
	return line
}
