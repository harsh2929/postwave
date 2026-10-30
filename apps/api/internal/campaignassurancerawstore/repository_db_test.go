// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func rawStorePools(t *testing.T, ctx context.Context) (*db.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_RAWSTORE_APP_TEST_DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_RAWSTORE_TEST_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("dedicated raw-output write-receipt app/admin database URLs are required")
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func postgresState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestWriteVersionCleanupReceiptLifecycleDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	app, admin := rawStorePools(t, ctx)
	repository, err := NewRepository(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatal(err)
	}

	tenantID, intentID := uuid.NewString(), uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Raw output write receipt test', 'studio')`, tenantID,
		"raw-output-write-"+tenantID[:8]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanup, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID); err != nil {
			t.Errorf("cleanup raw-output write tenant: %v", err)
		}
	})

	body := []byte(`{"status":"db-proof"}`)
	input := makeIntentInput(t, body)
	input.TenantID, input.IntentID = tenantID, intentID
	input.ObjectRest = strings.Replace(input.ObjectRest, testTenant, tenantID, 1)
	input.ObjectRest = strings.TrimSuffix(input.ObjectRest, testIntent+".json") + intentID + ".json"
	input.ObjectKey = "tenants/" + tenantID + "/" + input.ObjectRest
	input.ObjectRef = objectReferencePrefix + input.ObjectRest
	intent, err := repository.BeginWrite(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	receipt := VersionReceipt{
		TenantID: tenantID, IntentID: intentID, ObjectRest: input.ObjectRest,
		ObjectKey: input.ObjectKey, ObjectRef: input.ObjectRef, Bucket: input.Bucket,
		VersionID: "db-version-1", ContentSHA256: input.ContentSHA256,
		ChecksumBase64: input.ChecksumBase64, ContentType: input.ContentType,
		ByteSize: input.ByteSize, KMSKeyIDHash: input.KMSKeyIDHash,
	}
	receipt.ProviderProofHash = providerProof(receipt)
	receipt, err = repository.RecordVersion(ctx, intent, receipt)
	if err != nil || receipt.ReceiptHash == "" {
		t.Fatalf("record exact version: receipt=%+v err=%v", receipt, err)
	}
	claim, err := repository.ClaimCleanup(ctx, tenantID, input.ObjectRest, "db-raw-output-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if claim.Version == nil || claim.Version.ReceiptHash != receipt.ReceiptHash {
		t.Fatalf("cleanup claim lost durable exact version: %+v", claim)
	}
	if err := repository.RecordCleanup(ctx, claim, *claim.Version, CleanupResult{
		Disposition: CleanupDeleted, ResponseVersion: receipt.VersionID,
		ProviderRequestIDHash: sha256Hex([]byte("db-provider-request")),
	}); err != nil {
		t.Fatal(err)
	}

	var state, outcome, requestHash string
	if err := admin.QueryRow(ctx, `
SELECT intent.state, cleanup.outcome, cleanup.provider_request_id_sha256
  FROM campaign_assurance_raw_output_write_intents intent
  JOIN campaign_assurance_raw_output_cleanup_receipts cleanup
    ON cleanup.tenant_id=intent.tenant_id AND cleanup.intent_id=intent.id
 WHERE intent.tenant_id=$1::uuid AND intent.id=$2::uuid`, tenantID, intentID).Scan(
		&state, &outcome, &requestHash); err != nil {
		t.Fatal(err)
	}
	if state != "cleaned" || outcome != CleanupDeleted || requestHash != sha256Hex([]byte("db-provider-request")) {
		t.Fatalf("state=%q outcome=%q requestHash=%q", state, outcome, requestHash)
	}
	_, err = admin.Exec(ctx, `
UPDATE campaign_assurance_raw_output_write_receipts
   SET receipt_hash=$3
 WHERE tenant_id=$1::uuid AND intent_id=$2::uuid`, tenantID, intentID, strings.Repeat("f", 64))
	if postgresState(err) != "55000" {
		t.Fatalf("immutable version receipt update state=%q err=%v", postgresState(err), err)
	}
}
