package postwave

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewClientWiresResources(t *testing.T) {
	c := New("pw_test_key")
	if c.Campaigns == nil || c.Lists == nil || c.Segments == nil || c.Events == nil {
		t.Fatal("new marketing resources must be wired on the client")
	}
}

func TestCampaignsSendHitsRightPath(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"queued"}`))
	}))
	defer srv.Close()

	c := New("pw_test_key", WithBaseURL(srv.URL))
	out, err := c.Campaigns.Send(context.Background(), "camp_123")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotMethod != "POST" || gotPath != "/api/v1/campaigns/camp_123/send" {
		t.Fatalf("wrong request: %s %s", gotMethod, gotPath)
	}
	if gotAuth == "" {
		t.Fatal("Authorization header must be set from the api key")
	}
	if out["status"] != "queued" {
		t.Fatalf("unexpected body: %v", out)
	}
}

func TestEventsTrack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/events" || r.Method != "POST" {
			t.Errorf("wrong route: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer srv.Close()
	c := New("k", WithBaseURL(srv.URL))
	if _, err := c.Events.Track(context.Background(), map[string]any{"name": "purchase", "email": "a@b.com"}); err != nil {
		t.Fatalf("Track: %v", err)
	}
}
