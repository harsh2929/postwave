// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"bytes"
	"context"
	"testing"
)

func TestValidateAndSanitizeUploadExportUsesHardenedPipeline(t *testing.T) {
	const secret = "private-preview-metadata"
	body := pngWithTextMetadata(t, encodeTestImage(t, "png", 8, 12), secret)

	got, err := ValidateAndSanitizeUpload(context.Background(), body)
	if err != nil {
		t.Fatal(err)
	}
	if got.MIME != "image/png" || got.Width != 8 || got.Height != 12 {
		t.Fatalf("result = %q %dx%d", got.MIME, got.Width, got.Height)
	}
	if bytes.Contains(got.Body, []byte(secret)) {
		t.Fatal("exported sanitizer retained non-rendering metadata")
	}
	if _, _, _, err := ValidateUpload(got.MIME, got.Body); err != nil {
		t.Fatalf("sanitized result does not pass the canonical validator: %v", err)
	}
}
