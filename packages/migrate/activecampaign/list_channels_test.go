// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnsureListChannelsClassifiesEmailSMSAndCollisions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{
				"lists": []any{map[string]any{"id": "email"}, map[string]any{"id": "collision"}},
				"meta":  map[string]any{"total": 2},
			})
		case "/api/3/sms/lists":
			writeJSON(t, w, map[string]any{
				"lists": []any{map[string]any{"id": "collision"}, map[string]any{"id": "sms"}},
				"meta":  map[string]any{"total": 2},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.loadListChannelsForTests = true
	evidence, err := ad.ensureListChannels(context.Background(), activeCampaignTestSession(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.ListChannelInventoryComplete {
		t.Fatal("complete email and SMS inventories were marked incomplete")
	}
	if evidence.EmailExclusionInventoryComplete {
		t.Fatal("API list inventory was incorrectly treated as complete exclusion evidence")
	}
	if got := evidence.ListChannels["email"]; got != activeCampaignChannelEmail {
		t.Fatalf("email list channel = %q", got)
	}
	if got := evidence.ListChannels["sms"]; got != activeCampaignChannelSMS {
		t.Fatalf("SMS list channel = %q", got)
	}
	if got := evidence.ListChannels["collision"]; got != activeCampaignChannelUnknown {
		t.Fatalf("colliding list channel = %q, want fail-closed unknown", got)
	}
}

func TestEnsureListChannelsFailsClosedWhenSMSInventoryUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{"lists": []any{map[string]any{"id": "7"}}, "meta": map[string]any{"total": 1}})
		case "/api/3/sms/lists":
			http.Error(w, `{"message":"not enabled"}`, http.StatusForbidden)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.loadListChannelsForTests = true
	evidence, err := ad.ensureListChannels(context.Background(), activeCampaignTestSession(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ListChannelInventoryComplete {
		t.Fatal("missing SMS inventory was marked complete")
	}
	if evidence.EmailExclusionInventoryComplete {
		t.Fatal("missing exclusion evidence was marked complete")
	}
}
