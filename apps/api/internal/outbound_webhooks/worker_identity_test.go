// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkerPostCarriesStableEventAndDeliveryIdentity(t *testing.T) {
	t.Parallel()

	const (
		eventID    = "11111111-1111-4111-8111-111111111111"
		deliveryID = "22222222-2222-4222-8222-222222222222"
	)
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	worker := &Worker{HTTPClient: server.Client()}
	status, _, err := worker.post(
		context.Background(),
		server.URL,
		"v1=test",
		"key-1",
		"campaign.sent",
		eventID,
		deliveryID,
		[]byte(`{"event":{"id":"`+eventID+`","type":"campaign.sent"}}`),
		nil,
	)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if status != http.StatusNoContent {
		t.Fatalf("status = %d; want %d", status, http.StatusNoContent)
	}
	if value := got.Get(EventIDHeader); value != eventID {
		t.Errorf("%s = %q; want %q", EventIDHeader, value, eventID)
	}
	if value := got.Get(DeliveryHeader); value != deliveryID {
		t.Errorf("%s = %q; want %q", DeliveryHeader, value, deliveryID)
	}
	if value := got.Get(EventHeader); value != "campaign.sent" {
		t.Errorf("%s = %q; want campaign.sent", EventHeader, value)
	}
}

func TestWorkerPostAuthHeadersCannotOverrideStableIdentity(t *testing.T) {
	t.Parallel()

	const (
		eventID    = "33333333-3333-4333-8333-333333333333"
		deliveryID = "44444444-4444-4444-8444-444444444444"
	)
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	worker := &Worker{HTTPClient: server.Client()}
	_, _, err := worker.post(
		context.Background(),
		server.URL,
		"v1=test",
		"key-1",
		"campaign.sent",
		eventID,
		deliveryID,
		[]byte(`{"event":{"id":"`+eventID+`","type":"campaign.sent"}}`),
		&AuthConfig{Headers: map[string]string{
			EventIDHeader:  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			DeliveryHeader: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			"X-Receiver":   "present",
		}},
	)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if value := got.Get(EventIDHeader); value != eventID {
		t.Errorf("%s = %q; want stable source id %q", EventIDHeader, value, eventID)
	}
	if value := got.Get(DeliveryHeader); value != deliveryID {
		t.Errorf("%s = %q; want delivery id %q", DeliveryHeader, value, deliveryID)
	}
	if value := got.Get("X-Receiver"); value != "present" {
		t.Errorf("non-reserved receiver header = %q; want present", value)
	}
}

func TestApplyAuthConfigCannotDowngradeTestMarker(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodPost, "https://receiver.example/webhook", nil)
	req.Header.Set(TestHeader, "true")
	applyAuthConfig(req, &AuthConfig{Headers: map[string]string{
		TestHeader:   "false",
		"X-Receiver": "present",
	}})

	if value := req.Header.Get(TestHeader); value != "true" {
		t.Errorf("%s = %q; want true", TestHeader, value)
	}
	if value := req.Header.Get("X-Receiver"); value != "present" {
		t.Errorf("non-reserved receiver header = %q; want present", value)
	}
}
