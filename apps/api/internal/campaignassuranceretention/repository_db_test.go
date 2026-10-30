// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func rawRetentionPools(t *testing.T, ctx context.Context) (*db.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_RETENTION_APP_TEST_DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_RETENTION_TEST_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("dedicated raw-output retention app/admin database URLs are required")
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect restricted retention database: %v", err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatalf("connect retention fixture database: %v", err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func rawRetentionPostgresState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestExactDeletionSerializesLegalHoldAndAppendsImmutableReceiptDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	app, admin := rawRetentionPools(t, ctx)
	repository, err := NewRepository(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatal(err)
	}

	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	taskID := uuid.NewString()
	extractionID := uuid.NewString()
	reference := objectReferencePrefix + "campaign-assurance/raw-output/runs/" +
		uuid.NewString() + "/attempt-1/artifacts/" + uuid.NewString() +
		"/configurations/" + hashOf("db-config") + ".json"
	rawHash := hashOf("raw-output-db-body")
	manifestHash := hashOf("db-source-manifest")
	campaignHash := hashOf(campaignID)

	fixtureTx, err := admin.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = fixtureTx.Rollback(ctx) }()
	if _, err := fixtureTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixtureTx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID,
		"raw-retention-"+tenantID[:8], "Raw retention test"); err != nil {
		t.Fatal(err)
	}
	if _, err := fixtureTx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_retention_tasks (
    tenant_id, id, object_ref, object_ref_sha256, raw_output_sha256,
    raw_output_expires_at, source_extraction_id, source_receipt_sha256,
    source_manifest_sha256, campaign_ids, campaign_scope_sha256
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, statement_timestamp() - interval '1 hour',
    $6::uuid, $7, $8, ARRAY[$9::uuid], $10
)`, tenantID, taskID, reference, hashOf(reference), rawHash, extractionID,
		hashOf("source-receipt"), manifestHash, campaignID, campaignHash); err != nil {
		t.Fatal(err)
	}
	if err := fixtureTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupContext, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			t.Errorf("cleanup raw retention tenant: %v", err)
		}
	})

	claims, err := repository.ClaimExpired(ctx, "db-retention-worker", 500, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var claim Claim
	for _, candidate := range claims {
		if candidate.TaskID == taskID {
			claim = candidate
			break
		}
	}
	if claim.TaskID == "" {
		t.Fatalf("seeded task was not claimed: %+v", claims)
	}
	version, err := repository.RecordVersion(ctx, claim, VersionIdentity{
		Backend: "s3", Bucket: "assurance-private", ObjectKey: claim.ObjectKey,
		VersionID: "immutable-version-1", ContentSHA256: rawHash, ByteSize: 20,
		ProviderProofSHA256: hashOf("provider-proof"),
	})
	if err != nil {
		t.Fatal(err)
	}

	deleteStarted := make(chan struct{})
	releaseDelete := make(chan struct{})
	deleteDone := make(chan error, 1)
	go func() {
		_, deleteErr := repository.DeleteUnderLegalHoldFence(
			ctx, claim, version, "db-retention-worker", time.Minute,
			func(context.Context) (DeleteResult, error) {
				close(deleteStarted)
				<-releaseDelete
				return DeleteResult{
					Disposition:           DispositionDeleted,
					ResponseVersion:       version.VersionID,
					ProviderRequestIDHash: sha256Hex("provider-request-1"),
				}, nil
			},
		)
		deleteDone <- deleteErr
	}()
	select {
	case <-deleteStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("exact deletion did not reach fenced object-store call")
	}

	holdDone := make(chan error, 1)
	go func() {
		_, holdErr := admin.Exec(ctx, `
INSERT INTO campaign_assurance_legal_holds (tenant_id, campaign_id, reason)
VALUES ($1::uuid, $2::uuid, 'concurrent retention test')`, tenantID, campaignID)
		holdDone <- holdErr
	}()
	select {
	case err := <-holdDone:
		t.Fatalf("legal hold bypassed the deletion fence: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseDelete)
	if err := <-deleteDone; err != nil {
		t.Fatalf("complete exact deletion: %v", err)
	}
	if err := <-holdDone; err != nil {
		t.Fatalf("place serialized legal hold: %v", err)
	}

	var outcome, disposition string
	if err := admin.QueryRow(ctx, `
SELECT outcome, delete_disposition
  FROM campaign_assurance_raw_output_retention_receipts
 WHERE tenant_id = $1::uuid AND task_id = $2::uuid`, tenantID, taskID).Scan(
		&outcome, &disposition); err != nil {
		t.Fatal(err)
	}
	if outcome != "deleted" || disposition != DispositionDeleted {
		t.Fatalf("receipt outcome=%q disposition=%q", outcome, disposition)
	}
	_, err = admin.Exec(ctx, `
UPDATE campaign_assurance_raw_output_retention_receipts
   SET receipt_hash = $3
 WHERE tenant_id = $1::uuid AND task_id = $2::uuid`, tenantID, taskID, hashOf("rewrite"))
	if rawRetentionPostgresState(err) != "55000" {
		t.Fatalf("immutable receipt rewrite error=%v state=%q", err, rawRetentionPostgresState(err))
	}
}
