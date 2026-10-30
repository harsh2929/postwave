// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestFlattenHeadersNeverPersistsCredentialsOrArbitraryHeaders(t *testing.T) {
	headers := http.Header{
		"Authorization":        []string{"Bearer bearer-secret-value"},
		"Cookie":               []string{"session=session-secret-value"},
		"X-Api-Key":            []string{"api-key-secret-value"},
		"X-Postwave-Signature": []string{"signature-secret-value"},
		"X-Custom-Auth":        []string{"custom-secret-value"},
		"Content-Type":         []string{"application/json"},
		"User-Agent":           []string{"ExampleSender/1.0"},
		"X-Postwave-Event-Id":  []string{"customer@example.com:event-123"},
	}

	got := flattenHeaders(headers)
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal sanitized headers: %v", err)
	}
	serialized := string(encoded)
	for _, secret := range []string{
		"bearer-secret-value",
		"session-secret-value",
		"api-key-secret-value",
		"signature-secret-value",
		"custom-secret-value",
		"customer@example.com",
		"event-123",
	} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("sanitized headers leaked %q: %s", secret, serialized)
		}
	}
	for _, name := range []string{
		"Authorization",
		"Cookie",
		"X-Api-Key",
		"X-Postwave-Signature",
	} {
		if got[name] != inboundRedactedHeaderValue {
			t.Errorf("%s = %q, want redaction marker", name, got[name])
		}
	}
	if _, exists := got["X-Custom-Auth"]; exists {
		t.Fatal("arbitrary custom authentication header was retained")
	}
	if got["Content-Type"] != "application/json" || got["User-Agent"] != "ExampleSender/1.0" {
		t.Fatalf("safe troubleshooting headers not retained: %#v", got)
	}
	if value := got["X-Postwave-Event-Id"]; !strings.HasPrefix(value, "sha256:") || len(value) != len("sha256:")+16 {
		t.Fatalf("event identity = %q, want short SHA-256 fingerprint", value)
	}
}

func TestFlattenHeadersBoundsAndStripsControlCharacters(t *testing.T) {
	long := strings.Repeat("a", inboundStoredHeaderValueMaxBytes+100)
	headers := http.Header{
		"User-Agent":   []string{"Sender\r\nInjected"},
		"X-Request-Id": []string{long},
	}

	got := flattenHeaders(headers)
	if strings.ContainsAny(got["User-Agent"], "\r\n") {
		t.Fatalf("control characters retained: %q", got["User-Agent"])
	}
	if len(got["X-Request-Id"]) > inboundStoredHeaderValueMaxBytes+len("…") {
		t.Fatalf("bounded header too long: %d", len(got["X-Request-Id"]))
	}
	if !strings.HasSuffix(got["X-Request-Id"], "…") {
		t.Fatalf("bounded header did not signal truncation: %q", got["X-Request-Id"])
	}
}
