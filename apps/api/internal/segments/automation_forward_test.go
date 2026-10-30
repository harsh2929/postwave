// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPSegmentJoinForwarder_EmptyBaseURLIsNoop(t *testing.T) {
	f := &HTTPSegmentJoinForwarder{BaseURL: ""}
	if err := f.ForwardSegmentJoined(context.Background(), SegmentJoinEvent{TenantID: "t", SubscriberEmail: "a@b.com", SegmentID: "s"}); err != nil {
		t.Fatalf("empty base URL must be a no-op, got %v", err)
	}
}

func TestHTTPSegmentJoinForwarder_PostsCanonicalEnvelope(t *testing.T) {
	type captured struct {
		auth string
		body map[string]any
	}
	got := make(chan captured, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		got <- captured{auth: r.Header.Get("Authorization"), body: body}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := &HTTPSegmentJoinForwarder{BaseURL: srv.URL, InternalAPIToken: "secret"}
	ev := SegmentJoinEvent{TenantID: "tenant-9", SubscriberEmail: "joiner@x.com", SegmentID: "seg-42", At: time.Unix(1700000000, 0).UTC()}
	if err := f.ForwardSegmentJoined(context.Background(), ev); err != nil {
		t.Fatalf("forward: %v", err)
	}

	select {
	case c := <-got:
		if c.auth != "Bearer secret" {
			t.Errorf("auth header = %q; want Bearer secret", c.auth)
		}
		if c.body["event_type"] != SegmentJoinedEvent {
			t.Errorf("event_type = %v; want %s", c.body["event_type"], SegmentJoinedEvent)
		}
		if c.body["subscriber_email"] != "joiner@x.com" {
			t.Errorf("subscriber_email = %v", c.body["subscriber_email"])
		}
		if c.body["tenant_id"] != "tenant-9" {
			t.Errorf("tenant_id = %v", c.body["tenant_id"])
		}
		payload, ok := c.body["payload"].(map[string]any)
		if !ok {
			t.Fatalf("payload missing/typed wrong: %v", c.body["payload"])
		}
		if payload["segment_id"] != "seg-42" {
			t.Errorf("payload.segment_id = %v; want seg-42", payload["segment_id"])
		}
		if payload["event_name"] != SegmentJoinedEvent {
			t.Errorf("payload.event_name = %v", payload["event_name"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("forwarder did not POST")
	}
}
