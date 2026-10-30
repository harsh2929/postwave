// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// Pin the confidentiality boundary independently of storage unit tests. The
// full tenant export must never drift back onto assetStorage/publicBase just
// because both stores happen to speak S3.
func TestTenantExportsUseDedicatedPrivateStorage(t *testing.T) {
	root := readAPICompositionRoot(t)
	source := root.main
	for _, fragment := range []string{
		`os.Getenv("POSTWAVE_EXPORTS_BUCKET")`,
		`exports.NewS3Storage(objectS3Client, exportBucket, s3KMSKeyID)`,
		`POSTWAVE_EXPORTS_BUCKET is required in production unless POSTWAVE_DISABLE_EXPORTS=1`,
		`Storage: exportStorage`,
		`sharedRetentionSweeper.ExportStore = exportStorage`,
		`sharedRetentionSweeper.LegacyExportStore = assetStorage`,
	} {
		if !strings.Contains(source, fragment) {
			t.Fatalf("main.go no longer pins private export storage contract %q", fragment)
		}
	}
	if strings.Contains(root.all, `exports.Deps{Pool: pool, Storage: assetStorage`) {
		t.Fatal("tenant export routes were rewired to the public asset storage")
	}
}
