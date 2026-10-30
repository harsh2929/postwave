// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// SUB-043: the public lookup response serialises the GPC acknowledgement as a
// stable "gpc" boolean the hosted preference page reads.
func TestPublicLookupResponse_GPCJSONContract(t *testing.T) {
	resp := PublicLookupResponse{
		Email:     "a@b.com",
		ExpiresAt: time.Unix(0, 0).UTC(),
		Topics:    []PublicSubscriberTopicView{},
		GPC:       true,
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	v, ok := decoded["gpc"]
	if !ok {
		t.Fatalf("response is missing the gpc key: %s", raw)
	}
	if b, ok := v.(bool); !ok || !b {
		t.Fatalf("gpc = %v (%T), want true", v, v)
	}
}

func TestPublicLookupResponse_MinimizesTopicMetadata(t *testing.T) {
	t.Parallel()
	resp := PublicLookupResponse{
		Email:     "reader@example.com",
		ExpiresAt: time.Date(2026, time.September, 30, 12, 0, 0, 0, time.UTC),
		Topics: []PublicSubscriberTopicView{{
			Topic: PublicTopic{
				ID:           "22222222-2222-4222-8222-222222222222",
				Slug:         "product-updates",
				Name:         "Product updates",
				Description:  "Release notes",
				DefaultOptIn: true,
				DisplayOrder: 1,
			},
			OptedIn: true,
		}},
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	topics, ok := decoded["topics"].([]any)
	if !ok || len(topics) != 1 {
		t.Fatalf("topics = %#v, want one row", decoded["topics"])
	}
	selection, ok := topics[0].(map[string]any)
	if !ok {
		t.Fatalf("selection = %#v", topics[0])
	}
	topic, ok := selection["topic"].(map[string]any)
	if !ok {
		t.Fatalf("topic = %#v", selection["topic"])
	}
	for _, forbidden := range []string{"tenantId", "createdAt", "updatedAt", "optedInCount", "optedOutCount"} {
		if _, leaked := topic[forbidden]; leaked {
			t.Fatalf("public topic leaked %q: %s", forbidden, raw)
		}
	}
}

// SUB-043: GPC defaults to false (omitted-but-present) so a subscriber without
// a recorded GPC signal sees no notice.
func TestPublicLookupResponse_GPCDefaultsFalse(t *testing.T) {
	raw, err := json.Marshal(PublicLookupResponse{Email: "a@b.com"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if v, ok := decoded["gpc"]; !ok || v != false {
		t.Fatalf("gpc = %v, ok=%v, want present-and-false", v, ok)
	}
}

// SUB-043: a missing token short-circuits with 400 before any repo / DB access,
// so the GPC fetch is never reached without a validated token.
func TestPublicLookup_MissingTokenIs400(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	// No chi route context → chi.URLParam returns "" → the missing_token guard
	// fires before LookupToken / PublicTrackingPrefsGPC touch the nil pool.
	d.PublicLookup(rec, httptest.NewRequest(http.MethodGet, "/api/public/preferences/", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
