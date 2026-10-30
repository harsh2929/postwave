// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCampaignImageRuntimeMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1933_campaign_image_broker_runtime.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE TABLE campaign_image_ocr_cache_entries",
		"PRIMARY KEY (\n        tenant_id, asset_sha256, raster_sha256, ocr_runtime_version,",
		"CREATE TABLE campaign_image_raster_evidence",
		"storage_version_id text NOT NULL",
		"CREATE TABLE campaign_image_raster_deletion_receipts",
		"requested_storage_version text NOT NULL",
		"campaign image raster deletion is not exact-version expired evidence",
		"evidence.storage_version_id <> NEW.requested_storage_version",
		"campaign_image_ocr_cache_entries FORCE ROW LEVEL SECURITY",
		"campaign_image_raster_evidence FORCE ROW LEVEL SECURITY",
		"campaign_image_raster_deletion_receipts FORCE ROW LEVEL SECURITY",
		"current_setting('app.outbox_worker', true) = 'true'",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_image_raster_evidence",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_image_raster_deletion_receipts",
		"OLD.expires_at <= statement_timestamp()",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing required fragment %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"GRANT UPDATE ON CAMPAIGN_IMAGE",
		"GRANT DELETE ON CAMPAIGN_IMAGE_RASTER",
		"ON DELETE SET NULL",
		"USING (TRUE)",
		"WITH CHECK (TRUE)",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration contains forbidden fragment %q", forbidden)
		}
	}
}
