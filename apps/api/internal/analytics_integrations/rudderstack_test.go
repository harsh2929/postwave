// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import "testing"

func TestMapRudderStackIdentify(t *testing.T) {
	body := []byte(`{
		"type":"identify","messageId":"m1","userId":"u1","anonymousId":"a1",
		"traits":{"email":"User@Example.com","firstName":"Ada","lastName":"L","phone":"555"},
		"timestamp":"2026-06-20T10:00:00.000Z"
	}`)
	req, ok := mapRudderStackEvent(body)
	if !ok {
		t.Fatal("identify should map")
	}
	if len(req.Profiles) != 1 || len(req.Events) != 0 {
		t.Fatalf("req = %+v", req)
	}
	p := req.Profiles[0]
	if p.Email != "user@example.com" || p.UserID != "u1" || p.FirstName != "Ada" {
		t.Fatalf("profile = %+v", p)
	}
	if p.SourceID != "rudderstack://identify/m1" {
		t.Fatalf("source id = %q", p.SourceID)
	}
}

func TestMapRudderStackTrack(t *testing.T) {
	body := []byte(`{
		"type":"track","messageId":"m2","userId":"u1","event":"Order Completed",
		"properties":{"total":50,"email":"Buyer@Example.com"},
		"timestamp":"2026-06-20T11:00:00Z"
	}`)
	req, ok := mapRudderStackEvent(body)
	if !ok {
		t.Fatal("track should map")
	}
	if len(req.Events) != 1 {
		t.Fatalf("req = %+v", req)
	}
	e := req.Events[0]
	if e.Email != "buyer@example.com" || e.EventName != "Order Completed" {
		t.Fatalf("event = %+v", e)
	}
	if e.SourceID != "rudderstack://track/m2" {
		t.Fatalf("source id = %q", e.SourceID)
	}
}

func TestMapRudderStackUnknownTypeSkipped(t *testing.T) {
	if _, ok := mapRudderStackEvent([]byte(`{"type":"page","messageId":"m4"}`)); ok {
		t.Fatal("page event type should be skipped")
	}
}

func TestVerifyRudderStackSecret(t *testing.T) {
	// Empty configured secret = verification disabled (RudderStack webhook auth
	// is an optional custom header); must not error.
	if err := VerifyRudderStackSecret("", ""); err != nil {
		t.Fatalf("disabled verification should pass: %v", err)
	}
	if err := VerifyRudderStackSecret("tok123", "tok123"); err != nil {
		t.Fatalf("matching secret rejected: %v", err)
	}
	if err := VerifyRudderStackSecret("tok123", "Bearer tok123"); err != nil {
		t.Fatalf("matching Bearer secret rejected: %v", err)
	}
	if err := VerifyRudderStackSecret("tok123", "wrong"); err == nil {
		t.Fatal("wrong secret accepted")
	}
	if err := VerifyRudderStackSecret("tok123", ""); err == nil {
		t.Fatal("missing header accepted when secret configured")
	}
}
