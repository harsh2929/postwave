// SPDX-License-Identifier: AGPL-3.0-only

package ai_regression

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNormalizeRunIdentityRequiresCompleteServerAttestation(t *testing.T) {
	t.Parallel()
	valid := TriggerRunInput{
		RuntimeProvider:  " google ",
		ModelID:          " gemini-test ",
		ModelVersionTag:  " release-42 ",
		PromptVersionTag: " replay-policy-v2 ",
	}
	provider, modelID, modelVersion, promptPolicy, err := normalizeRunIdentity(valid)
	if err != nil || provider != "google" || modelID != "gemini-test" ||
		modelVersion != "release-42" || promptPolicy != "replay-policy-v2" {
		t.Fatalf("valid identity normalized incorrectly: provider=%q model=%q version=%q prompt=%q err=%v",
			provider, modelID, modelVersion, promptPolicy, err)
	}
	tests := []struct {
		name   string
		mutate func(*TriggerRunInput)
	}{
		{"missing provider", func(input *TriggerRunInput) { input.RuntimeProvider = "" }},
		{"whitespace provider", func(input *TriggerRunInput) { input.RuntimeProvider = "  " }},
		{"missing model", func(input *TriggerRunInput) { input.ModelID = "" }},
		{"missing model version", func(input *TriggerRunInput) { input.ModelVersionTag = "" }},
		{"missing prompt policy", func(input *TriggerRunInput) { input.PromptVersionTag = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			test.mutate(&input)
			if _, _, _, _, err := normalizeRunIdentity(input); err == nil {
				t.Fatal("incomplete runtime identity was accepted")
			}
		})
	}
}

func TestSurfaceResultEmitsExplicitNullMeanWhenUnscored(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(SurfaceResult{
		Total:      1,
		Errors:     1,
		GateResult: GateAdvisory,
	})
	if err != nil {
		t.Fatalf("marshal unscored surface result: %v", err)
	}
	if !strings.Contains(string(payload), `"mean_score":null`) {
		t.Fatalf("unscored surface omitted explicit mean_score null: %s", payload)
	}
}

// TestDurableLifecycleMigrationContract keeps the database-enforced safety
// boundary visible in ordinary unit CI, including jobs without PostgreSQL.
func TestDurableLifecycleMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve lifecycle contract test source")
	}
	migrationPath := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1918_ai_regression_durable_lifecycle.sql",
	))
	contents, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read durable lifecycle migration: %v", err)
	}
	sql := string(contents)
	required := []string{
		"ai_regression_runs_one_active_tenant_idx",
		"ai_golden_examples_evidence_immutable",
		"ai golden example evidence is immutable",
		"REVOKE UPDATE, DELETE ON ai_golden_examples FROM postwave_app",
		"GRANT UPDATE (archived_at) ON ai_golden_examples TO postwave_app",
		"WHERE status IN ('pending', 'running')",
		"CREATE TABLE IF NOT EXISTS ai_regression_run_examples",
		"PRIMARY KEY (tenant_id, run_id, example_id)",
		"ai_regression_run_examples_immutable",
		"ai_regression_runs_lifecycle_guard",
		"claim_token uuid",
		"lease_expires_at timestamptz",
		"heartbeat_at timestamptz",
		"retry_not_before timestamptz",
		"max_attempts integer NOT NULL DEFAULT 3",
		"WHEN status IN ('running', 'completed', 'failed') AND attempt_count = 0 THEN 1",
		"ai_regression_results_tenant_run_attempt_example_uidx",
		"ON ai_regression_results (tenant_id, run_id, attempt_count, example_id)",
		"ADD COLUMN IF NOT EXISTS durable_receipt boolean",
		"SET durable_receipt = false",
		"ALTER COLUMN durable_receipt SET DEFAULT true",
		"WHERE example_id IS NOT NULL AND durable_receipt",
		"NEW.durable_receipt IS NOT TRUE",
		"JOIN public.ai_regression_run_examples AS examples",
		"snapshot_surface <> NEW.surface_kind",
		"ai_regression_results_immutable",
		"ai_regression_results_receipt_shape_check",
		"NOT durable_receipt OR (",
		") IS TRUE",
		"ai_regression_results_snapshot_example_fk",
		"scored_examples integer NOT NULL DEFAULT 0",
		"error_examples integer NOT NULL DEFAULT 0",
		"legacy_failure_details_withheld",
		"unsnapshotted_legacy_run",
		"ALTER TABLE ai_regression_run_examples FORCE ROW LEVEL SECURITY",
		"ai_regression_runs_worker_update",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration is missing durable contract fragment %q", fragment)
		}
	}
	legacyRetirement := strings.Index(sql, "error_code = 'unsnapshotted_legacy_run'")
	activeIndex := strings.Index(sql, "CREATE UNIQUE INDEX IF NOT EXISTS ai_regression_runs_one_active_tenant_idx")
	if legacyRetirement < 0 || activeIndex < 0 || legacyRetirement > activeIndex {
		t.Error("unsnapshotted legacy pending rows must be retired before the one-active-run index is installed")
	}
	if strings.Contains(sql, "snapshot_frozen_at = COALESCE(snapshot_frozen_at, created_at)") {
		t.Error("migration must not fabricate a frozen-snapshot timestamp for legacy rows without an immutable manifest")
	}
	if strings.Contains(strings.ToUpper(sql), "DELETE FROM AI_REGRESSION_RESULTS") {
		t.Error("migration must preserve every historical result receipt instead of deleting duplicate evidence")
	}
}

func validStoreBreakdown(score float64) map[string]any {
	return map[string]any{
		"embedding_similarity": 0.9,
		"stylistic_distance":   0.2,
		"vocabulary_overlap":   0.8,
		"structural_match":     0.85,
		"combined":             score,
	}
}

func TestNormalizeResultInputRejectsNonFiniteAndOpenBreakdowns(t *testing.T) {
	t.Parallel()
	const exampleID = "00000000-0000-4000-8000-000000000001"
	validScore := 80.0
	valid := UpsertRegressionResultInput{
		ExampleID:     exampleID,
		FidelityScore: &validScore,
		Breakdown:     validStoreBreakdown(validScore),
		Severity:      "ok",
	}
	if _, _, err := normalizeResultInput(valid); err != nil {
		t.Fatalf("valid closed result rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*UpsertRegressionResultInput)
	}{
		{"NaN score", func(input *UpsertRegressionResultInput) { value := math.NaN(); input.FidelityScore = &value }},
		{"infinite score", func(input *UpsertRegressionResultInput) { value := math.Inf(1); input.FidelityScore = &value }},
		{"missing key", func(input *UpsertRegressionResultInput) { delete(input.Breakdown, "structural_match") }},
		{"unknown key", func(input *UpsertRegressionResultInput) { input.Breakdown["provider_payload"] = 1.0 }},
		{"non-finite component", func(input *UpsertRegressionResultInput) { input.Breakdown["stylistic_distance"] = math.NaN() }},
		{"out-of-range component", func(input *UpsertRegressionResultInput) { input.Breakdown["vocabulary_overlap"] = 2.0 }},
		{"combined mismatch", func(input *UpsertRegressionResultInput) { input.Breakdown["combined"] = 79.0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			input.Breakdown = validStoreBreakdown(validScore)
			test.mutate(&input)
			if _, _, err := normalizeResultInput(input); !errors.Is(err, ErrInvalidResult) {
				t.Fatalf("normalize error = %v, want ErrInvalidResult", err)
			}
		})
	}
}

func TestSafeFailureForReadRedactsLegacyProviderText(t *testing.T) {
	t.Parallel()
	raw := "provider secret token sk-live-should-never-leave-storage"
	code, message := safeFailureForRead(nil, &raw)
	if code == nil || *code != legacyFailureCode || message == nil || *message != legacyFailureMessage ||
		strings.Contains(*message, "sk-live") {
		t.Fatalf("legacy failure was not safely redacted: code=%v message=%v", code, message)
	}
	safeCode := "voice_timeout"
	safeMessage := "the voice request timed out"
	code, message = safeFailureForRead(&safeCode, &safeMessage)
	if code == nil || *code != safeCode || message == nil || *message != safeMessage {
		t.Fatalf("safe worker-authored failure changed: code=%v message=%v", code, message)
	}
}
