// SPDX-License-Identifier: AGPL-3.0-only
package migrationrunner

import (
	"fmt"
	"regexp"
	"strings"
)

// SafetySeverity is the migration risk level detected by the static scanner.
type SafetySeverity string

const (
	SafetyWarning SafetySeverity = "warning"
	SafetyBlocker SafetySeverity = "blocker"
)

// SafetyFinding is one static migration-safety finding.
type SafetyFinding struct {
	Version  string
	Line     int
	Severity SafetySeverity
	Rule     string
	Snippet  string
	Message  string
}

// ErrUnsafeMigration is returned when pending migrations contain destructive
// operations and the caller did not explicitly opt into that risk.
type ErrUnsafeMigration struct {
	Findings []SafetyFinding
}

func (e *ErrUnsafeMigration) Error() string {
	if len(e.Findings) == 0 {
		return "migrationrunner: unsafe migration blocked"
	}
	first := e.Findings[0]
	for _, finding := range e.Findings {
		if finding.Severity == SafetyBlocker {
			first = finding
			break
		}
	}
	return fmt.Sprintf(
		"migrationrunner: unsafe migration blocked: %s line %d %s",
		first.Version,
		first.Line,
		first.Rule,
	)
}

// RunOptions controls production migration execution.
type RunOptions struct {
	// AllowUnsafe permits destructive migrations after a human has taken a
	// fresh backup and accepted the data-loss risk. Normal deploy paths should
	// leave this false.
	AllowUnsafe bool
}

type safetyRule struct {
	name     string
	severity SafetySeverity
	re       *regexp.Regexp
	message  string
}

var safetyRules = []safetyRule{
	{
		name:     "drop-table",
		severity: SafetyBlocker,
		re:       regexp.MustCompile(`(?i)\bdrop\s+table\b`),
		message:  "DROP TABLE is destructive; use an expand/contract migration and remove data only after a retention-backed deprecation window.",
	},
	{
		name:     "drop-column",
		severity: SafetyBlocker,
		re:       regexp.MustCompile(`(?i)\balter\s+table\b.*\bdrop\s+column\b`),
		message:  "DROP COLUMN permanently removes data; ship a nullable replacement first, backfill, cut code over, then drop only after backup + deprecation review.",
	},
	{
		name:     "truncate",
		severity: SafetyBlocker,
		re:       regexp.MustCompile(`(?i)^\s*truncate(?:\s+table)?\b`),
		message:  "TRUNCATE is bulk data loss and bypasses row-level intent; require a reviewed data-retention job instead.",
	},
	{
		name:     "delete-from",
		severity: SafetyBlocker,
		re:       regexp.MustCompile(`(?i)\bdelete\s+from\b`),
		message:  "DELETE in a schema migration is data-destructive; move data cleanup to an audited, resumable job.",
	},
	{
		name:     "rename-table-or-column",
		severity: SafetyWarning,
		re:       regexp.MustCompile(`(?i)\balter\s+table\b.*\brename\s+(?:to|column)\b`),
		message:  "Renames can break the previous release during rollback; prefer additive columns/tables and dual-read/dual-write cutovers.",
	},
	{
		name:     "alter-column-type",
		severity: SafetyWarning,
		re:       regexp.MustCompile(`(?i)\balter\s+table\b.*\balter\s+column\b.*\btype\b`),
		message:  "Column type changes may rewrite data and hold locks; prove it is online or use an additive backfill.",
	},
	{
		name:     "set-not-null",
		severity: SafetyWarning,
		re:       regexp.MustCompile(`(?i)\balter\s+table\b.*\balter\s+column\b.*\bset\s+not\s+null\b`),
		message:  "SET NOT NULL can scan/lock hot tables; backfill first and validate with a CHECK constraint when possible.",
	},
	{
		name:     "create-unique-index",
		severity: SafetyWarning,
		re:       regexp.MustCompile(`(?i)\bcreate\s+unique\s+index\b`),
		message:  "Unique index creation can fail on existing duplicates and block rollback; run a duplicate precheck before deploy.",
	},
	{
		name:     "add-nonconcurrent-unique-constraint",
		severity: SafetyWarning,
		re: regexp.MustCompile(
			`(?i)\balter\s+table\b.*\badd\s+(?:constraint\s+(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)\s+)?unique(?:\s+nulls\s+(?:not\s+)?distinct)?\s*\(`,
		),
		message: "Adding UNIQUE directly to an existing table builds its backing index non-concurrently and can block writers; build CREATE UNIQUE INDEX CONCURRENTLY first, then attach it with UNIQUE USING INDEX in a short transaction.",
	},
}

var (
	routineDefinitionRE = regexp.MustCompile(`(?i)^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\b`)
)

const (
	reviewedPartitionRebuildVersion  = "0339_partition_event_tables"
	reviewedPartitionRebuildChecksum = "9b3f4ac6c4a08295cdc56347f3e507975a325d51bab660d16c24bd683666c844"
	reviewedPartitionRebuildSQL      = "EXECUTE 'ALTER TABLE audit_log_legacy DROP COLUMN IF EXISTS created_at';"

	reviewedRevealOnceReplayPurgeVersion  = "2031_purge_reveal_once_ingest_secret_replays"
	reviewedRevealOnceReplayPurgeChecksum = "a0c37a1606190df3fb9308ec5e323aa916a9e385d7f5768a1942dec21c0af463"
	reviewedRevealOnceReplayPurgeSQL      = "DELETE FROM public.idempotency_records WHERE route = 'POST /api/v1/conversions/ingest-secrets'"
)

var dropColumnClauseRE = regexp.MustCompile(`(?i)\bdrop\s+column\b`)

// AssessSafety statically scans pending migration files for operations that
// can cause data loss or rollback-incompatible updates.
func AssessSafety(files []MigrationFile) []SafetyFinding {
	var findings []SafetyFinding
	for _, file := range files {
		findings = append(findings, assessOne(file)...)
	}
	return findings
}

func assessOne(file MigrationFile) []SafetyFinding {
	var findings []SafetyFinding
	cursor := 0
	for _, sql := range splitSQLStatements(file.SQL) {
		relativeOffset := strings.Index(file.SQL[cursor:], sql)
		if relativeOffset < 0 {
			// splitSQLStatements returns trimmed slices of this exact source. This
			// is defensive only; keeping the scanner fail-closed is safer than
			// silently skipping a statement if that invariant ever changes.
			relativeOffset = 0
		}
		statementOffset := cursor + relativeOffset
		statementLine := 1 + strings.Count(file.SQL[:statementOffset], "\n")
		cursor = statementOffset + len(sql)

		clean := strings.TrimSpace(strings.Join(stripSQLComments(sql), "\n"))
		if clean == "" {
			continue
		}
		// A CREATE FUNCTION/PROCEDURE body describes runtime behavior; it is
		// not executed by the migration. The shared SQL splitter understands
		// dollar- and single-quoted bodies, so only that exact statement is
		// skipped. Destructive SQL after its closing delimiter remains a new
		// statement and is scanned normally. DO blocks are intentionally not
		// skipped because they execute during migration.
		if routineDefinitionRE.MatchString(clean) {
			continue
		}
		findings = append(findings, assessStatement(file, statementLine, clean)...)
	}
	return findings
}

func assessStatement(file MigrationFile, line int, sql string) []SafetyFinding {
	var findings []SafetyFinding
	// Rules describe SQL token order, not source-line layout. Normalize all
	// whitespace before matching so a reviewed clause cannot evade the scanner
	// merely by placing ALTER/DROP/RENAME/TYPE/NOT NULL on separate lines.
	normalizedSQL := strings.Join(strings.Fields(sql), " ")
	for _, rule := range safetyRules {
		if !rule.re.MatchString(normalizedSQL) {
			continue
		}
		severity := rule.severity
		ruleName := rule.name
		message := rule.message
		if isReviewedGeneratedColumnRebuild(file, rule.name, sql) {
			severity = SafetyWarning
			ruleName = "drop-generated-column-rebuild"
			message = "Reviewed partition conversion rebuilds a generated column from its source expression; rehearse the checksum-pinned migration on a populated target before deploy."
		} else if isReviewedRevealOnceReplayPurge(file, rule.name, sql) {
			severity = SafetyWarning
			ruleName = "delete-reveal-once-replay-incident-data"
			message = "Reviewed checksum-pinned incident cleanup permanently removes only legacy generic-replay rows whose response may contain a reveal-once signed-ingest credential."
		}
		findings = append(findings, SafetyFinding{
			Version:  file.Version,
			Line:     line,
			Severity: severity,
			Rule:     ruleName,
			Snippet:  oneLine(sql),
			Message:  message,
		})
	}
	return findings
}

// isReviewedRevealOnceReplayPurge is a single-purpose release exception. A
// pre-fix generic replay row makes a reveal-once signing secret recoverable in
// the operator inspector for 24 hours, so retention is the vulnerability. The
// exception is pinned to the migration version, exact file checksum, exact
// canonical route predicate, and a single DELETE. Any drift is a blocker.
func isReviewedRevealOnceReplayPurge(file MigrationFile, rule, sql string) bool {
	normalizedSQL := strings.TrimSuffix(strings.Join(strings.Fields(sql), " "), ";")
	return file.Version == reviewedRevealOnceReplayPurgeVersion &&
		file.Checksum == reviewedRevealOnceReplayPurgeChecksum &&
		rule == "delete-from" &&
		normalizedSQL == reviewedRevealOnceReplayPurgeSQL
}

// isReviewedGeneratedColumnRebuild is deliberately version-, checksum-, rule-,
// and semantics-bound. Migration 0339 must remain byte-for-byte immutable, but
// its partition conversion drops only a generated column and immediately
// recreates it from the source `at` column before attaching the legacy table.
// The SQL splitter correctly keeps the apply-time DO block intact, so the exact
// reviewed EXECUTE is matched inside that one statement. A second DROP COLUMN,
// any source drift, or any unreviewed statement falls back to the blocker.
func isReviewedGeneratedColumnRebuild(file MigrationFile, rule, sql string) bool {
	normalizedSQL := strings.Join(strings.Fields(sql), " ")
	return file.Version == reviewedPartitionRebuildVersion &&
		file.Checksum == reviewedPartitionRebuildChecksum &&
		rule == "drop-column" &&
		strings.Contains(normalizedSQL, reviewedPartitionRebuildSQL) &&
		len(dropColumnClauseRE.FindAllStringIndex(normalizedSQL, -1)) == 1
}

func hasSafetyBlockers(findings []SafetyFinding) bool {
	for _, f := range findings {
		if f.Severity == SafetyBlocker {
			return true
		}
	}
	return false
}

func stripSQLComments(sql string) []string {
	lines := strings.Split(sql, "\n")
	out := make([]string, len(lines))
	inBlock := false
	for i, line := range lines {
		var b strings.Builder
		for j := 0; j < len(line); {
			if inBlock {
				end := strings.Index(line[j:], "*/")
				if end == -1 {
					break
				}
				j += end + 2
				inBlock = false
				continue
			}
			if strings.HasPrefix(line[j:], "--") {
				break
			}
			if strings.HasPrefix(line[j:], "/*") {
				inBlock = true
				j += 2
				continue
			}
			b.WriteByte(line[j])
			j++
		}
		out[i] = b.String()
	}
	return out
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= 180 {
		return s
	}
	return s[:177] + "..."
}
