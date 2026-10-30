// SPDX-License-Identifier: AGPL-3.0-only
package email_template

import (
	"bytes"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestContentHash_Deterministic guards the contract the cache
// invalidation depends on: same input -> same hash, byte-for-byte.
func TestContentHash_Deterministic(t *testing.T) {
	a := ContentHash(ThumbnailSource{Subject: "Hi", BodyHTML: "<p>hello</p>"})
	b := ContentHash(ThumbnailSource{Subject: "Hi", BodyHTML: "<p>hello</p>"})
	if a != b {
		t.Fatalf("hash not stable: %q vs %q", a, b)
	}
}

// TestContentHash_FieldSeparator ensures the U+001F separator
// prevents the "subject ends in HTML / body starts the same" false
// collision a naive concat would have. If this regresses, the
// thumbnail cache will start serving stale PNGs for sibling templates.
func TestContentHash_FieldSeparator(t *testing.T) {
	a := ContentHash(ThumbnailSource{Subject: "<p", BodyHTML: ">hello</p>"})
	b := ContentHash(ThumbnailSource{Subject: "", BodyHTML: "<p>hello</p>"})
	if a == b {
		t.Fatalf("hashes collided across a missing separator: %q", a)
	}
}

// TestDefaultRender_ProducesValidPNG sanity-checks that the stdlib
// renderer emits a parseable PNG of the expected dimensions. Catches
// the "I refactored colorFromString and now image.Encode panics"
// class of bug at unit-test time.
func TestDefaultRender_ProducesValidPNG(t *testing.T) {
	out, err := DefaultRender(ThumbnailSource{
		Name:     "Welcome",
		Subject:  "Welcome to Moosewave",
		BodyHTML: "<p>Hi there</p><p>This is the body</p>",
	})
	if err != nil {
		t.Fatalf("render err: %v", err)
	}
	if len(out) < 100 {
		t.Fatalf("png too small: %d bytes", len(out))
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode err: %v", err)
	}
	if img.Bounds().Dx() != thumbnailWidth || img.Bounds().Dy() != thumbnailHeight {
		t.Fatalf("bounds = %v, want %dx%d", img.Bounds(), thumbnailWidth, thumbnailHeight)
	}
}

// TestDefaultRender_DifferentInputsDifferentPNGs guards the
// "thumbnail collapses to the same image for distinct templates"
// regression mode. Two templates with different names + bodies must
// produce different PNGs or the gallery becomes unreadable.
func TestDefaultRender_DifferentInputsDifferentPNGs(t *testing.T) {
	a, _ := DefaultRender(ThumbnailSource{Name: "Welcome", Subject: "x", BodyHTML: "<p>short</p>"})
	b, _ := DefaultRender(ThumbnailSource{Name: "Re-engagement", Subject: "y", BodyHTML: "<p>a long body with many more words to push the band heuristic into a denser layout that should change the image bytes noticeably from the short variant above</p>"})
	if bytes.Equal(a, b) {
		t.Fatal("renderer produced identical bytes for different inputs")
	}
}

// TestBodyBands_HandlesEmptyAndTagOnly ensures the band heuristic
// doesn't divide-by-zero or panic on the degenerate inputs operators
// frequently save mid-edit.
func TestBodyBands_HandlesEmptyAndTagOnly(t *testing.T) {
	for _, in := range []string{"", "   ", "<div></div>", "<style>.x{color:red}</style>"} {
		got := bodyBands(in)
		if len(got) == 0 {
			t.Fatalf("bodyBands(%q) returned no bands", in)
		}
	}
}

// TestLooksLikeUUID rejects obvious garbage so the DB doesn't see
// it. The handler depends on this gate to keep the error path cheap.
func TestLooksLikeUUID(t *testing.T) {
	if !looksLikeUUID("00000000-0000-0000-0000-000000000000") {
		t.Fatal("zero UUID should match")
	}
	if looksLikeUUID("not-a-uuid") {
		t.Fatal("garbage should not match")
	}
	if looksLikeUUID("00000000-0000-0000-0000-00000000000g") {
		t.Fatal("non-hex char in last block should not match")
	}
}

func TestThumbnailServeRequiresTenantBeforeDatabaseAccess(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/templates/00000000-0000-4000-8000-000000000001/thumbnail.png", nil)
	rec := httptest.NewRecorder()
	(&ThumbnailDeps{}).Serve(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"no_tenant"`) {
		t.Fatalf("status=%d body=%s, want 401/no_tenant", rec.Code, rec.Body.String())
	}
}
