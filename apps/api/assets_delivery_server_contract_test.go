// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"os"
	"strings"
	"testing"
)

// This pins the startup fail-closed wiring independently of the storage unit
// tests. A future refactor must not accidentally construct canonical S3 assets
// without the public CDN base that recipient email clients require.
func TestAssetS3StartupRequiresExplicitPublicDeliveryBase(t *testing.T) {
	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	source := string(sourceBytes)
	for _, fragment := range []string{
		`os.Getenv("POSTWAVE_ASSETS_PUBLIC_BASE_URL")`,
		`assets.NewS3Storage(objectS3Client, assetBucket, s3KMSKeyID, publicBase)`,
		`if storageErr != nil`,
	} {
		if !strings.Contains(source, fragment) {
			t.Fatalf("main.go no longer pins asset public-delivery startup contract %q", fragment)
		}
	}
}
