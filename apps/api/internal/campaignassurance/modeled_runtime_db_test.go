// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func modeledDBCreateInput(fixture assuranceFixture) CreateRunInput {
	input := validCreateInput()
	input.CampaignID = fixture.campaignID
	input.ContentRevisionID = fixture.revisionID
	input.SendPlanID = fixture.planID
	input.RequestID = uuid.NewString()
	input.MaxAttempts = 1
	input.Configurations = []ConfigurationInput{{
		ID:          "model.primary",
		SourceClass: SourceModeled,
		Configuration: json.RawMessage(`{
            "maximum_cost_microunits": 100,
            "model_provider": "test",
            "model_id": "model-v1"
        }`),
	}}
	input.Targets = nil
	return input
}

func modeledDBReservation(target RunTarget, ordinal int) ModeledInvocationReservationInput {
	return ModeledInvocationReservationInput{
		InvocationID:       strings.Repeat(string("123456789abcdef"[ordinal]), 64),
		CacheKey:           strings.Repeat(string("abcdef123456789"[ordinal]), 64),
		InputManifestHash:  strings.Repeat(string("fedcba987654321"[ordinal]), 64),
		ArtifactID:         target.ArtifactID,
		ConfigurationID:    target.ConfigurationID,
		ConfigurationHash:  target.ConfigurationHash,
		OutboundMIMEHash:   target.OutboundMIMEHash,
		ReservedMicrounits: 100,
	}
}

// prepareModeledRawOutputReceipt mirrors the receipt-aware storage boundary
// introduced in migration 2016. The modeled-runtime repository test does not
// exercise S3 itself, but a current database must still see a committed exact
// version receipt before it will accept an extraction with a raw-object ref.
func prepareModeledRawOutputReceipt(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	runID string,
	target RunTarget,
	ordinal int,
) (string, string) {
	t.Helper()
	body := []byte(fmt.Sprintf(`{"summary":"Launch is Friday","ordinal":%d}`, ordinal))
	digest := sha256.Sum256(body)
	contentHash := hex.EncodeToString(digest[:])
	checksum := base64.StdEncoding.EncodeToString(digest[:])
	intentID := uuid.NewString()
	rest := fmt.Sprintf(
		"campaign-assurance/raw-output/runs/%s/attempt-1/artifacts/%s/configurations/%s/writes/%s.json",
		runID,
		target.ArtifactID,
		target.ConfigurationHash,
		intentID,
	)
	objectKey := "tenants/" + tenantID + "/" + rest
	objectRef := "postwave.tenant-object-ref.v1:" + rest
	versionID := fmt.Sprintf("modeled-db-version-%d", ordinal)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin raw-output receipt: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		t.Fatalf("bind raw-output worker scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_write_intents (
    tenant_id, id, object_rest, object_key, object_ref, content_sha256,
    checksum_sha256_base64, content_type, byte_size, bucket, kms_key_id_sha256
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'application/json', $8,
          'modeled-db-proof', $9)`, tenantID, intentID, rest, objectKey, objectRef,
		contentHash, checksum, len(body), strings.Repeat("a", 64)); err != nil {
		t.Fatalf("insert raw-output write intent: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_write_receipts (
    tenant_id, intent_id, storage_backend, bucket, object_key,
    storage_version_id, storage_version_sha256, content_sha256,
    checksum_sha256_base64, content_type, byte_size, kms_key_id_sha256,
    provider_proof_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, 's3', 'modeled-db-proof', $3, $4,
    encode(digest(convert_to($4, 'UTF8'), 'sha256'), 'hex'), $5, $6,
    'application/json', $7, $8, $9, repeat('0', 64)
)`, tenantID, intentID, objectKey, versionID, contentHash, checksum, len(body),
		strings.Repeat("a", 64), strings.Repeat("b", 64)); err != nil {
		t.Fatalf("insert raw-output version receipt: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit raw-output receipt: %v", err)
	}
	return objectRef, contentHash
}

// TestModeledCacheAndAggregateBudget_DB proves the migration-backed behavior:
// concurrent pre-call reservations cannot exceed the frozen all-attempt cap,
// settlement is immutable/idempotent, terminal cost comes from the invocation
// ledger, and exact cache reuse is direct, zero-cost, and invalidated by stale
// source provenance. The test is skipped unless the opt-in DB has v1931.
func TestModeledCacheAndAggregateBudget_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := assuranceDBPool(t, ctx)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_model_invocation_reservations') IS NOT NULL
   AND to_regclass('public.campaign_assurance_model_invocation_results') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect modeled runtime schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migration 1931")
	}

	repo := NewRepo(pool)
	fixture := seedAssuranceFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.tenantID, fixture.foreignTenantID)
	})

	sourceInput := modeledDBCreateInput(fixture)
	source, err := repo.CreateRun(ctx, fixture.tenantID, sourceInput)
	if err != nil {
		t.Fatalf("create modeled source run: %v", err)
	}
	if source.MaxModeledCostMicrounits != 200 {
		t.Fatalf("frozen modeled budget = %d, want 200", source.MaxModeledCostMicrounits)
	}
	claimed, err := repo.ClaimRun(ctx, fixture.tenantID, source.ID, "modeled-db-source", time.Minute)
	if err != nil {
		t.Fatalf("claim modeled source run: %v", err)
	}
	if len(claimed.Targets) != 2 {
		t.Fatalf("modeled source targets = %d, want 2", len(claimed.Targets))
	}

	reservations := make([]ModeledInvocationReservationInput, len(claimed.Targets))
	start := make(chan struct{})
	results := make(chan error, len(claimed.Targets))
	for index, target := range claimed.Targets {
		reservations[index] = modeledDBReservation(target, index)
		reservation := reservations[index]
		go func() {
			<-start
			_, reserveErr := repo.ReserveModeledInvocation(ctx, fixture.tenantID, source.ID,
				*claimed.Run.ClaimToken, claimed.Run.AttemptCount, reservation)
			results <- reserveErr
		}()
	}
	close(start)
	for range claimed.Targets {
		if err := <-results; err != nil {
			t.Fatalf("concurrent modeled reservation: %v", err)
		}
	}
	if replay, err := repo.ReserveModeledInvocation(ctx, fixture.tenantID, source.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, reservations[0]); err != nil || replay.InvocationID != reservations[0].InvocationID {
		t.Fatalf("idempotent reservation replay = %+v, err=%v", replay, err)
	}
	overBudget := reservations[0]
	overBudget.InvocationID = strings.Repeat("9", 64)
	if _, err := repo.ReserveModeledInvocation(ctx, fixture.tenantID, source.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, overBudget); !errors.Is(err, ErrCostBudgetExceeded) {
		t.Fatalf("aggregate over-budget reservation error = %v, want ErrCostBudgetExceeded", err)
	}

	origins := make(map[string]Extraction, len(claimed.Targets))
	for index, target := range claimed.Targets {
		reservation := reservations[index]
		settlement := ModeledInvocationResultInput{
			InvocationID: reservation.InvocationID, Status: InvocationResultComplete,
			InputTokens: 10, OutputTokens: 5, CostMicrounits: 25, LatencyMS: 20,
		}
		first, err := repo.RecordModeledInvocationResult(ctx, fixture.tenantID, source.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, settlement)
		if err != nil {
			t.Fatalf("settle modeled invocation %d: %v", index, err)
		}
		replay, err := repo.RecordModeledInvocationResult(ctx, fixture.tenantID, source.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, settlement)
		if err != nil || replay.ReceiptHash != first.ReceiptHash {
			t.Fatalf("idempotent settlement replay %d = %+v, err=%v", index, replay, err)
		}

		expires := time.Now().UTC().Add(time.Hour)
		temperature := 0.0
		rawOutputRef, rawOutputHash := prepareModeledRawOutputReceipt(
			t, ctx, pool, fixture.tenantID, source.ID, target, index,
		)
		extraction, err := repo.RecordExtraction(ctx, fixture.tenantID, source.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, ExtractionInput{
				ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
				SourceClass: SourceModeled, ConfigurationHash: target.ConfigurationHash,
				OutboundMIMEHash: target.OutboundMIMEHash, Status: ExtractionComplete,
				NormalizedExtraction: json.RawMessage(`{"summary":"Launch is Friday"}`),
				EvidenceManifest:     json.RawMessage(`{"blocks":["blk_01"]}`),
				UnsupportedClaims:    json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
				RawOutputObjectRef: rawOutputRef,
				RawOutputHash:      rawOutputHash, RawOutputExpiresAt: &expires,
				ModelProvider: "test", ModelID: "model-v1", ModelVersion: "snapshot-v1",
				PromptVersion: "prompt-v1", PromptHash: strings.Repeat("c", 64), Temperature: &temperature,
				InputTokens: 10, OutputTokens: 5, CostMicrounits: 25, LatencyMS: 20,
				ModelCacheKey: reservation.CacheKey, ModelInputManifestHash: reservation.InputManifestHash,
				ModelInvocationID: reservation.InvocationID, ExecutionKind: ModeledExecutionInvoked,
			})
		if err != nil {
			t.Fatalf("record invoked modeled extraction %d: %v", index, err)
		}
		origins[target.ArtifactID] = *extraction
	}
	completed, err := repo.FinalizeRun(ctx, fixture.tenantID, source.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, FinalizeInput{GateDecision: GatePass})
	if err != nil {
		t.Fatalf("finalize modeled source run: %v", err)
	}
	if completed.State != StateComplete || completed.CostMicrounits != 50 || completed.MaxModeledCostMicrounits != 200 {
		t.Fatalf("modeled terminal aggregate = %+v, want complete cost=50 max=200", completed)
	}

	currentInput := modeledDBCreateInput(fixture)
	current, err := repo.CreateRun(ctx, fixture.tenantID, currentInput)
	if err != nil {
		t.Fatalf("create modeled reuse run: %v", err)
	}
	currentClaim, err := repo.ClaimRun(ctx, fixture.tenantID, current.ID, "modeled-db-reuse", time.Minute)
	if err != nil {
		t.Fatalf("claim modeled reuse run: %v", err)
	}
	firstTarget := currentClaim.Targets[0]
	firstOrigin := origins[firstTarget.ArtifactID]
	lookup := ModeledCacheLookupInput{
		ArtifactID: firstTarget.ArtifactID, ConfigurationID: firstTarget.ConfigurationID,
		ConfigurationHash: firstTarget.ConfigurationHash, OutboundMIMEHash: firstTarget.OutboundMIMEHash,
		CacheKey: firstOrigin.ModelCacheKey, InputManifestHash: firstOrigin.ModelInputManifestHash,
	}
	candidate, err := repo.FindReusableModeledExtraction(ctx, fixture.tenantID, current.ID,
		*currentClaim.Run.ClaimToken, currentClaim.Run.AttemptCount, lookup)
	if err != nil || candidate == nil || candidate.Extraction.ID != firstOrigin.ID {
		t.Fatalf("find exact reusable modeled origin = %+v, err=%v", candidate, err)
	}
	reuseInput := candidate.Extraction.ExtractionInput
	reuseInput.InputTokens = 0
	reuseInput.OutputTokens = 0
	reuseInput.CostMicrounits = 0
	reuseInput.LatencyMS = 0
	reuseInput.ModelInvocationID = strings.Repeat("d", 64)
	reuseInput.ExecutionKind = ModeledExecutionCacheReuse
	reuseInput.ReusedFromExtractionID = candidate.Extraction.ID
	reuseInput.ReusedFromReceiptHash = candidate.Extraction.ReceiptHash
	reuseInput.ReusedOriginalCostMicrounits = candidate.Extraction.CostMicrounits
	reused, err := repo.RecordModeledCacheReuse(ctx, fixture.tenantID, current.ID,
		*currentClaim.Run.ClaimToken, currentClaim.Run.AttemptCount, ModeledCacheReuseInput{
			SourceExtractionID: candidate.Extraction.ID,
			SourceReceiptHash:  candidate.Extraction.ReceiptHash,
			Extraction:         reuseInput,
		})
	if err != nil || reused.CostMicrounits != 0 || reused.ReusedOriginalCostMicrounits != 25 {
		t.Fatalf("persist zero-cost modeled reuse = %+v, err=%v", reused, err)
	}

	if _, err := repo.MarkStale(ctx, fixture.tenantID, source.ID); err != nil {
		t.Fatalf("mark modeled source stale: %v", err)
	}
	secondTarget := currentClaim.Targets[1]
	secondOrigin := origins[secondTarget.ArtifactID]
	staleCandidate, err := repo.FindReusableModeledExtraction(ctx, fixture.tenantID, current.ID,
		*currentClaim.Run.ClaimToken, currentClaim.Run.AttemptCount, ModeledCacheLookupInput{
			ArtifactID: secondTarget.ArtifactID, ConfigurationID: secondTarget.ConfigurationID,
			ConfigurationHash: secondTarget.ConfigurationHash, OutboundMIMEHash: secondTarget.OutboundMIMEHash,
			CacheKey: secondOrigin.ModelCacheKey, InputManifestHash: secondOrigin.ModelInputManifestHash,
		})
	if err != nil || staleCandidate != nil {
		t.Fatalf("stale modeled source remained reusable = %+v, err=%v", staleCandidate, err)
	}

	if _, err := pool.Exec(ctx, `
UPDATE campaign_assurance_model_invocation_results
   SET cost_microunits = cost_microunits + 1
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, fixture.tenantID, source.ID); sqlState(err) != "55000" {
		t.Fatalf("modeled settlement rewrite error = %v state=%q, want 55000", err, sqlState(err))
	}
}
