// SPDX-License-Identifier: AGPL-3.0-only

package ai_regression

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func durableLifecycleMigrationFile(t *testing.T) migrationrunner.MigrationFile {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve lifecycle upgrade test source")
	}
	migrationsDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations"))
	const version = "1918_ai_regression_durable_lifecycle"
	name := version + ".sql"
	sql, err := os.ReadFile(filepath.Join(migrationsDir, name))
	if err != nil {
		t.Fatalf("read lifecycle migration: %v", err)
	}
	// This database was freshly built from the canonical pre-1918 files. No
	// historical checksum substitutions are involved in this one-file upgrade.
	// Load the exact, unchanged SQL through the real loader without depending on
	// the unrelated release-wide supersession ledger's review deadline.
	isolatedDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(isolatedDir, name), sql, 0o600); err != nil {
		t.Fatalf("stage lifecycle migration: %v", err)
	}
	files, err := migrationrunner.LoadFiles(isolatedDir)
	if err != nil {
		t.Fatalf("load migration files: %v", err)
	}
	for _, file := range files {
		if file.Version == version {
			return file
		}
	}
	t.Fatal("migration 1918 was not found")
	return migrationrunner.MigrationFile{}
}

// TestDurableLifecycleUpgrade_DB must receive a disposable database with
// migrations 0001-1917 applied and 1918 absent. It proves the exact runner
// upgrade preserves repeated historical evidence while retiring a pending run
// that never had an immutable example manifest.
func TestDurableLifecycleUpgrade_DB(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_PRE1918_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_PRE1918_ADMIN_DATABASE_URL is required for the 1917-to-1918 upgrade proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect pre-1918 database: %v", err)
	}
	t.Cleanup(pool.Close)

	var alreadyApplied bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ai_regression_results'
       AND column_name = 'durable_receipt'
)`).Scan(&alreadyApplied); err != nil {
		t.Fatalf("inspect pre-upgrade schema: %v", err)
	}
	if alreadyApplied {
		t.Fatal("upgrade proof requires a disposable database stopped at migration 1917")
	}

	tenantID := uuid.NewString()
	goldenID := uuid.NewString()
	legacyRunID := uuid.NewString()
	pendingRunID := uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:16]
	if _, err := pool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')`,
		tenantID, "AI regression upgrade "+suffix, "ai-regression-upgrade-"+suffix); err != nil {
		t.Fatalf("seed upgrade tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	if _, err := pool.Exec(ctx, `
INSERT INTO ai_golden_examples (
    id, tenant_id, surface_kind, brief, approved_output, model_id
)
VALUES (
    $1::uuid, $2::uuid, 'campaign_draft',
    'Legacy approved brief', 'Legacy approved output', 'legacy-source-model'
)`, goldenID, tenantID); err != nil {
		t.Fatalf("seed legacy golden example: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO ai_regression_runs (
    id, tenant_id, model_id, model_version_tag, prompt_version_tag, status,
    total_examples, passed_examples, fidelity_score_mean,
    fidelity_score_p25, gate_result, warn_threshold, started_at, completed_at
)
VALUES (
    $1::uuid, $2::uuid, 'legacy-runtime', 'legacy-release', 'legacy-prompt',
    'completed', 1, 1, 80, 70, 'pass', 60, now(), now()
)`, legacyRunID, tenantID); err != nil {
		t.Fatalf("seed legacy completed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO ai_regression_runs (
    id, tenant_id, model_id, model_version_tag, prompt_version_tag,
    status, total_examples, warn_threshold
)
VALUES (
    $1::uuid, $2::uuid, 'legacy-runtime', 'legacy-pending', 'legacy-prompt',
    'pending', 1, 60
)`, pendingRunID, tenantID); err != nil {
		t.Fatalf("seed legacy pending run: %v", err)
	}
	legacyResultIDs := []string{uuid.NewString(), uuid.NewString()}
	legacyScoredAt := []time.Time{
		time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC),
		time.Date(2026, time.January, 2, 3, 4, 6, 0, time.UTC),
	}
	for index, score := range []float64{70, 80} {
		if _, err := pool.Exec(ctx, `
INSERT INTO ai_regression_results (
    id, tenant_id, run_id, example_id, surface_kind, replayed_output,
    fidelity_score, breakdown, severity, scored_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'campaign_draft', $5, $6,
    jsonb_build_object(
        'embedding_similarity', 0.9,
        'stylistic_distance', 0.2,
        'vocabulary_overlap', 0.8,
        'structural_match', 0.85,
        'combined', $6::float8
    ),
	'ok', $7
)`, legacyResultIDs[index], tenantID, legacyRunID, goldenID,
			"legacy replay "+string(rune('A'+index)), score, legacyScoredAt[index]); err != nil {
			t.Fatalf("seed repeated legacy receipt %d: %v", index, err)
		}
	}

	migration := durableLifecycleMigrationFile(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrationrunner.Run(ctx, pool, []migrationrunner.MigrationFile{migration}, logger); err != nil {
		t.Fatalf("apply migration 1918 through the production runner: %v", err)
	}

	var total, legacy, managed, attempts int
	if err := pool.QueryRow(ctx, `
SELECT count(*)::integer,
       count(*) FILTER (WHERE NOT durable_receipt)::integer,
       count(*) FILTER (WHERE durable_receipt)::integer,
       count(DISTINCT attempt_count)::integer
  FROM ai_regression_results
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid`, tenantID, legacyRunID).Scan(
		&total, &legacy, &managed, &attempts,
	); err != nil {
		t.Fatalf("inspect preserved legacy receipts: %v", err)
	}
	if total != 2 || legacy != 2 || managed != 0 || attempts != 1 {
		t.Fatalf("preserved receipts total=%d legacy=%d managed=%d attempts=%d, want 2/2/0/1",
			total, legacy, managed, attempts)
	}
	rows, err := pool.Query(ctx, `
SELECT id::text, replayed_output, fidelity_score, scored_at
  FROM ai_regression_results
 WHERE tenant_id = $1::uuid
	   AND run_id = $2::uuid
 ORDER BY scored_at, id`, tenantID, legacyRunID)
	if err != nil {
		t.Fatalf("inspect preserved receipt payloads: %v", err)
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var id, output string
		var score float64
		var scoredAt time.Time
		if err := rows.Scan(&id, &output, &score, &scoredAt); err != nil {
			t.Fatalf("scan preserved receipt %d: %v", index, err)
		}
		if index >= len(legacyResultIDs) || id != legacyResultIDs[index] ||
			output != "legacy replay "+string(rune('A'+index)) ||
			score != []float64{70, 80}[index] || !scoredAt.Equal(legacyScoredAt[index]) {
			t.Fatalf("legacy receipt %d changed: id=%s output=%q score=%v scored_at=%s",
				index, id, output, score, scoredAt.Format(time.RFC3339Nano))
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate preserved receipt payloads: %v", err)
	}
	if index != len(legacyResultIDs) {
		t.Fatalf("preserved receipt payload count = %d, want %d", index, len(legacyResultIDs))
	}

	var pendingStatus, pendingCode string
	var snapshotMissing, completionRecorded bool
	if err := pool.QueryRow(ctx, `
SELECT status,
       COALESCE(error_code, ''),
       snapshot_frozen_at IS NULL,
       completed_at IS NOT NULL
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, pendingRunID).Scan(
		&pendingStatus, &pendingCode, &snapshotMissing, &completionRecorded,
	); err != nil {
		t.Fatalf("inspect retired pending run: %v", err)
	}
	if pendingStatus != RunStatusFailed || pendingCode != "unsnapshotted_legacy_run" ||
		!snapshotMissing || !completionRecorded {
		t.Fatalf("retired pending state=%s code=%s snapshot_missing=%v completed=%v",
			pendingStatus, pendingCode, snapshotMissing, completionRecorded)
	}

	var indexPredicate string
	var indexUnique, indexValid, indexReady bool
	if err := pool.QueryRow(ctx, `
SELECT pg_get_expr(index.indpred, index.indrelid),
       index.indisunique,
       index.indisvalid,
       index.indisready
  FROM pg_index AS index
 WHERE index.indexrelid = 'ai_regression_results_tenant_run_attempt_example_uidx'::regclass
`).Scan(&indexPredicate, &indexUnique, &indexValid, &indexReady); err != nil {
		t.Fatalf("inspect lifecycle receipt index: %v", err)
	}
	if !strings.Contains(indexPredicate, "durable_receipt") ||
		!strings.Contains(indexPredicate, "example_id IS NOT NULL") ||
		!indexUnique || !indexValid || !indexReady {
		t.Fatalf("unexpected lifecycle receipt index predicate=%q unique=%v valid=%v ready=%v",
			indexPredicate, indexUnique, indexValid, indexReady)
	}
}
