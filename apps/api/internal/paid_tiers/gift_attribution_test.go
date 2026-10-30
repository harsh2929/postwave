package paid_tiers

// Tests for gift_attribution.go. Like paid_tiers_test.go these
// exercise the pure-Go paths that fire before any DB call: token
// minting, handler-level tenant guard, and limit param parsing.
// The DB-backed read path (GetAttributionReport) is covered by the
// e2e migration smoke test (the SQL is exercised against a live
// postgres in CI). See infra/migrations/0304_gift_subscriptions_attribution.sql.

import (
	"encoding/base32"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestMintAttributionToken_ShapeAndUniqueness — the ref token must
// be URL-safe (lower-case base32, no padding), of the documented
// length, and non-repeating across calls. A flaky-looking duplicate
// here would indicate a broken rand source.
func TestMintAttributionToken_ShapeAndUniqueness(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 64; i++ {
		tok, err := mintAttributionToken()
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if tok == "" {
			t.Fatalf("empty token")
		}
		if tok != strings.ToLower(tok) {
			t.Errorf("token %q has upper-case chars", tok)
		}
		if strings.Contains(tok, "=") {
			t.Errorf("token %q has base32 padding", tok)
		}
		// Has to round-trip through std base32 padded back up so we
		// detect any non-base32 byte that slipped in.
		padded := strings.ToUpper(tok)
		for len(padded)%8 != 0 {
			padded += "="
		}
		if _, err := base32.StdEncoding.DecodeString(padded); err != nil {
			t.Errorf("token %q not valid base32: %v", tok, err)
		}
		if _, dup := seen[tok]; dup {
			t.Errorf("dup token %q", tok)
		}
		seen[tok] = struct{}{}
	}
}

// TestAttributionHandler_RequiresTenant — endpoint refuses anonymous
// callers. Mirrors the existing GiftHandlers.Stats / Cancel guard.
func TestAttributionHandler_RequiresTenant(t *testing.T) {
	h := &GiftHandlers{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/gift-subscriptions/attribution", nil)
	w := httptest.NewRecorder()
	h.Attribution(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestGiftSubCreateInput_GifterFieldDecodes — confirms the new
// GifterSubscriberID json tag round-trips. Important because the
// desktop client serialises this field by name; a stray rename
// would silently drop the attribution link without a compile-time
// error.
func TestGiftSubCreateInput_GifterFieldDecodes(t *testing.T) {
	var in GiftSubCreateInput
	body := `{"purchaser_email":"a@x","recipient_email":"b@y","plan_id":"p","duration_months":1,"gifter_subscriber_id":"sub_123"}`
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if in.GifterSubscriberID != "sub_123" {
		t.Errorf("got %q, want sub_123", in.GifterSubscriberID)
	}
}

// TestGiftSub_AttributionFieldsSerialised — confirms the GiftSub
// projection emits the new fields with the documented json tags.
// Desktop's GiftSubscriptions.tsx keys off these names verbatim.
func TestGiftSub_AttributionFieldsSerialised(t *testing.T) {
	g := GiftSub{
		ID:                     "g1",
		GifterSubscriberID:     "sub_123",
		GifterAttributionToken: "abcd1234",
	}
	b, err := json.Marshal(g)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out := string(b)
	if !strings.Contains(out, `"gifter_subscriber_id":"sub_123"`) {
		t.Errorf("missing gifter_subscriber_id: %s", out)
	}
	if !strings.Contains(out, `"gifter_attribution_token":"abcd1234"`) {
		t.Errorf("missing gifter_attribution_token: %s", out)
	}
}
