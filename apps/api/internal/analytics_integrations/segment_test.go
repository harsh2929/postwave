// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"strings"
	"testing"
)

func TestMapSegmentIdentify(t *testing.T) {
	body := []byte(`{
		"type":"identify","messageId":"m1","userId":"u1","anonymousId":"a1",
		"traits":{"email":"User@Example.com","firstName":"Ada","lastName":"L","phone":"555"},
		"timestamp":"2026-06-20T10:00:00.000Z"
	}`)
	req, ok := mapSegmentEvent(body)
	if !ok {
		t.Fatal("identify should map")
	}
	if len(req.Profiles) != 1 || len(req.Events) != 0 {
		t.Fatalf("req = %+v", req)
	}
	p := req.Profiles[0]
	if p.Email != "user@example.com" || p.UserID != "u1" || p.AnonymousID != "a1" || p.FirstName != "Ada" || p.Phone != "555" {
		t.Fatalf("profile = %+v", p)
	}
	if p.SourceID != "segment://identify/m1" {
		t.Fatalf("source id = %q", p.SourceID)
	}
	if p.UpdatedAt == nil {
		t.Fatal("timestamp not parsed")
	}
}

func TestMapSegmentTrackWithContextEmail(t *testing.T) {
	body := []byte(`{
		"type":"track","messageId":"m2","userId":"u1","event":"Order Completed",
		"properties":{"total":50},
		"context":{"traits":{"email":"Buyer@Example.com"}},
		"timestamp":"2026-06-20T11:00:00Z"
	}`)
	req, ok := mapSegmentEvent(body)
	if !ok {
		t.Fatal("track should map")
	}
	if len(req.Events) != 1 || len(req.Profiles) != 0 {
		t.Fatalf("req = %+v", req)
	}
	e := req.Events[0]
	if e.Email != "buyer@example.com" || e.EventName != "Order Completed" || e.UserID != "u1" {
		t.Fatalf("event = %+v", e)
	}
	if e.SourceID != "segment://track/m2" {
		t.Fatalf("source id = %q", e.SourceID)
	}
}

func TestMapSegmentTrackWithoutIdentityIsSkipped(t *testing.T) {
	body := []byte(`{"type":"track","messageId":"m3","event":"Page","properties":{}}`)
	_, ok := mapSegmentEvent(body)
	if ok {
		t.Fatal("track without email/userId should not map")
	}
}

func TestMapSegmentUnknownTypeIsSkipped(t *testing.T) {
	body := []byte(`{"type":"page","messageId":"m4"}`)
	if _, ok := mapSegmentEvent(body); ok {
		t.Fatal("page event type should be skipped")
	}
}

func TestVerifySegmentSignatureRoundTrip(t *testing.T) {
	secret := "seg_shared_secret"
	body := []byte(`{"type":"identify"}`)
	sig := segmentTestSignature(secret, body)
	if err := VerifySegmentSignature(secret, body, sig); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := VerifySegmentSignature(secret, append(body, '!'), sig); err == nil {
		t.Fatal("tampered body accepted")
	}
	// Empty configured secret = verification disabled (Segment webhooks are
	// optional-signature); must not error.
	if err := VerifySegmentSignature("", body, ""); err != nil {
		t.Fatalf("disabled verification should pass: %v", err)
	}
}

func segmentTestSignature(secret string, body []byte) string {
	return segmentHexHMAC(secret, body)
}

func TestSegmentSignaturePrefixTolerated(t *testing.T) {
	secret := "s"
	body := []byte(`{}`)
	sig := "sha1=" + segmentHexHMAC(secret, body)
	if !strings.Contains(sig, "=") {
		t.Fatal("test setup did not construct a prefixed Segment signature")
	}
	if err := VerifySegmentSignature(secret, body, sig); err != nil {
		t.Fatalf("prefixed signature rejected: %v", err)
	}
}
