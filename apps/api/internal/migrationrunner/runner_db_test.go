package migrationrunner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestApplyOneAtomicallyCommitsTransactionalBodyAndVersion(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// t.Cleanup, not defer: the schema-drop cleanup below runs on this
	// connection, and Go runs a test's defers before its t.Cleanup callbacks.
	// A deferred Close made that cleanup run on a closed connection, so the
	// DROP SCHEMA failed silently and every run leaked its schema into the
	// shared database. Registered first, Close runs after the drop.
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := "migrationrunner_atomic_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+quotedSchema+", public"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT reject_atomic_probe CHECK (version <> 'atomic_probe') NOT VALID
		);
		CREATE TABLE schema_migration_steps (
			version text NOT NULL,
			step integer NOT NULL,
			checksum text NOT NULL,
			phase_digest text NOT NULL,
			transactional boolean NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (version, step)
		);
	`); err != nil {
		t.Fatal(err)
	}

	file := MigrationFile{
		Version:  "atomic_probe",
		Checksum: strings.Repeat("a", 64),
		SQL: `
			-- one runner-owned atomic envelope
			BEGIN;
			CREATE TABLE atomic_body (id bigint PRIMARY KEY);
			COMMIT;
		`,
	}
	if err := applyOne(ctx, conn, file); err == nil || !strings.Contains(err.Error(), "record version") {
		t.Fatalf("applyOne error = %v, want version-record rejection", err)
	}
	var relation *string
	if err := conn.QueryRow(ctx, `SELECT to_regclass($1)::text`, schema+".atomic_body").Scan(&relation); err != nil {
		t.Fatal(err)
	}
	if relation != nil {
		t.Fatalf("transaction body survived failed version record as %q", *relation)
	}
	var versions int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, file.Version).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 0 {
		t.Fatalf("version rows = %d, want 0", versions)
	}
	if err := conn.Ping(ctx); err != nil {
		t.Fatalf("connection unusable after atomic rollback: %v", err)
	}

	if _, err := conn.Exec(ctx, `ALTER TABLE schema_migrations DROP CONSTRAINT reject_atomic_probe`); err != nil {
		t.Fatal(err)
	}
	if err := applyOne(ctx, conn, file); err != nil {
		t.Fatalf("retry atomic migration: %v", err)
	}
	if err := conn.QueryRow(ctx, `SELECT to_regclass($1)::text`, schema+".atomic_body").Scan(&relation); err != nil {
		t.Fatal(err)
	}
	if relation == nil {
		t.Fatal("transaction body was not committed with the version row")
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1 AND checksum = $2`, file.Version, file.Checksum).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 1 {
		t.Fatalf("exact version rows = %d, want 1", versions)
	}
}

func TestRunAcquiresAdvisoryLockBeforePlanningOrSchemaMutation(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	schema := "migrationrunner_lock_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})
	lockConn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockConn.Close(context.Background()) }()
	if _, err := lockConn.Exec(ctx, `SELECT pg_advisory_lock($1)`, AdvisoryLockKey); err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			_, _ = lockConn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, AdvisoryLockKey)
		}
	}()

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err = Run(ctx, pool, nil, logger)
	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("Run error = %v, want ErrLockHeld", err)
	}
	var metadataTable *string
	if err := admin.QueryRow(ctx, `SELECT to_regclass($1)::text`, schema+".schema_migrations").Scan(&metadataTable); err != nil {
		t.Fatal(err)
	}
	if metadataTable != nil {
		t.Fatalf("runner planned/mutated before acquiring lock: %q", *metadataTable)
	}
	if _, err := lockConn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, AdvisoryLockKey); err != nil {
		t.Fatal(err)
	}
	locked = false
	if err := Run(ctx, pool, nil, logger); err != nil {
		t.Fatalf("Run after lock release: %v", err)
	}
	if err := admin.QueryRow(ctx, `SELECT to_regclass($1)::text`, schema+".schema_migrations").Scan(&metadataTable); err != nil {
		t.Fatal(err)
	}
	if metadataTable == nil {
		t.Fatal("locked plan did not initialize migration metadata after lock release")
	}
}

func TestComputePlanIsReadOnlyForFreshAndLegacyLedgers(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	schema := "migrationrunner_plan_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	file := MigrationFile{
		Version:  "0001_plan_probe",
		Checksum: strings.Repeat("d", 64),
		SQL:      `CREATE TABLE plan_probe (id bigint PRIMARY KEY);`,
	}

	plan, err := ComputePlan(ctx, pool, []MigrationFile{file})
	if err != nil {
		t.Fatalf("fresh ComputePlan: %v", err)
	}
	if len(plan.Applied) != 0 || len(plan.Pending) != 1 {
		t.Fatalf("fresh plan applied=%d pending=%d, want 0/1", len(plan.Applied), len(plan.Pending))
	}
	var versionsTable, stepsTable *string
	if err := admin.QueryRow(ctx, `SELECT to_regclass($1)::text, to_regclass($2)::text`,
		schema+".schema_migrations", schema+".schema_migration_steps").Scan(&versionsTable, &stepsTable); err != nil {
		t.Fatal(err)
	}
	if versionsTable != nil || stepsTable != nil {
		t.Fatalf("fresh dry-run mutated metadata: versions=%v steps=%v", versionsTable, stepsTable)
	}

	if _, err := admin.Exec(ctx, `CREATE TABLE `+quotedSchema+`.schema_migrations (version text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO `+quotedSchema+`.schema_migrations (version) VALUES ($1)`, file.Version); err != nil {
		t.Fatal(err)
	}
	plan, err = ComputePlan(ctx, pool, []MigrationFile{file})
	if err != nil {
		t.Fatalf("legacy ComputePlan: %v", err)
	}
	if len(plan.Applied) != 1 || plan.Applied[0].Checksum != "" || len(plan.Pending) != 0 {
		t.Fatalf("legacy plan = %+v, pending=%d", plan.Applied, len(plan.Pending))
	}
	var columnCount int
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = 'schema_migrations'
	`, schema).Scan(&columnCount); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT to_regclass($1)::text`, schema+".schema_migration_steps").Scan(&stepsTable); err != nil {
		t.Fatal(err)
	}
	if columnCount != 1 || stepsTable != nil {
		t.Fatalf("legacy dry-run upgraded metadata: columns=%d steps=%v", columnCount, stepsTable)
	}
}

func TestRunDiscardsConnectionWhenAdvisoryUnlockCannotConfirmRelease(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	schema := "migrationrunner_unlock_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	file := MigrationFile{
		Version:  "unlock_loss_probe",
		Checksum: strings.Repeat("c", 64),
		SQL: fmt.Sprintf(`
			CREATE TABLE unlock_loss_probe (runner_backend_pid integer NOT NULL);
			INSERT INTO unlock_loss_probe (runner_backend_pid) VALUES (pg_backend_pid());
			SELECT pg_advisory_unlock(%d);
		`, AdvisoryLockKey),
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Run(ctx, pool, []MigrationFile{file}, logger); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var runnerPID, currentPID int
	if err := pool.QueryRow(ctx, `
		SELECT runner_backend_pid, pg_backend_pid()
		  FROM unlock_loss_probe
	`).Scan(&runnerPID, &currentPID); err != nil {
		t.Fatal(err)
	}
	if currentPID == runnerPID {
		t.Fatalf("runner returned uncertain advisory-lock session %d to the pool", currentPID)
	}
}

func TestPhaseLedgerFailsClosedAndResumesOnlyExactMarkers(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := "migrationrunner_phase_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+quotedSchema+", public"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migration_steps (
			version text NOT NULL,
			step integer NOT NULL,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (version, step)
		)
	`); err != nil {
		t.Fatal(err)
	}

	guardFile := MigrationFile{
		Version:  "phase_guard_probe",
		Checksum: strings.Repeat("e", 64),
		SQL: `
			BEGIN;
			CREATE TABLE phase_guard_probe (id integer PRIMARY KEY);
			COMMIT;
			CREATE INDEX CONCURRENTLY phase_guard_probe_idx ON phase_guard_probe (id);
		`,
	}
	guardPhases, err := splitMigrationPhases(splitSQLStatements(guardFile.SQL))
	if err != nil {
		t.Fatal(err)
	}
	if len(guardPhases) != 2 {
		t.Fatalf("guard phase count = %d, want 2", len(guardPhases))
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum)
		VALUES ($1, 0, $2)
	`, guardFile.Version, guardFile.Checksum); err != nil {
		t.Fatal(err)
	}
	if err := ensureSchema(ctx, conn); err != nil {
		t.Fatal(err)
	}
	var phaseDigestNullable, transactionalNullable string
	if err := conn.QueryRow(ctx, `
		SELECT
			(SELECT is_nullable FROM information_schema.columns
			  WHERE table_schema = $1 AND table_name = 'schema_migration_steps' AND column_name = 'phase_digest'),
			(SELECT is_nullable FROM information_schema.columns
			  WHERE table_schema = $1 AND table_name = 'schema_migration_steps' AND column_name = 'transactional')
	`, schema).Scan(&phaseDigestNullable, &transactionalNullable); err != nil {
		t.Fatal(err)
	}
	if phaseDigestNullable != "YES" || transactionalNullable != "YES" {
		t.Fatalf("legacy phase columns nullable=%q/%q, want YES/YES", phaseDigestNullable, transactionalNullable)
	}
	assertGuardBlocked := func(want string) {
		t.Helper()
		err := applyOne(ctx, conn, guardFile)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("applyOne error = %v, want %q", err, want)
		}
		var relation *string
		if err := conn.QueryRow(ctx, `SELECT to_regclass('phase_guard_probe')::text`).Scan(&relation); err != nil {
			t.Fatal(err)
		}
		if relation != nil {
			t.Fatalf("phase ledger validation executed side effect %q", *relation)
		}
		var versions int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, guardFile.Version).Scan(&versions); err != nil {
			t.Fatal(err)
		}
		if versions != 0 {
			t.Fatalf("phase ledger validation recorded %d versions", versions)
		}
	}
	assertGuardBlocked("legacy phase marker")

	if _, err := conn.Exec(ctx, `DELETE FROM schema_migration_steps WHERE version = $1`, guardFile.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum, phase_digest, transactional)
		VALUES ($1, 99, $2, $3, true)
	`, guardFile.Version, guardFile.Checksum, migrationPhaseDigest(guardPhases[0])); err != nil {
		t.Fatal(err)
	}
	assertGuardBlocked("out-of-range step")

	if _, err := conn.Exec(ctx, `DELETE FROM schema_migration_steps WHERE version = $1`, guardFile.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum, phase_digest, transactional)
		VALUES ($1, 0, $2, $3, true)
	`, guardFile.Version, guardFile.Checksum, strings.Repeat("f", 64)); err != nil {
		t.Fatal(err)
	}
	assertGuardBlocked("plan drift")

	if _, err := conn.Exec(ctx, `DELETE FROM schema_migration_steps WHERE version = $1`, guardFile.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum, phase_digest, transactional)
		VALUES ($1, 0, $2, $3, false)
	`, guardFile.Version, guardFile.Checksum, migrationPhaseDigest(guardPhases[0])); err != nil {
		t.Fatal(err)
	}
	assertGuardBlocked("plan drift")

	if _, err := conn.Exec(ctx, `DELETE FROM schema_migration_steps WHERE version = $1`, guardFile.Version); err != nil {
		t.Fatal(err)
	}
	resumeFile := MigrationFile{
		Version:  "phase_resume_probe",
		Checksum: strings.Repeat("1", 64),
		SQL: `
			BEGIN;
			CREATE TABLE phase_resume_probe (id integer PRIMARY KEY);
			INSERT INTO phase_resume_probe (id) VALUES (1);
			COMMIT;
			CREATE INDEX CONCURRENTLY phase_resume_probe_idx ON phase_resume_probe (id);
		`,
	}
	resumePhases, err := splitMigrationPhases(splitSQLStatements(resumeFile.SQL))
	if err != nil {
		t.Fatal(err)
	}
	if len(resumePhases) != 2 || !resumePhases[0].Transactional || resumePhases[1].Transactional {
		t.Fatalf("resume phases = %#v", resumePhases)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE phase_resume_probe (id integer PRIMARY KEY);
		INSERT INTO phase_resume_probe (id) VALUES (1);
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO schema_migration_steps (version, step, checksum, phase_digest, transactional)
		VALUES ($1, 0, $2, $3, $4)
	`, resumeFile.Version, resumeFile.Checksum, migrationPhaseDigest(resumePhases[0]), resumePhases[0].Transactional); err != nil {
		t.Fatal(err)
	}
	if err := applyOne(ctx, conn, resumeFile); err != nil {
		t.Fatalf("resume exact marker: %v", err)
	}
	var rowCount, versions, markers int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM phase_resume_probe`).Scan(&rowCount); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, resumeFile.Version).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version = $1`, resumeFile.Version).Scan(&markers); err != nil {
		t.Fatal(err)
	}
	var valid, ready bool
	if err := conn.QueryRow(ctx, `
		SELECT indisvalid, indisready FROM pg_index
		 WHERE indexrelid = to_regclass('phase_resume_probe_idx')
	`).Scan(&valid, &ready); err != nil {
		t.Fatal(err)
	}
	if rowCount != 1 || versions != 1 || markers != 0 || !valid || !ready {
		t.Fatalf("resume result rows=%d versions=%d markers=%d valid=%v ready=%v", rowCount, versions, markers, valid, ready)
	}
}

func TestApplyOneRepairsInvalidConcurrentIndexShellBeforeRecordingVersion(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := "migrationrunner_index_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+quotedSchema+", public"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE TABLE schema_migration_steps (
			version text NOT NULL,
			step integer NOT NULL,
			checksum text NOT NULL,
			phase_digest text NOT NULL,
			transactional boolean NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (version, step)
		);
		CREATE TABLE index_body (value integer NOT NULL);
		INSERT INTO index_body (value) VALUES (7), (7);
	`); err != nil {
		t.Fatal(err)
	}
	file := MigrationFile{
		Version:  "index_repair_probe",
		Checksum: strings.Repeat("b", 64),
		SQL:      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS index_body_value_uniq ON index_body (value);`,
	}
	if err := applyOne(ctx, conn, file); err == nil {
		t.Fatal("duplicate-data concurrent build unexpectedly succeeded")
	}
	var valid, ready bool
	if err := conn.QueryRow(ctx, `
		SELECT indisvalid, indisready FROM pg_index
		 WHERE indexrelid = to_regclass('index_body_value_uniq')
	`).Scan(&valid, &ready); err != nil {
		t.Fatalf("invalid shell was not retained by PostgreSQL as expected: %v", err)
	}
	if valid && ready {
		t.Fatal("failed concurrent build unexpectedly produced a valid index")
	}
	if _, err := conn.Exec(ctx, `DELETE FROM index_body WHERE ctid IN (SELECT ctid FROM index_body LIMIT 1)`); err != nil {
		t.Fatal(err)
	}
	if err := applyOne(ctx, conn, file); err != nil {
		t.Fatalf("retry after invalid shell: %v", err)
	}
	if err := conn.QueryRow(ctx, `
		SELECT indisvalid, indisready FROM pg_index
		 WHERE indexrelid = to_regclass('index_body_value_uniq')
	`).Scan(&valid, &ready); err != nil {
		t.Fatal(err)
	}
	if !valid || !ready {
		t.Fatalf("repaired concurrent index valid=%v ready=%v", valid, ready)
	}
	var versions, phases int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, file.Version).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version = $1`, file.Version).Scan(&phases); err != nil {
		t.Fatal(err)
	}
	if versions != 1 || phases != 0 {
		t.Fatalf("version rows=%d phase rows=%d, want 1/0", versions, phases)
	}

	if _, err := conn.Exec(ctx, `
		DELETE FROM schema_migrations WHERE version = 'index_repair_probe';
		DROP INDEX index_body_value_uniq;
		CREATE INDEX index_body_value_uniq ON index_body (value);
	`); err != nil {
		t.Fatal(err)
	}
	if err := applyOne(ctx, conn, file); err == nil || !strings.Contains(err.Error(), "valid but wrong definition") {
		t.Fatalf("wrong valid same-name index error = %v", err)
	}
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, file.Version).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 0 {
		t.Fatalf("wrong same-name index recorded migration version: %d", versions)
	}
	var unique bool
	if err := conn.QueryRow(ctx, `
		SELECT indisunique FROM pg_index
		 WHERE indexrelid = to_regclass('index_body_value_uniq')
	`).Scan(&unique); err != nil {
		t.Fatal(err)
	}
	if unique {
		t.Fatal("test precondition lost: wrong same-name index unexpectedly became unique")
	}
}

func TestApplyOneRejectsSameNameConcurrentIndexWithWrongNullDistinctness(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := "migrationrunner_nulls_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE"); dropErr != nil {
			t.Errorf("drop test schema %s: %v", schema, dropErr)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+quotedSchema+", public"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE TABLE schema_migration_steps (
			version text NOT NULL,
			step integer NOT NULL,
			checksum text NOT NULL,
			phase_digest text NOT NULL,
			transactional boolean NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (version, step)
		);
		CREATE TABLE index_null_body (value integer);
		CREATE UNIQUE INDEX index_null_semantics ON index_null_body (value);
	`); err != nil {
		t.Fatal(err)
	}

	var actualNullsNotDistinct bool
	if err := conn.QueryRow(ctx, `
		SELECT indnullsnotdistinct
		  FROM pg_index
		 WHERE indexrelid = to_regclass('index_null_semantics')`).Scan(&actualNullsNotDistinct); err != nil {
		t.Fatal(err)
	}
	if actualNullsNotDistinct {
		t.Fatal("test precondition lost: existing index unexpectedly uses NULLS NOT DISTINCT")
	}

	file := MigrationFile{
		Version:  "index_null_semantics_probe",
		Checksum: strings.Repeat("c", 64),
		SQL: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS index_null_semantics
		      ON index_null_body (value) NULLS NOT DISTINCT;`,
	}
	err = applyOne(ctx, conn, file)
	if err == nil || !strings.Contains(err.Error(), "valid but wrong definition") {
		t.Fatalf("opposite NULLS NOT DISTINCT semantics error = %v", err)
	}

	var versions int
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM schema_migrations WHERE version = $1`, file.Version).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 0 {
		t.Fatalf("wrong null-distinct index recorded migration version: %d", versions)
	}
	if err := conn.QueryRow(ctx, `
		SELECT indnullsnotdistinct
		  FROM pg_index
		 WHERE indexrelid = to_regclass('index_null_semantics')`).Scan(&actualNullsNotDistinct); err != nil {
		t.Fatal(err)
	}
	if actualNullsNotDistinct {
		t.Fatal("attestation mutated the existing wrong index")
	}
}
