// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

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

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func imageRuntimeDatabasePools(t *testing.T, ctx context.Context) (*db.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL and POSTWAVE_ASSURANCE_TEST_DATABASE_URL are required for image runtime DB proof")
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect restricted application database: %v", err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatalf("connect administrative fixture database: %v", err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

func imageRuntimeTenant(t *testing.T, ctx context.Context, admin *pgxpool.Pool, label string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, id, "image-runtime-"+label+"-"+id[:8], "Image runtime "+label); err != nil {
		t.Fatalf("seed image-runtime tenant: %v", err)
	}
	return id
}

func postgresState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestImageRuntimeRepositoryForcedRLSCacheAndExactDeletion_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	app, admin := imageRuntimeDatabasePools(t, ctx)
	var migrated bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.campaign_image_ocr_cache_entries') IS NOT NULL
   AND to_regclass('public.campaign_image_raster_evidence') IS NOT NULL
   AND to_regclass('public.campaign_image_raster_deletion_receipts') IS NOT NULL`).Scan(&migrated); err != nil {
		t.Fatal(err)
	}
	if !migrated {
		t.Fatal("configured database does not have migration 1933")
	}
	tenantID := imageRuntimeTenant(t, ctx, admin, "owner")
	foreignTenantID := imageRuntimeTenant(t, ctx, admin, "foreign")
	t.Cleanup(func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupContext, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantID, foreignTenantID); err != nil {
			t.Errorf("clean image-runtime tenants: %v", err)
		}
	})

	repository, err := NewRepository(app, 14*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatalf("restricted runtime readiness: %v", err)
	}
	ocrSocket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		return responseJSON(wireResponse{
			Protocol: ProtocolVersion, Operation: call.request.Operation, Status: "ready",
			Engine: "tesseract", Version: "tesseract.5.5.1-models.2026-08",
			SandboxProfile: SandboxProfile, Network: explicitFalse(), Browser: explicitFalse(),
			Tools: explicitFalse(), Shell: explicitFalse(),
		}), nil
	})
	scannerSocket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		return responseJSON(wireResponse{
			Protocol: ProtocolVersion, Operation: call.request.Operation, Status: "ready",
			Engine: "clamav", Version: "clamav.1.4.3-db.20260810",
			SandboxProfile: ScannerSandboxProfile, Network: explicitFalse(), Browser: explicitFalse(),
			Tools: explicitFalse(), Shell: explicitFalse(),
		}), nil
	})
	environment := validEnvironment()
	environment["POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET"] = ocrSocket
	environment["POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET"] = scannerSocket
	configuration, err := ConfigurationFromEnvironment(environmentReader(environment))
	if err != nil {
		t.Fatal(err)
	}
	imageRuntime, err := Build(ctx, configuration, Dependencies{
		Pool: app, Objects: &fakeVersionedS3{versioned: true},
	})
	if err != nil {
		t.Fatalf("build feature-on image runtime: %v", err)
	}
	worker := &campaignassuranceworker.Worker{}
	if err := imageRuntime.InjectWorker(worker); err != nil || worker.ImageInspector == nil {
		t.Fatalf("inject ready image inspector: inspector=%T err=%v", worker.ImageInspector, err)
	}
	confidence := 0.97
	key := campaignimagebroker.CacheKey{
		TenantID: tenantID, AssetSHA256: strings.Repeat("a", 64), RasterSHA256: strings.Repeat("b", 64),
		OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion, Engine: "sandboxed-ocr",
		EngineVersion: "sandboxed-ocr.2026-08-10", LanguageHint: "en-US",
	}
	output := campaignimagebroker.OCROutput{Text: "Doors close at 5 PM", Language: "en-US", Confidence: &confidence}
	if err := repository.Put(ctx, key, output); err != nil {
		t.Fatalf("store tenant OCR cache: %v", err)
	}
	cached, found, err := repository.Get(ctx, key)
	if err != nil || !found || cached.Text != output.Text || cached.Confidence == nil || *cached.Confidence != confidence {
		t.Fatalf("exact cache hit = %+v found=%v err=%v", cached, found, err)
	}
	foreignKey := key
	foreignKey.TenantID = foreignTenantID
	if _, found, err := repository.Get(ctx, foreignKey); err != nil || found {
		t.Fatalf("foreign-tenant cache lookup found=%v err=%v", found, err)
	}
	conflict := output
	conflict.Text = "Different OCR output"
	if err := repository.Put(ctx, key, conflict); !errors.Is(err, ErrCacheConflict) {
		t.Fatalf("immutable cache conflict error = %v, want ErrCacheConflict", err)
	}

	futureEvidence, err := repository.RecordEvidence(ctx, EvidenceRecordInput{
		TenantID:  tenantID,
		ObjectKey: "campaign-assurance/image-evidence/v1/tenants/" + tenantID + "/campaign-assurance/ocr/" + strings.Repeat("a", 64) + "/" + strings.Repeat("b", 64) + "/" + strings.Repeat("c", 64) + "/" + strings.Repeat("d", 64) + ".png",
		Bucket:    "postwave-campaign-image-evidence", StorageVersion: "storage-version-future",
		KMSKeyIDHash: strings.Repeat("e", 64), RasterSHA256: strings.Repeat("d", 64),
		MediaType: "image/png", ByteSize: 1024, ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("record future evidence: %v", err)
	}
	foreignTx, err := db.WithTenant(ctx, app, foreignTenantID)
	if err != nil {
		t.Fatal(err)
	}
	var foreignCount int
	if err := foreignTx.QueryRow(ctx, `SELECT count(*) FROM campaign_image_raster_evidence WHERE id = $1::uuid`, futureEvidence.ID).Scan(&foreignCount); err != nil {
		_ = foreignTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = foreignTx.Rollback(ctx)
	if foreignCount != 0 {
		t.Fatalf("foreign tenant read %d evidence rows", foreignCount)
	}
	if err := repository.RecordDeletion(ctx, DeletionReceiptInput{
		Evidence: futureEvidence, ResponseStorageVersion: futureEvidence.StorageVersion,
	}); postgresState(err) != "55000" {
		t.Fatalf("early evidence deletion receipt error=%v state=%q, want 55000", err, postgresState(err))
	}

	ownerTx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, updateErr := ownerTx.Exec(ctx, `
UPDATE campaign_image_ocr_cache_entries SET ocr_text = 'rewritten'
WHERE tenant_id = $1::uuid AND asset_sha256 = $2`, tenantID, key.AssetSHA256)
	_ = ownerTx.Rollback(ctx)
	if postgresState(updateErr) != "42501" {
		t.Fatalf("restricted app cache rewrite error=%v state=%q, want 42501", updateErr, postgresState(updateErr))
	}

	expiredCacheKey := campaignimagebroker.CacheKey{
		TenantID: tenantID, AssetSHA256: strings.Repeat("1", 64), RasterSHA256: strings.Repeat("2", 64),
		OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion, Engine: "sandboxed-ocr",
		EngineVersion: "sandboxed-ocr.2026-08-10", LanguageHint: "fr-FR",
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_image_ocr_cache_entries (
    tenant_id, asset_sha256, raster_sha256, ocr_runtime_version, engine,
    engine_version, language_hint, ocr_text, ocr_language, output_hash,
    created_at, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'Texte', 'fr-FR', $8,
          statement_timestamp() - interval '2 hours',
          statement_timestamp() - interval '1 hour')`,
		expiredCacheKey.TenantID, expiredCacheKey.AssetSHA256, expiredCacheKey.RasterSHA256,
		expiredCacheKey.OCRRuntimeVersion, expiredCacheKey.Engine, expiredCacheKey.EngineVersion,
		expiredCacheKey.LanguageHint,
		digestOCROutput(campaignimagebroker.OCROutput{Text: "Texte", Language: "fr-FR"})); err != nil {
		t.Fatalf("seed expired cache: %v", err)
	}
	deleted, err := repository.SweepExpiredCache(ctx, 100)
	if err != nil || deleted < 1 {
		t.Fatalf("sweep expired OCR cache deleted=%d err=%v", deleted, err)
	}

	expiredID := uuid.NewString()
	expiredKey := "campaign-assurance/image-evidence/v1/tenants/" + foreignTenantID + "/campaign-assurance/ocr/" + strings.Repeat("4", 64) + "/" + strings.Repeat("5", 64) + "/" + strings.Repeat("6", 64) + "/" + strings.Repeat("7", 64) + ".png"
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_image_raster_evidence (
    tenant_id, id, object_key, bucket, storage_version_id, kms_key_id_hash,
    raster_sha256, media_type, byte_size, created_at, expires_at
) VALUES ($1::uuid, $2::uuid, $3, 'postwave-campaign-image-evidence',
          'storage-version-expired', $4, $5, 'image/png', 2048,
          statement_timestamp() - interval '2 hours',
          statement_timestamp() - interval '1 hour')`,
		foreignTenantID, expiredID, expiredKey, strings.Repeat("8", 64), strings.Repeat("7", 64)); err != nil {
		t.Fatalf("seed expired evidence: %v", err)
	}
	expired, err := repository.ListExpiredEvidence(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	var expiredRecord *EvidenceRecord
	for index := range expired {
		if expired[index].ID == expiredID {
			expiredRecord = &expired[index]
			break
		}
	}
	if expiredRecord == nil {
		t.Fatalf("expired evidence not discoverable through worker scope: %+v", expired)
	}
	if err := repository.RecordDeletion(ctx, DeletionReceiptInput{
		Evidence: *expiredRecord, ResponseStorageVersion: expiredRecord.StorageVersion,
	}); err != nil {
		t.Fatalf("record exact expired deletion: %v", err)
	}
	if err := repository.RecordDeletion(ctx, DeletionReceiptInput{
		Evidence: *expiredRecord, ProviderRequestIDHash: strings.Repeat("9", 64),
	}); err != nil {
		t.Fatalf("replay exact expired deletion receipt: %v", err)
	}
	foreignTx, err = db.WithTenant(ctx, app, foreignTenantID)
	if err != nil {
		t.Fatal(err)
	}
	var receiptCount int
	if err := foreignTx.QueryRow(ctx, `
SELECT count(*) FROM campaign_image_raster_deletion_receipts
WHERE evidence_id = $1::uuid AND requested_storage_version = $2`,
		expiredRecord.ID, expiredRecord.StorageVersion).Scan(&receiptCount); err != nil {
		_ = foreignTx.Rollback(ctx)
		t.Fatal(err)
	}
	_ = foreignTx.Rollback(ctx)
	if receiptCount != 1 {
		t.Fatalf("exact-version deletion receipt count = %d, want 1", receiptCount)
	}
}
