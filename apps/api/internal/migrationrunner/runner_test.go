package migrationrunner

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests cover the deterministic, DB-independent parts of the
// runner: file loading + checksum computation + plan diffing. The
// applyOne/Run paths are tested in CI's e2e job (see ci.yml) where a
// real Postgres is available.

func writeMigrations(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestLoadFilesSortsByFilenameAndComputesSha256(t *testing.T) {
	dir := writeMigrations(t, map[string]string{
		"0002_b.sql": "BEGIN; SELECT 2; COMMIT;",
		"0001_a.sql": "BEGIN; SELECT 1; COMMIT;",
		"0010_c.sql": "BEGIN; SELECT 10; COMMIT;",
		"README.md":  "ignored",
	})
	files, err := LoadFiles(dir)
	if err != nil {
		t.Fatalf("LoadFiles: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 .sql files, got %d", len(files))
	}
	gotVersions := []string{files[0].Version, files[1].Version, files[2].Version}
	wantVersions := []string{"0001_a", "0002_b", "0010_c"}
	for i := range gotVersions {
		if gotVersions[i] != wantVersions[i] {
			t.Errorf("version[%d] = %q, want %q", i, gotVersions[i], wantVersions[i])
		}
	}
	// Verify the checksum of file[0] is the actual sha256 of its bytes.
	wantSum := sha256.Sum256([]byte("BEGIN; SELECT 1; COMMIT;"))
	if files[0].Checksum != hex.EncodeToString(wantSum[:]) {
		t.Errorf("checksum mismatch: got %s, want %s",
			files[0].Checksum, hex.EncodeToString(wantSum[:]))
	}
}

func TestLoadFilesIgnoresNonSqlAndSubdirs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "0001_x.sql"), []byte("--"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "fixtures"), 0o755); err != nil {
		t.Fatal(err)
	}
	files, err := LoadFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	if files[0].Version != "0001_x" {
		t.Errorf("version = %q", files[0].Version)
	}
}

func TestLoadFilesErrorsOnMissingDir(t *testing.T) {
	_, err := LoadFiles(filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Fatal("expected error on missing dir")
	}
}

func TestLoadFilesAttachesExactReviewedChecksumSupersession(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY", "2026-07-15")
	body := "BEGIN; SELECT 1; COMMIT;"
	current := sha256.Sum256([]byte(body))
	currentHex := hex.EncodeToString(current[:])
	accepted := strings.Repeat("a", 64)
	ledger := fmt.Sprintf(`{
  "version": 1,
  "review": {"owner": "database-owner", "review_by": "2026-10-15"},
  "supersessions": [{
    "version": "0001_a",
    "accepted_sha256": %q,
    "current_sha256": %q,
    "rationale": "populated upgrade repair"
  }]
}`, accepted, currentHex)
	dir := writeMigrations(t, map[string]string{
		"0001_a.sql":                  body,
		checksumSupersessionsFilename: ledger,
	})
	files, err := LoadFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := files[0].AcceptedChecksums[accepted]; got != "populated upgrade repair" {
		t.Fatalf("accepted rationale = %q", got)
	}
	supersession, ok := acceptedChecksumSupersession(files[0], accepted)
	if !ok || supersession.OnDiskChecksum != currentHex {
		t.Fatalf("supersession = %+v, ok=%v", supersession, ok)
	}
	if _, ok := acceptedChecksumSupersession(files[0], strings.Repeat("b", 64)); ok {
		t.Fatal("unreviewed checksum was accepted")
	}
}

func TestLoadFilesRejectsStaleOrExpiredChecksumSupersession(t *testing.T) {
	tests := []struct {
		name       string
		today      string
		currentSHA string
	}{
		{name: "stale current checksum", today: "2026-07-15", currentSHA: strings.Repeat("b", 64)},
		{name: "expired review", today: "2026-10-16", currentSHA: strings.Repeat("a", 64)},
	}
	body := "x"
	actual := sha256.Sum256([]byte(body))
	actualHex := hex.EncodeToString(actual[:])
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY", tt.today)
			currentSHA := tt.currentSHA
			if tt.name == "expired review" {
				currentSHA = actualHex
			}
			ledger := fmt.Sprintf(`{
  "version": 1,
  "review": {"owner": "database-owner", "review_by": "2026-10-15"},
  "supersessions": [{
    "version": "0001_a",
    "accepted_sha256": %q,
    "current_sha256": %q,
    "rationale": "reviewed"
  }]
}`, strings.Repeat("c", 64), currentSHA)
			dir := writeMigrations(t, map[string]string{
				"0001_a.sql":                  body,
				checksumSupersessionsFilename: ledger,
			})
			if _, err := LoadFiles(dir); err == nil {
				t.Fatal("expected supersession ledger to fail closed")
			}
		})
	}
}

// Manually-constructed plan tests: by exercising ComputePlan's pure-
// function nature we can verify the diff algorithm without a DB. We
// extract the diff portion into a helper here that mirrors the logic in
// ComputePlan but takes already-loaded inputs — the actual ComputePlan
// is verified end-to-end in CI's e2e job.

func diffForTest(files []MigrationFile, applied []AppliedRow) (pending []MigrationFile, drift []MigrationDrift) {
	idx := make(map[string]AppliedRow, len(applied))
	for _, a := range applied {
		idx[a.Version] = a
	}
	for _, f := range files {
		row, ok := idx[f.Version]
		if !ok {
			pending = append(pending, f)
			continue
		}
		if row.Checksum != f.Checksum && row.Checksum != "" {
			drift = append(drift, MigrationDrift{
				Version:          f.Version,
				RecordedChecksum: row.Checksum,
				OnDiskChecksum:   f.Checksum,
			})
		}
	}
	return pending, drift
}

func TestPlanDiffPendingAndDrift(t *testing.T) {
	files := []MigrationFile{
		{Version: "0001", Checksum: "aaa"},
		{Version: "0002", Checksum: "bbb"},
		{Version: "0003", Checksum: "ccc-CHANGED"},
		{Version: "0004", Checksum: "ddd"},
	}
	applied := []AppliedRow{
		{Version: "0001", Checksum: "aaa"},          // matches, no drift
		{Version: "0002", Checksum: ""},             // legacy row pre-checksum, do NOT flag
		{Version: "0003", Checksum: "ccc-ORIGINAL"}, // drift
	}
	pending, drift := diffForTest(files, applied)

	if len(pending) != 1 || pending[0].Version != "0004" {
		t.Errorf("pending = %+v, want [0004]", pending)
	}
	if len(drift) != 1 || drift[0].Version != "0003" {
		t.Errorf("drift = %+v, want [0003]", drift)
	}
	if drift[0].RecordedChecksum != "ccc-ORIGINAL" || drift[0].OnDiskChecksum != "ccc-CHANGED" {
		t.Errorf("drift checksums = %+v", drift[0])
	}
}

func TestPlanDiffNothingPendingWhenAllApplied(t *testing.T) {
	files := []MigrationFile{
		{Version: "0001", Checksum: "x"},
		{Version: "0002", Checksum: "y"},
	}
	applied := []AppliedRow{
		{Version: "0001", Checksum: "x"},
		{Version: "0002", Checksum: "y"},
	}
	pending, drift := diffForTest(files, applied)
	if len(pending) != 0 {
		t.Errorf("expected no pending, got %d", len(pending))
	}
	if len(drift) != 0 {
		t.Errorf("expected no drift, got %d", len(drift))
	}
}

func TestAdvisoryLockKeyConstant(t *testing.T) {
	// Sanity-lock the constant. Changing this in a deploy that overlaps
	// with the previous version's runner = no mutex (each version uses
	// its own lock key). DON'T change without a full-fleet redeploy plan.
	if AdvisoryLockKey != 0x10150001 {
		t.Errorf("AdvisoryLockKey changed unexpectedly: 0x%x", AdvisoryLockKey)
	}
}

func TestErrSentinelsAreDistinct(t *testing.T) {
	if ErrChecksumDrift == nil || ErrLockHeld == nil {
		t.Fatal("error sentinels must be non-nil")
	}
	if ErrChecksumDrift.Error() == ErrLockHeld.Error() {
		t.Error("sentinels should have distinct messages for log triage")
	}
}

func TestSplitSQLStatementsHandlesConcurrentIndexMigrations(t *testing.T) {
	sql := strings.Join([]string{
		"BEGIN;",
		"ALTER TABLE campaign_recipients",
		"  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;",
		"COMMIT;",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS stuck_idx",
		"  ON campaign_recipients (claimed_at)",
		"  WHERE status = 'sending';",
		"DO $$",
		"BEGIN",
		"  RAISE NOTICE 'keeps semicolon; inside dollar quote';",
		"END",
		"$$;",
	}, "\n")
	got := splitSQLStatements(sql)
	if len(got) != 5 {
		t.Fatalf("statement count = %d, want 5: %#v", len(got), got)
	}
	if got[0] != "BEGIN;" {
		t.Fatalf("first statement = %q, want BEGIN", got[0])
	}
	if !strings.Contains(got[3], "CREATE INDEX CONCURRENTLY") {
		t.Fatalf("concurrent index statement missing: %#v", got)
	}
	if !strings.Contains(got[4], "keeps semicolon; inside dollar quote") {
		t.Fatalf("dollar-quoted statement was split incorrectly: %q", got[4])
	}
}

func TestRequiresStatementExecutionDetectsConcurrentIndexes(t *testing.T) {
	if !requiresStatementExecution("CREATE UNIQUE INDEX CONCURRENTLY x ON y (z);") {
		t.Fatal("expected concurrent index migration to require statement execution")
	}
	if requiresStatementExecution("CREATE UNIQUE INDEX x ON y (z);") {
		t.Fatal("non-concurrent index should use normal script execution")
	}
	if !requiresStatementExecution("-- migration-execution: phased\nBEGIN; SELECT 1; COMMIT;") {
		t.Fatal("explicit phased migration directive was ignored")
	}
}

func TestTransactionalBodyAcceptsOneCommentedEnvelopeAndDollarQuote(t *testing.T) {
	sql := `
-- rollback-strategy: no-op
BEGIN;
DO $$
BEGIN
  PERFORM 'semicolon; stays inside';
END
$$;
CREATE TABLE atomic_probe (id bigint PRIMARY KEY);
COMMIT;
`
	body, err := transactionalBody(splitSQLStatements(sql))
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 2 || !strings.Contains(body[0], "semicolon; stays inside") || !strings.Contains(body[1], "CREATE TABLE atomic_probe") {
		t.Fatalf("transaction body = %#v", body)
	}
}

func TestTransactionalBodyRejectsMultipleOrUnmatchedEnvelopes(t *testing.T) {
	for _, sql := range []string{
		"BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; COMMIT;",
		"BEGIN; SELECT 1;",
		"SELECT 1; COMMIT;",
	} {
		if _, err := transactionalBody(splitSQLStatements(sql)); err == nil {
			t.Fatalf("transactionalBody(%q) unexpectedly succeeded", sql)
		}
	}
}

func TestSplitMigrationPhasesPreservesTransactionAndRetryUnits(t *testing.T) {
	sql := `
BEGIN;
CREATE TABLE phase_probe (id bigint);
COMMIT;
DROP INDEX CONCURRENTLY IF EXISTS phase_probe_idx;
CREATE INDEX CONCURRENTLY phase_probe_idx ON phase_probe (id);
BEGIN;
ALTER TABLE phase_probe ADD COLUMN note text;
COMMIT;
`
	phases, err := splitMigrationPhases(splitSQLStatements(sql))
	if err != nil {
		t.Fatal(err)
	}
	if len(phases) != 3 || !phases[0].Transactional || phases[1].Transactional || !phases[2].Transactional {
		t.Fatalf("phases = %#v", phases)
	}
	if len(phases[1].Statements) != 2 {
		t.Fatalf("nontransactional retry unit = %#v, want DROP+CREATE together", phases[1].Statements)
	}
}

func TestRoute40TenantReferenceMigrationKeepsAdoptionAndPreflightAtomic(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	var target *MigrationFile
	for i := range files {
		if files[i].Version == "1989_sms_tenant_reference_integrity" {
			target = &files[i]
			break
		}
	}
	if target == nil {
		t.Fatal("migration 1989 not found")
	}
	if !strings.Contains(strings.ToLower(target.SQL), phasedExecutionDirective) {
		t.Fatal("migration 1989 must explicitly declare phased execution")
	}
	phases, err := splitMigrationPhases(splitSQLStatements(target.SQL))
	if err != nil {
		t.Fatal(err)
	}
	if len(phases) != 2 {
		t.Fatalf("migration 1989 phases = %d, want one concurrent-index phase and one transactional adoption phase", len(phases))
	}
	if phases[0].Transactional || len(phases[0].Statements) != 3 {
		t.Fatalf("migration 1989 index phase = %#v, want exactly three non-transactional concurrent indexes", phases[0])
	}
	for _, statement := range phases[0].Statements {
		if _, _, ok, err := concurrentIndexIdentity(statement); err != nil || !ok {
			t.Fatalf("migration 1989 non-transactional statement is not a supported concurrent index: ok=%v err=%v statement=%q", ok, err, statement)
		}
	}
	if !phases[1].Transactional {
		t.Fatal("migration 1989 constraint adoption, mismatch preflight, and validation must be one transaction")
	}
	joined := strings.Join(phases[1].Statements, "\n")
	for _, required := range []string{
		"ADD CONSTRAINT",
		"users_tenant_id_id_campaign_template_uidx",
		"Route40 SMS tenant-reference preflight failed",
		"VALIDATE CONSTRAINT sms_quick_replies_creator_tenant_fk",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("migration 1989 transactional phase is missing %q", required)
		}
	}
}

func TestMigrationPhaseDigestBindsTypeOrderBoundariesAndExactStatements(t *testing.T) {
	base := migrationPhase{Statements: []string{"SELECT 1;", "SELECT 2;"}}
	if got, want := migrationPhaseDigest(base), migrationPhaseDigest(base); got != want {
		t.Fatalf("digest is not deterministic: %s != %s", got, want)
	}
	variants := []migrationPhase{
		{Transactional: true, Statements: base.Statements},
		{Statements: []string{"SELECT 2;", "SELECT 1;"}},
		{Statements: []string{"SELECT 1;SELECT 2;"}},
		{Statements: []string{"SELECT 1;", "SELECT 3;"}},
	}
	baseDigest := migrationPhaseDigest(base)
	for i, variant := range variants {
		if got := migrationPhaseDigest(variant); got == baseDigest {
			t.Errorf("variant %d did not change phase digest", i)
		}
	}
}

// A migration whose body issues its own COMMIT (a batched `DO $$ ... COMMIT
// ... $$`) must declare phased execution, or the runner wraps the file in one
// transaction and Postgres rejects the COMMIT.
//
// This exists because that failure is invisible locally: `psql -f` runs
// statements bare, so such a file applies cleanly on a developer machine and
// fails only on deploy. One migration in this repo was routed correctly purely
// because it happened to contain a CREATE INDEX CONCURRENTLY — remove that
// statement and it would have started failing with nothing to explain why.
func TestMigrationsIssuingTheirOwnCommitDeclarePhasedExecution(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, file := range files {
		for _, statement := range splitSQLStatements(file.SQL) {
			body := strings.ToLower(strings.Join(stripSQLComments(statement), "\n"))
			// A DO block is one statement, so an inner COMMIT is inside it.
			if !strings.HasPrefix(strings.TrimSpace(body), "do") {
				continue
			}
			if !strings.Contains(body, "commit") {
				continue
			}
			checked++
			if !requiresStatementExecution(file.SQL) {
				t.Errorf("%s contains a DO block that issues COMMIT but does not "+
					"require statement execution. The runner will wrap it in a "+
					"transaction and Postgres will reject the COMMIT. Declare "+
					"`-- migration-execution: phased`. This passes `psql -f` "+
					"locally and fails only on deploy.", file.Version)
			}
		}
	}
	if checked == 0 {
		t.Skip("no migration issues its own COMMIT; nothing to check")
	}
	t.Logf("checked %d self-committing migration statement(s)", checked)
}

func TestRepositoryMigrationsHaveSupportedExecutionShape(t *testing.T) {
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if requiresStatementExecution(file.SQL) {
			phases, err := splitMigrationPhases(splitSQLStatements(file.SQL))
			if err != nil {
				t.Errorf("%s phased shape: %v", file.Version, err)
			}
			for _, phase := range phases {
				if phase.Transactional {
					continue
				}
				for _, statement := range phase.Statements {
					clean := strings.ToLower(strings.Join(stripSQLComments(statement), "\n"))
					if strings.Contains(clean, "create") && strings.Contains(clean, "index concurrently") {
						if _, _, ok, err := concurrentIndexIdentity(statement); err != nil || !ok {
							t.Errorf("%s concurrent index identity: ok=%v err=%v", file.Version, ok, err)
						}
					}
				}
			}
			continue
		}
		if _, err := transactionalBody(splitSQLStatements(file.SQL)); err != nil {
			t.Errorf("%s transactional shape: %v", file.Version, err)
		}
	}
}

func TestConcurrentIndexIdentityRejectsUnsupportedQuotedName(t *testing.T) {
	if name, _, ok, err := concurrentIndexIdentity(`CREATE INDEX CONCURRENTLY idx_ok ON things (id)`); err != nil || !ok || name != "idx_ok" {
		t.Fatalf("valid identity = %q/%v/%v", name, ok, err)
	}
	if _, _, _, err := concurrentIndexIdentity(`CREATE INDEX CONCURRENTLY "quoted-index" ON things (id)`); err == nil {
		t.Fatal("quoted concurrent index name unexpectedly passed the fail-closed parser")
	}
}
