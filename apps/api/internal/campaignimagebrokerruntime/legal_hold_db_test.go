// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

// Raster and OCR evidence is deleted on schedule once expires_at passes. A
// legal hold has to stop that, and it has to stop it for evidence that is
// ALREADY expired — a hold is placed after something happened, not before.
//
// These sweeps run under worker scope across every tenant, so the check cannot
// be "does this tenant's request carry a hold". It is a per-row SQL predicate,
// which is also why it cannot be forgotten by a caller.

func TestExpiredRasterEvidenceUnderHoldIsNotListedForDeletion(t *testing.T) {
	ctx := context.Background()
	app, admin := imageRuntimeDatabasePools(t, ctx)
	repository := &Repository{Pool: app}

	heldTenant := imageRuntimeTenant(t, ctx, admin, "image-hold-held")
	freeTenant := imageRuntimeTenant(t, ctx, admin, "image-hold-free")

	heldID := seedExpiredRaster(t, ctx, admin, heldTenant)
	freeID := seedExpiredRaster(t, ctx, admin, freeTenant)

	// The hold is placed AFTER the evidence already expired, which is the
	// realistic order: nobody places a hold in anticipation.
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_assurance_legal_holds (tenant_id, reason)
VALUES ($1::uuid, 'regulator request')`, heldTenant); err != nil {
		t.Fatalf("place hold: %v", err)
	}

	expired, err := repository.ListExpiredEvidence(ctx, 500)
	if err != nil {
		t.Fatalf("list expired evidence: %v", err)
	}

	var sawHeld, sawFree bool
	for _, record := range expired {
		if record.ID == heldID {
			sawHeld = true
		}
		if record.ID == freeID {
			sawFree = true
		}
	}
	if sawHeld {
		t.Error("evidence under legal hold must not be offered to the deletion worker")
	}
	if !sawFree {
		t.Error("evidence with no hold must still be swept; the hold must not suspend everything")
	}
}

func TestExpiredOCRCacheUnderHoldSurvivesTheSweep(t *testing.T) {
	ctx := context.Background()
	app, admin := imageRuntimeDatabasePools(t, ctx)
	repository := &Repository{Pool: app}

	heldTenant := imageRuntimeTenant(t, ctx, admin, "ocr-hold-held")
	assetHash := seedExpiredCacheEntry(t, ctx, admin, heldTenant)

	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_assurance_legal_holds (tenant_id, reason)
VALUES ($1::uuid, 'litigation hold ACME-1')`, heldTenant); err != nil {
		t.Fatalf("place hold: %v", err)
	}

	if _, err := repository.SweepExpiredCache(ctx, 500); err != nil {
		t.Fatalf("sweep expired cache: %v", err)
	}

	var remaining int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM campaign_image_ocr_cache_entries
 WHERE tenant_id = $1::uuid AND asset_sha256 = $2`, heldTenant, assetHash).Scan(&remaining); err != nil {
		t.Fatalf("count cache entries: %v", err)
	}
	if remaining != 1 {
		t.Errorf("expired OCR cache under hold: %d rows remain, want 1 (the sweep deleted held evidence)", remaining)
	}
}

// Releasing the hold must let the sweep proceed, otherwise a hold is a
// permanent leak dressed up as compliance.
func TestReleasingTheHoldLetsTheSweepProceed(t *testing.T) {
	ctx := context.Background()
	app, admin := imageRuntimeDatabasePools(t, ctx)
	repository := &Repository{Pool: app}

	tenantID := imageRuntimeTenant(t, ctx, admin, "ocr-hold-release")
	assetHash := seedExpiredCacheEntry(t, ctx, admin, tenantID)

	var holdID string
	if err := admin.QueryRow(ctx, `
INSERT INTO campaign_assurance_legal_holds (tenant_id, reason)
VALUES ($1::uuid, 'litigation hold ACME-1') RETURNING id`, tenantID).Scan(&holdID); err != nil {
		t.Fatalf("place hold: %v", err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaign_assurance_legal_holds
   SET released_at = now(), release_reason = 'matter closed'
 WHERE id = $1::uuid`, holdID); err != nil {
		t.Fatalf("release hold: %v", err)
	}

	if _, err := repository.SweepExpiredCache(ctx, 500); err != nil {
		t.Fatalf("sweep expired cache: %v", err)
	}

	var remaining int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM campaign_image_ocr_cache_entries
 WHERE tenant_id = $1::uuid AND asset_sha256 = $2`, tenantID, assetHash).Scan(&remaining); err != nil {
		t.Fatalf("count cache entries: %v", err)
	}
	if remaining != 0 {
		t.Errorf("after release the sweep must delete: %d rows remain, want 0", remaining)
	}
}

func seedExpiredRaster(t *testing.T, ctx context.Context, admin *pgxpool.Pool, tenantID string) string {
	t.Helper()
	id := uuid.NewString()
	rasterHash := strings.Repeat("7", 64)
	key := "campaign-assurance/image-evidence/v1/tenants/" + tenantID + "/hold/" + id + ".png"
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_image_raster_evidence (
    tenant_id, id, object_key, bucket, storage_version_id, kms_key_id_hash,
    raster_sha256, media_type, byte_size, created_at, expires_at
) VALUES ($1::uuid, $2::uuid, $3, 'postwave-campaign-image-evidence',
          'storage-version-' || $2, $4, $5, 'image/png', 2048,
          statement_timestamp() - interval '2 hours',
          statement_timestamp() - interval '1 hour')`,
		tenantID, id, key, strings.Repeat("8", 64), rasterHash); err != nil {
		t.Fatalf("seed expired raster: %v", err)
	}
	return id
}

func seedExpiredCacheEntry(t *testing.T, ctx context.Context, admin *pgxpool.Pool, tenantID string) string {
	t.Helper()
	assetHash := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.Repeat("0", 32)
	assetHash = assetHash[:64]
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_image_ocr_cache_entries (
    tenant_id, asset_sha256, raster_sha256, ocr_runtime_version, engine,
    engine_version, language_hint, ocr_text, ocr_language, output_hash,
    created_at, expires_at
) VALUES ($1::uuid, $2, $3, $5, 'sandboxed-ocr', 'sandboxed-ocr.2026-08-10',
          'en-US', 'Text', 'en-US', $4,
          statement_timestamp() - interval '2 hours',
          statement_timestamp() - interval '1 hour')`,
		tenantID, assetHash, strings.Repeat("2", 64), strings.Repeat("3", 64), campaignimagebroker.OCRRuntimeVersion); err != nil {
		t.Fatalf("seed expired cache entry: %v", err)
	}
	return assetHash
}
