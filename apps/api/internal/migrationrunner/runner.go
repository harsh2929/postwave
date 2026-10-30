// SPDX-License-Identifier: AGPL-3.0-only
//
// Package migrationrunner is the Moosewave SQL migration runner.
//
// Why a real runner instead of the bash-in-yaml that ships in
// infra/docker-compose.full.yml?
//
//   - Concurrency: rolling deploys boot multiple pods simultaneously.
//     Without coordination, two pods race the same DDL and at least one
//     fails mid-file leaving partial state. We take pg_advisory_lock so
//     exactly one runner applies migrations at a time; the others wait.
//
//   - Drift detection: an operator who edits an already-applied
//     migration after deploy expects the change to apply on next boot.
//     The bash runner skips by filename, so the DB diverges silently.
//     We hash every applied file (sha256) and refuse to start when a
//     known version's content has changed.
//
//   - Dry-run: production deploy windows want a "what would apply?"
//     sanity check. --dry-run lists pending versions and exits.
//
// Schema:
//
//	schema_migrations(version text PRIMARY KEY,
//	                  checksum  text NOT NULL,
//	                  applied_at timestamptz NOT NULL DEFAULT now())
//
// We bootstrap this table on first run so existing databases without
// it (or the bash-runner's flat schema_migrations(version) shape) get
// upgraded transparently.
package migrationrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdvisoryLockKey is the int64 passed to pg_try_advisory_lock. Value chosen
// to be unlikely to collide with any other advisory lock in the system:
//
//	0x10150001 = (16-bit "migrate") << 16 | (16-bit project id "0001")
//
// Hardcoded on purpose — every Moosewave runner across every cluster MUST
// use the same key, otherwise the mutex is meaningless.
const AdvisoryLockKey int64 = 0x10150001

// MigrationFile is one .sql file on disk + its computed sha256.
type MigrationFile struct {
	Version           string // filename without .sql, e.g. "0001_init_tenants"
	Path              string // absolute path
	Checksum          string // hex(sha256(file_bytes))
	SQL               string
	AcceptedChecksums map[string]string // exact historical checksum -> reviewed rationale
}

// AppliedRow is one row from schema_migrations.
type AppliedRow struct {
	Version  string
	Checksum string
}

// Plan describes what Run would do without doing it.
type Plan struct {
	Pending               []MigrationFile                 // versions to apply, in order
	Drift                 []MigrationDrift                // applied versions whose checksum no longer matches
	Applied               []AppliedRow                    // versions already applied
	AcceptedSupersessions []MigrationChecksumSupersession // reviewed old checksums accepted for this release
}

// MigrationChecksumSupersession records a narrow, reviewed history split.
// General checksum drift remains fatal; only an exact old checksum paired with
// the exact current checksum from checksum-supersessions.json is accepted.
type MigrationChecksumSupersession struct {
	Version          string
	RecordedChecksum string
	OnDiskChecksum   string
	Rationale        string
}

// MigrationDrift names a version that has been applied previously but
// whose on-disk content's sha256 no longer matches the recorded checksum.
type MigrationDrift struct {
	Version          string
	RecordedChecksum string
	OnDiskChecksum   string
}

// ErrChecksumDrift is returned by Run when one or more applied migrations
// have been edited on disk after they were applied. Migration runners
// must NEVER silently ignore this — the schema would diverge between the
// editor's environment and the running database.
var ErrChecksumDrift = errors.New("migrationrunner: checksum drift detected on applied migration(s)")

// ErrLockHeld is returned when pg_try_advisory_lock fails because another
// runner already holds the lock. The caller should either wait or exit.
var ErrLockHeld = errors.New("migrationrunner: another runner holds the advisory lock")

const checksumSupersessionsFilename = "checksum-supersessions.json"

type checksumSupersessionLedger struct {
	Version int `json:"version"`
	Review  struct {
		Owner    string `json:"owner"`
		ReviewBy string `json:"review_by"`
	} `json:"review"`
	Supersessions []checksumSupersessionRecord `json:"supersessions"`
}

type checksumSupersessionRecord struct {
	Version        string `json:"version"`
	AcceptedSHA256 string `json:"accepted_sha256"`
	CurrentSHA256  string `json:"current_sha256"`
	Rationale      string `json:"rationale"`
}

// LoadFiles reads every *.sql file under dir, sorted by filename. The
// filename's stem (before .sql) is the version. The whole file is hashed.
func LoadFiles(dir string) ([]MigrationFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	supersessions, err := loadChecksumSupersessions(dir)
	if err != nil {
		return nil, err
	}
	seenSupersessionVersions := make(map[string]bool, len(supersessions))
	out := make([]MigrationFile, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := fs.ReadFile(os.DirFS(dir), e.Name())
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		sum := sha256.Sum256(data)
		version := strings.TrimSuffix(e.Name(), ".sql")
		checksum := hex.EncodeToString(sum[:])
		accepted := map[string]string(nil)
		if records := supersessions[version]; len(records) > 0 {
			accepted = make(map[string]string, len(records))
			for _, record := range records {
				if record.CurrentSHA256 != checksum {
					return nil, fmt.Errorf(
						"migration checksum supersession for %s expects current checksum %s, got %s",
						version, record.CurrentSHA256, checksum,
					)
				}
				accepted[record.AcceptedSHA256] = record.Rationale
			}
			seenSupersessionVersions[version] = true
		}
		out = append(out, MigrationFile{
			Version:           version,
			Path:              path,
			Checksum:          checksum,
			SQL:               string(data),
			AcceptedChecksums: accepted,
		})
	}
	for version := range supersessions {
		if !seenSupersessionVersions[version] {
			return nil, fmt.Errorf("migration checksum supersession references missing version %s", version)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

func loadChecksumSupersessions(dir string) (map[string][]checksumSupersessionRecord, error) {
	path := filepath.Join(dir, checksumSupersessionsFilename)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read migration checksum supersessions: %w", err)
	}
	var ledger checksumSupersessionLedger
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decodeErr := decoder.Decode(&ledger); decodeErr != nil {
		return nil, fmt.Errorf("decode migration checksum supersessions: %w", decodeErr)
	}
	if ledger.Version != 1 {
		return nil, fmt.Errorf("migration checksum supersessions version must be 1")
	}
	if strings.TrimSpace(ledger.Review.Owner) == "" || strings.TrimSpace(ledger.Review.ReviewBy) == "" {
		return nil, fmt.Errorf("migration checksum supersessions require review owner and review_by")
	}
	reviewBy, err := time.Parse("2006-01-02", ledger.Review.ReviewBy)
	if err != nil {
		return nil, fmt.Errorf("invalid migration checksum supersession review_by: %w", err)
	}
	today := time.Now().UTC()
	if override := strings.TrimSpace(os.Getenv("POSTWAVE_MIGRATION_SUPERSESSION_TODAY")); override != "" {
		today, err = time.Parse("2006-01-02", override)
		if err != nil {
			return nil, fmt.Errorf("invalid POSTWAVE_MIGRATION_SUPERSESSION_TODAY: %w", err)
		}
	}
	if today.After(reviewBy.Add(24*time.Hour - time.Nanosecond)) {
		return nil, fmt.Errorf(
			"migration checksum supersession review expired on %s (owner: %s)",
			ledger.Review.ReviewBy, ledger.Review.Owner,
		)
	}
	byVersion := make(map[string][]checksumSupersessionRecord, len(ledger.Supersessions))
	seen := map[string]bool{}
	for _, record := range ledger.Supersessions {
		if strings.TrimSpace(record.Version) == "" ||
			!validSHA256(record.AcceptedSHA256) ||
			!validSHA256(record.CurrentSHA256) ||
			strings.TrimSpace(record.Rationale) == "" {
			return nil, fmt.Errorf("invalid migration checksum supersession for %q", record.Version)
		}
		if record.AcceptedSHA256 == record.CurrentSHA256 {
			return nil, fmt.Errorf("migration checksum supersession for %s does not change checksum", record.Version)
		}
		identity := record.Version + ":" + record.AcceptedSHA256
		if seen[identity] {
			return nil, fmt.Errorf("duplicate migration checksum supersession for %s", identity)
		}
		seen[identity] = true
		byVersion[record.Version] = append(byVersion[record.Version], record)
	}
	return byVersion, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

// Plan returns the work that would be done. It does NOT acquire the
// advisory lock or modify any data.
func ComputePlan(ctx context.Context, pool *pgxpool.Pool, files []MigrationFile) (*Plan, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire plan connection: %w", err)
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin read-only plan: %w", err)
	}
	defer rollbackMigrationTx(tx)
	applied, err := readAppliedReadOnly(ctx, tx)
	if err != nil {
		return nil, err
	}
	plan := buildPlan(files, applied)
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit read-only plan: %w", err)
	}
	return plan, nil
}

type migrationReader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type migrationPlanner interface {
	migrationExecer
	migrationReader
}

func computePlan(ctx context.Context, db migrationPlanner, files []MigrationFile) (*Plan, error) {
	if err := ensureSchema(ctx, db); err != nil {
		return nil, err
	}
	applied, err := readApplied(ctx, db)
	if err != nil {
		return nil, err
	}
	return buildPlan(files, applied), nil
}

func buildPlan(files []MigrationFile, applied []AppliedRow) *Plan {
	appliedByVersion := make(map[string]AppliedRow, len(applied))
	for _, a := range applied {
		appliedByVersion[a.Version] = a
	}
	plan := &Plan{Applied: applied}
	for _, f := range files {
		row, ok := appliedByVersion[f.Version]
		if !ok {
			plan.Pending = append(plan.Pending, f)
			continue
		}
		if row.Checksum != f.Checksum && row.Checksum != "" {
			if accepted, ok := acceptedChecksumSupersession(f, row.Checksum); ok {
				plan.AcceptedSupersessions = append(plan.AcceptedSupersessions, accepted)
				continue
			}
			plan.Drift = append(plan.Drift, MigrationDrift{
				Version:          f.Version,
				RecordedChecksum: row.Checksum,
				OnDiskChecksum:   f.Checksum,
			})
		}
	}
	return plan
}

func acceptedChecksumSupersession(file MigrationFile, recorded string) (MigrationChecksumSupersession, bool) {
	rationale, ok := file.AcceptedChecksums[recorded]
	if !ok || recorded == "" || recorded == file.Checksum {
		return MigrationChecksumSupersession{}, false
	}
	return MigrationChecksumSupersession{
		Version:          file.Version,
		RecordedChecksum: recorded,
		OnDiskChecksum:   file.Checksum,
		Rationale:        rationale,
	}, true
}

// Run applies every pending migration under the advisory lock. Drift is
// fatal — Run returns ErrChecksumDrift without applying anything.
//
// Concurrency contract: only one Run may execute at a time across all
// processes pointed at the same database. We use pg_try_advisory_lock so
// concurrent callers fail fast with ErrLockHeld instead of blocking.
func Run(ctx context.Context, pool *pgxpool.Pool, files []MigrationFile, logger *slog.Logger) error {
	return RunWithOptions(ctx, pool, files, logger, RunOptions{})
}

// RunWithOptions applies every pending migration under the advisory lock.
func RunWithOptions(ctx context.Context, pool *pgxpool.Pool, files []MigrationFile, logger *slog.Logger, opts RunOptions) error {
	// Lock before planning. Planning outside this session lock lets runner B
	// cache A's still-pending versions, then replay non-transactional DDL after
	// A commits and releases the lock. The plan, drift check, safety assessment,
	// and application now all share one advisory-lock epoch and connection.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn: %w", err)
	}
	releaseConn := true
	defer func() {
		if releaseConn {
			conn.Release()
		}
	}()

	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1)`, AdvisoryLockKey,
	).Scan(&got); err != nil {
		// The server may have acquired the session lock before the transport
		// error became visible. Never return that uncertain physical session to
		// the pool.
		releaseConn = false
		discardMigrationLockConn(conn)
		return fmt.Errorf("advisory lock: %w", err)
	}
	if !got {
		return ErrLockHeld
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		releaseErr := conn.QueryRow(releaseCtx,
			`SELECT pg_advisory_unlock($1)`, AdvisoryLockKey).Scan(&unlocked)
		if releaseErr != nil || !unlocked {
			logger.Warn("advisory unlock failed",
				"err", releaseErr,
				"unlocked", unlocked,
				"key", AdvisoryLockKey)
			releaseConn = false
			discardMigrationLockConn(conn)
		}
	}()

	plan, err := computePlan(ctx, conn.Conn(), files)
	if err != nil {
		return err
	}
	if len(plan.Drift) > 0 {
		for _, d := range plan.Drift {
			logger.Error("migration checksum drift",
				"version", d.Version,
				"recorded", d.RecordedChecksum,
				"on_disk", d.OnDiskChecksum)
		}
		return ErrChecksumDrift
	}
	for _, accepted := range plan.AcceptedSupersessions {
		logger.Warn("reviewed migration checksum supersession accepted",
			"version", accepted.Version,
			"recorded", accepted.RecordedChecksum,
			"on_disk", accepted.OnDiskChecksum,
			"rationale", accepted.Rationale)
	}
	if len(plan.Pending) == 0 {
		logger.Info("migrations: nothing to do",
			"applied_count", len(plan.Applied))
		return nil
	}
	findings := AssessSafety(plan.Pending)
	rollbackPlans := AssessRollbackPlans(plan.Pending, findings)
	findings = append(findings, AssessRollbackContracts(rollbackPlans)...)
	for _, p := range rollbackPlans {
		logger.Info("migration rollback contract",
			"version", p.Version,
			"strategy", p.Strategy,
			"explicit", p.Explicit,
			"risk", p.Risk,
			"details", p.Details)
	}
	for _, f := range findings {
		logger.Warn("migration safety finding",
			"version", f.Version,
			"line", f.Line,
			"severity", string(f.Severity),
			"rule", f.Rule,
			"message", f.Message,
			"snippet", f.Snippet)
	}
	if hasSafetyBlockers(findings) && !opts.AllowUnsafe {
		return &ErrUnsafeMigration{Findings: findings}
	}

	logger.Info("migrations: applying",
		"pending_count", len(plan.Pending),
		"applied_count", len(plan.Applied))

	for _, f := range plan.Pending {
		// Each migration runs in its own transaction so a failure in
		// migration N doesn't roll back migration N-1's work. Files that
		// internally `BEGIN;`/`COMMIT;` (the existing convention) still
		// work because pg_query_simple runs them as a script.
		if err := applyOne(ctx, conn.Conn(), f); err != nil {
			return fmt.Errorf("migration %s: %w", f.Version, err)
		}
		logger.Info("migration applied", "version", f.Version)
	}
	logger.Info("migrations: complete", "applied", len(plan.Pending))
	return nil
}

func discardMigrationLockConn(conn *pgxpool.Conn) {
	if conn == nil {
		return
	}
	raw := conn.Hijack()
	if raw == nil {
		return
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = raw.Close(closeCtx)
}

// ensureSchema creates schema_migrations if missing AND adds the checksum
// column to legacy tables that only have (version). The upgrade is
// idempotent so repeated runs after the first deploy are no-ops.
func ensureSchema(ctx context.Context, db migrationExecer) error {
	const ddl = `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			checksum   text NOT NULL DEFAULT '',
			applied_at timestamptz NOT NULL DEFAULT now()
		);
		ALTER TABLE schema_migrations
			ADD COLUMN IF NOT EXISTS checksum text NOT NULL DEFAULT '';
		ALTER TABLE schema_migrations
			ADD COLUMN IF NOT EXISTS applied_at timestamptz NOT NULL DEFAULT now();
		CREATE TABLE IF NOT EXISTS schema_migration_steps (
			version    text NOT NULL,
			step       integer NOT NULL CHECK (step >= 0),
			checksum   text NOT NULL,
			phase_digest text NOT NULL,
			transactional boolean NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (version, step)
		);
		ALTER TABLE schema_migration_steps
			ADD COLUMN IF NOT EXISTS phase_digest text;
		ALTER TABLE schema_migration_steps
			ADD COLUMN IF NOT EXISTS transactional boolean;
	`
	_, err := db.Exec(ctx, ddl)
	if err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}
	return nil
}

// readAppliedReadOnly deliberately avoids ensureSchema so --dry-run has no
// database side effects. A database with no migration ledger is a clean
// bootstrap; a legacy version-only ledger is readable without upgrading it.
func readAppliedReadOnly(ctx context.Context, db migrationReader) ([]AppliedRow, error) {
	var relation *string
	if err := db.QueryRow(ctx, `SELECT to_regclass('schema_migrations')::text`).Scan(&relation); err != nil {
		return nil, fmt.Errorf("resolve schema_migrations: %w", err)
	}
	if relation == nil {
		return nil, nil
	}

	var hasVersion, hasChecksum bool
	if err := db.QueryRow(ctx, `
		SELECT
			EXISTS (
				SELECT 1 FROM pg_attribute
				 WHERE attrelid = to_regclass('schema_migrations')
				   AND attname = 'version' AND attnum > 0 AND NOT attisdropped
			),
			EXISTS (
				SELECT 1 FROM pg_attribute
				 WHERE attrelid = to_regclass('schema_migrations')
				   AND attname = 'checksum' AND attnum > 0 AND NOT attisdropped
			)
	`).Scan(&hasVersion, &hasChecksum); err != nil {
		return nil, fmt.Errorf("inspect schema_migrations: %w", err)
	}
	if !hasVersion {
		return nil, fmt.Errorf("schema_migrations is missing required version column")
	}
	if hasChecksum {
		return readApplied(ctx, db)
	}

	rows, err := db.Query(ctx,
		`SELECT version, ''::text AS checksum FROM schema_migrations ORDER BY version ASC`)
	if err != nil {
		return nil, fmt.Errorf("read legacy schema_migrations: %w", err)
	}
	return scanAppliedRows(rows)
}

func readApplied(ctx context.Context, db migrationReader) ([]AppliedRow, error) {
	rows, err := db.Query(ctx,
		`SELECT version, checksum FROM schema_migrations ORDER BY version ASC`)
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	return scanAppliedRows(rows)
}

func scanAppliedRows(rows pgx.Rows) ([]AppliedRow, error) {
	defer rows.Close()
	out := []AppliedRow{}
	for rows.Next() {
		var r AppliedRow
		if err := rows.Scan(&r.Version, &r.Checksum); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func applyOne(ctx context.Context, conn *pgx.Conn, f MigrationFile) error {
	if !requiresStatementExecution(f.SQL) {
		return applyTransactionalMigration(ctx, conn, f)
	}
	return applyPhasedMigration(ctx, conn, f)
}

type migrationExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func recordAppliedMigration(ctx context.Context, execer migrationExecer, f MigrationFile) error {
	if _, err := execer.Exec(ctx, `
		INSERT INTO schema_migrations (version, checksum)
		VALUES ($1, $2)
	`, f.Version, f.Checksum); err != nil {
		return fmt.Errorf("record version: %w", err)
	}
	return nil
}

// applyTransactionalMigration couples the schema_migrations row to the same
// PostgreSQL commit as every transactional DDL/data statement. This removes
// the former crash window in which a file committed successfully but the
// version INSERT was lost, leaving non-idempotent DDL applied and unrecorded.
func applyTransactionalMigration(ctx context.Context, conn *pgx.Conn, f MigrationFile) (err error) {
	statements := splitSQLStatements(f.SQL)
	body, err := transactionalBody(statements)
	if err != nil {
		return err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackMigrationTx(tx)
	for _, stmt := range body {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	if err := recordAppliedMigration(ctx, tx, f); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type migrationPhase struct {
	Transactional bool
	Statements    []string
}

// applyPhasedMigration supports files containing CREATE/DROP INDEX
// CONCURRENTLY. Transaction blocks are committed together with a durable
// phase marker; contiguous non-transactional statements form one retry unit.
// A process loss after a transaction commit can therefore skip that exact
// phase on restart instead of replaying non-idempotent DDL. Non-transactional
// phases remain responsible for file-level idempotency because PostgreSQL
// cannot atomically couple concurrent index DDL to a ledger write.
func applyPhasedMigration(ctx context.Context, conn *pgx.Conn, f MigrationFile) error {
	phases, err := splitMigrationPhases(splitSQLStatements(f.SQL))
	if err != nil {
		return err
	}
	appliedSteps, err := loadAndValidateMigrationPhases(ctx, conn, f, phases)
	if err != nil {
		return err
	}
	for step, phase := range phases {
		if appliedSteps[step] {
			continue
		}
		if phase.Transactional {
			if err := applyTransactionalPhase(ctx, conn, f, step, phase); err != nil {
				return err
			}
			continue
		}
		for _, stmt := range phase.Statements {
			indexSpec, err := parseConcurrentIndex(stmt)
			if err != nil {
				return err
			}
			if indexSpec != nil {
				if err := dropInvalidConcurrentIndexShell(ctx, conn, *indexSpec); err != nil {
					return err
				}
			}
			if _, err := conn.Exec(ctx, stmt); err != nil {
				return err
			}
			if indexSpec != nil {
				if err := verifyConcurrentIndex(ctx, conn, *indexSpec); err != nil {
					return err
				}
			}
		}
		if err := recordMigrationPhase(ctx, conn, f, step, phase); err != nil {
			return err
		}
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackMigrationTx(tx)
	if err := recordAppliedMigration(ctx, tx, f); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM schema_migration_steps WHERE version = $1`, f.Version); err != nil {
		return fmt.Errorf("clear migration phase ledger: %w", err)
	}
	return tx.Commit(ctx)
}

func applyTransactionalPhase(ctx context.Context, conn *pgx.Conn, f MigrationFile, step int, phase migrationPhase) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackMigrationTx(tx)
	for _, stmt := range phase.Statements {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	if err := recordMigrationPhase(ctx, tx, f, step, phase); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func recordMigrationPhase(ctx context.Context, execer migrationExecer, f MigrationFile, step int, phase migrationPhase) error {
	_, err := execer.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum, phase_digest, transactional)
		VALUES ($1, $2, $3, $4, $5)
	`, f.Version, step, f.Checksum, migrationPhaseDigest(phase), phase.Transactional)
	if err != nil {
		return fmt.Errorf("record migration phase %d: %w", step, err)
	}
	return nil
}

func migrationPhaseDigest(phase migrationPhase) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte("postwave-migration-phase-v1\x00"))
	if phase.Transactional {
		_, _ = hash.Write([]byte{1})
	} else {
		_, _ = hash.Write([]byte{0})
	}
	var frame [8]byte
	binary.BigEndian.PutUint64(frame[:], uint64(len(phase.Statements)))
	_, _ = hash.Write(frame[:])
	for _, statement := range phase.Statements {
		binary.BigEndian.PutUint64(frame[:], uint64(len(statement)))
		_, _ = hash.Write(frame[:])
		_, _ = hash.Write([]byte(statement))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func rollbackMigrationTx(tx pgx.Tx) {
	if tx == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

func loadAndValidateMigrationPhases(ctx context.Context, conn *pgx.Conn, f MigrationFile, phases []migrationPhase) (map[int]bool, error) {
	rows, err := conn.Query(ctx, `
		SELECT step, checksum, phase_digest, transactional
		  FROM schema_migration_steps
		 WHERE version = $1
		 ORDER BY step
	`, f.Version)
	if err != nil {
		return nil, fmt.Errorf("read migration phase ledger: %w", err)
	}
	defer rows.Close()
	applied := make(map[int]bool)
	for rows.Next() {
		var step int
		var checksum string
		var phaseDigest *string
		var transactional *bool
		if err := rows.Scan(&step, &checksum, &phaseDigest, &transactional); err != nil {
			return nil, fmt.Errorf("scan migration phase ledger: %w", err)
		}
		if step < 0 || step >= len(phases) {
			return nil, fmt.Errorf("migration %s phase ledger contains out-of-range step %d; resume with the prior runner or restore/operator-attest before retrying", f.Version, step)
		}
		if checksum != f.Checksum {
			return nil, fmt.Errorf("migration %s phase %d checksum drift: recorded %s, on disk %s", f.Version, step, checksum, f.Checksum)
		}
		if phaseDigest == nil || transactional == nil {
			return nil, fmt.Errorf("migration %s phase %d has a legacy phase marker; resume with the prior runner or restore/operator-attest before retrying", f.Version, step)
		}
		expected := phases[step]
		expectedDigest := migrationPhaseDigest(expected)
		if *transactional != expected.Transactional || *phaseDigest != expectedDigest {
			return nil, fmt.Errorf("migration %s phase %d plan drift: recorded digest %s transactional=%t, current digest %s transactional=%t", f.Version, step, *phaseDigest, *transactional, expectedDigest, expected.Transactional)
		}
		applied[step] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read migration phase ledger: %w", err)
	}
	return applied, nil
}

func transactionalBody(statements []string) ([]string, error) {
	if len(statements) == 0 {
		return nil, nil
	}
	first := transactionControl(statements[0])
	last := transactionControl(statements[len(statements)-1])
	if first == "begin" || last == "commit" {
		if first != "begin" || last != "commit" {
			return nil, fmt.Errorf("migration has an unmatched top-level transaction boundary")
		}
		for _, stmt := range statements[1 : len(statements)-1] {
			if control := transactionControl(stmt); control != "" {
				return nil, fmt.Errorf("migration has unsupported nested top-level %s", control)
			}
		}
		return statements[1 : len(statements)-1], nil
	}
	for _, stmt := range statements {
		if control := transactionControl(stmt); control != "" {
			return nil, fmt.Errorf("migration has unsupported top-level %s", control)
		}
	}
	return statements, nil
}

func splitMigrationPhases(statements []string) ([]migrationPhase, error) {
	var phases []migrationPhase
	var outside []string
	flushOutside := func() {
		if len(outside) == 0 {
			return
		}
		phases = append(phases, migrationPhase{Statements: outside})
		outside = nil
	}
	for i := 0; i < len(statements); {
		control := transactionControl(statements[i])
		switch control {
		case "":
			outside = append(outside, statements[i])
			i++
		case "commit", "rollback":
			return nil, fmt.Errorf("migration has unmatched top-level %s", control)
		case "begin":
			flushOutside()
			end := i + 1
			for end < len(statements) && transactionControl(statements[end]) == "" {
				end++
			}
			if end >= len(statements) || transactionControl(statements[end]) != "commit" {
				return nil, fmt.Errorf("migration has an unmatched or nested top-level transaction boundary")
			}
			phases = append(phases, migrationPhase{Transactional: true, Statements: statements[i+1 : end]})
			i = end + 1
		}
	}
	flushOutside()
	return phases, nil
}

func transactionControl(statement string) string {
	clean := strings.TrimSpace(strings.Join(stripSQLComments(statement), "\n"))
	fields := strings.Fields(strings.ToLower(clean))
	if len(fields) == 0 {
		return ""
	}
	keyword := strings.Trim(fields[0], ";")
	switch keyword {
	case "begin":
		return "begin"
	case "commit", "end":
		return "commit"
	case "rollback":
		return "rollback"
	default:
		return ""
	}
}

var concurrentIndexPattern = regexp.MustCompile(`(?is)^\s*create\s+(unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)\s+on\s+(?:only\s+)?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)([\s\S]+)$`)

type concurrentIndexSpec struct {
	Name            string
	Identifier      pgx.Identifier
	Unique          bool
	TableName       string
	TableIdentifier pgx.Identifier
	DefinitionTail  string
}

func parseConcurrentIndex(statement string) (*concurrentIndexSpec, error) {
	clean := strings.TrimSpace(strings.Join(stripSQLComments(statement), "\n"))
	lower := strings.ToLower(clean)
	if !strings.Contains(lower, "index concurrently") || !strings.HasPrefix(strings.TrimSpace(lower), "create") {
		return nil, nil
	}
	match := concurrentIndexPattern.FindStringSubmatch(clean)
	if len(match) != 5 {
		return nil, fmt.Errorf("unsupported CREATE INDEX CONCURRENTLY syntax; use unquoted schema/index/table identifiers")
	}
	return &concurrentIndexSpec{
		Name:            match[2],
		Identifier:      pgx.Identifier(strings.Split(match[2], ".")),
		Unique:          strings.TrimSpace(match[1]) != "",
		TableName:       match[3],
		TableIdentifier: pgx.Identifier(strings.Split(match[3], ".")),
		DefinitionTail:  match[4],
	}, nil
}

func concurrentIndexIdentity(statement string) (string, pgx.Identifier, bool, error) {
	spec, err := parseConcurrentIndex(statement)
	if err != nil {
		return "", nil, false, err
	}
	if spec == nil {
		return "", nil, false, nil
	}
	return spec.Name, spec.Identifier, true, nil
}

// An interrupted concurrent build can leave an invalid same-name pg_index
// shell. CREATE INDEX CONCURRENTLY IF NOT EXISTS would otherwise skip that
// shell and let the phase/version ledger claim success. Remove only an index
// PostgreSQL itself marks not-ready or invalid, then rebuild and attest it.
func dropInvalidConcurrentIndexShell(ctx context.Context, conn *pgx.Conn, spec concurrentIndexSpec) error {
	var valid, ready bool
	err := conn.QueryRow(ctx, `
		SELECT i.indisvalid, i.indisready
		  FROM pg_index i
		 WHERE i.indexrelid = to_regclass($1)
	`, spec.Name).Scan(&valid, &ready)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect concurrent index %s: %w", spec.Name, err)
	}
	if valid && ready {
		return nil
	}
	if _, err := conn.Exec(ctx, "DROP INDEX CONCURRENTLY IF EXISTS "+spec.Identifier.Sanitize()); err != nil {
		return fmt.Errorf("drop invalid concurrent index shell %s: %w", spec.Name, err)
	}
	return nil
}

func verifyConcurrentIndex(ctx context.Context, conn *pgx.Conn, spec concurrentIndexSpec) error {
	var valid, ready, correctTable bool
	err := conn.QueryRow(ctx, `
		SELECT i.indisvalid, i.indisready, i.indrelid = to_regclass($2)
		  FROM pg_index i
		 WHERE i.indexrelid = to_regclass($1)
	`, spec.Name, spec.TableName).Scan(&valid, &ready, &correctTable)
	if err != nil {
		return fmt.Errorf("verify concurrent index %s: %w", spec.Name, err)
	}
	if !valid || !ready || !correctTable {
		return fmt.Errorf("concurrent index %s completed without the required valid, ready target-table state", spec.Name)
	}
	expected, actual, err := concurrentIndexFingerprints(ctx, conn, spec)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("concurrent index %s exists with a valid but wrong definition", spec.Name)
	}
	return nil
}

const concurrentIndexFingerprintSQL = `
	SELECT jsonb_build_object(
		'unique', i.indisunique,
		'nulls_not_distinct', i.indnullsnotdistinct,
		'exclusion', i.indisexclusion,
		'immediate', i.indimmediate,
		'access_method', am.amname,
		'key_count', i.indnkeyatts,
		'total_count', i.indnatts,
		'columns', (
			SELECT jsonb_agg(pg_get_indexdef(i.indexrelid, position, true) ORDER BY position)
			  FROM generate_series(1, i.indnatts) AS position
		),
		'predicate', COALESCE(pg_get_expr(i.indpred, i.indrelid, true), ''),
		'options', COALESCE(to_jsonb(index_relation.reloptions), '[]'::jsonb)
	)::text
	  FROM pg_index i
	  JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
	  JOIN pg_am am ON am.oid = index_relation.relam
	 WHERE i.indexrelid = to_regclass($1)
`

// Build the desired definition on an empty transaction-local LIKE table and
// compare PostgreSQL's own catalog-normalized structural fingerprint. This
// attests uniqueness (including NULLS NOT DISTINCT semantics), target
// expressions/columns/order/opclasses, INCLUDE columns, predicate, access
// method, and reloptions without scanning customer data or trying to normalize
// SQL text in application code.
func concurrentIndexFingerprints(ctx context.Context, conn *pgx.Conn, spec concurrentIndexSpec) (expected, actual string, err error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer rollbackMigrationTx(tx)
	suffix := fmt.Sprintf("%x", time.Now().UnixNano())
	shadowTable := "migration_index_attest_table_" + suffix
	shadowIndex := "migration_index_attest_idx_" + suffix
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		"CREATE TEMP TABLE %s (LIKE %s INCLUDING ALL EXCLUDING INDEXES) ON COMMIT DROP",
		pgx.Identifier{shadowTable}.Sanitize(), spec.TableIdentifier.Sanitize(),
	)); err != nil {
		return "", "", fmt.Errorf("prepare concurrent index %s attestation table: %w", spec.Name, err)
	}
	unique := ""
	if spec.Unique {
		unique = "UNIQUE "
	}
	shadowSQL := fmt.Sprintf("CREATE %sINDEX %s ON %s%s",
		unique,
		pgx.Identifier{shadowIndex}.Sanitize(),
		pgx.Identifier{shadowTable}.Sanitize(),
		spec.DefinitionTail,
	)
	if _, err := tx.Exec(ctx, shadowSQL); err != nil {
		return "", "", fmt.Errorf("build concurrent index %s attestation definition: %w", spec.Name, err)
	}
	if err := tx.QueryRow(ctx, concurrentIndexFingerprintSQL, shadowIndex).Scan(&expected); err != nil {
		return "", "", fmt.Errorf("read expected concurrent index %s fingerprint: %w", spec.Name, err)
	}
	if err := tx.QueryRow(ctx, concurrentIndexFingerprintSQL, spec.Name).Scan(&actual); err != nil {
		return "", "", fmt.Errorf("read actual concurrent index %s fingerprint: %w", spec.Name, err)
	}
	return expected, actual, nil
}

const phasedExecutionDirective = "migration-execution: phased"

func requiresStatementExecution(sql string) bool {
	lower := strings.ToLower(sql)
	return strings.Contains(lower, "index concurrently") ||
		strings.Contains(lower, phasedExecutionDirective)
}

func splitSQLStatements(sql string) []string {
	var out []string
	var b strings.Builder
	var dollarTag string
	inSingle := false
	inDouble := false
	inLineComment := false
	inBlockComment := false

	flush := func() {
		stmt := strings.TrimSpace(b.String())
		withoutComments := strings.TrimSpace(strings.Join(stripSQLComments(stmt), "\n"))
		if stmt != "" && withoutComments != "" {
			out = append(out, stmt)
		}
		b.Reset()
	}

	for i := 0; i < len(sql); i++ {
		ch := sql[i]
		next := byte(0)
		if i+1 < len(sql) {
			next = sql[i+1]
		}

		if inLineComment {
			b.WriteByte(ch)
			if ch == '\n' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			b.WriteByte(ch)
			if ch == '*' && next == '/' {
				b.WriteByte(next)
				i++
				inBlockComment = false
			}
			continue
		}
		if dollarTag != "" {
			if strings.HasPrefix(sql[i:], dollarTag) {
				b.WriteString(dollarTag)
				i += len(dollarTag) - 1
				dollarTag = ""
				continue
			}
			b.WriteByte(ch)
			continue
		}
		if inSingle {
			b.WriteByte(ch)
			if ch == '\'' {
				if next == '\'' {
					b.WriteByte(next)
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			b.WriteByte(ch)
			if ch == '"' {
				inDouble = false
			}
			continue
		}

		switch {
		case ch == '-' && next == '-':
			b.WriteByte(ch)
			b.WriteByte(next)
			i++
			inLineComment = true
		case ch == '/' && next == '*':
			b.WriteByte(ch)
			b.WriteByte(next)
			i++
			inBlockComment = true
		case ch == '\'':
			b.WriteByte(ch)
			inSingle = true
		case ch == '"':
			b.WriteByte(ch)
			inDouble = true
		case ch == '$':
			if tag, ok := readDollarTag(sql[i:]); ok {
				b.WriteString(tag)
				i += len(tag) - 1
				dollarTag = tag
			} else {
				b.WriteByte(ch)
			}
		case ch == ';':
			b.WriteByte(ch)
			flush()
		default:
			b.WriteByte(ch)
		}
	}
	flush()
	return out
}

func readDollarTag(s string) (string, bool) {
	if len(s) < 2 || s[0] != '$' {
		return "", false
	}
	for i := 1; i < len(s); i++ {
		ch := s[i]
		if ch == '$' {
			return s[:i+1], true
		}
		switch {
		case ch == '_', ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		default:
			return "", false
		}
	}
	return "", false
}
