// SPDX-License-Identifier: AGPL-3.0-only
//
// Validation-path tests for the magic-link handlers. These exercise the
// branches BEFORE any DB call (bad JSON, missing email, missing token)
// so they don't need a live Postgres. The success paths are covered
// by the integration tests under /apps/api/integration.
package auth

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// emptyDeps returns a Deps with everything nil-but-safe for handlers
// that should reject input before reaching Repo / Mailer.
func emptyDeps() *Deps {
	return &Deps{}
}

func postJSON(t *testing.T, h http.HandlerFunc, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/", &buf)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// postRaw sends a raw body (used for the malformed-JSON case).
func postRaw(t *testing.T, h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// readErrCode pulls the {error:{code}} field from a writeErr response.
func readErrCode(t *testing.T, body io.Reader) string {
	t.Helper()
	var resp struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(body).Decode(&resp); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return resp.Error.Code
}

func TestMagicLinkStart_BadJSON(t *testing.T) {
	d := emptyDeps()
	rec := postRaw(t, d.MagicLinkStart, "{not-json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "bad_json" {
		t.Errorf("code: got %q, want bad_json", got)
	}
}

func TestMagicLinkStart_RejectsOversizedBody(t *testing.T) {
	d := emptyDeps()
	rec := postRaw(t, d.MagicLinkStart, `{"email":"`+strings.Repeat("x", int(authJSONMaxBodyBytes))+`@example.com"}`)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: got %d, want 413", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "payload_too_large" {
		t.Errorf("code: got %q, want payload_too_large", got)
	}
}

func TestMagicLinkStart_InvalidEmail(t *testing.T) {
	d := emptyDeps()
	cases := []struct{ name, email string }{
		{"empty", ""},
		{"whitespace", "   "},
		{"missing-at", "not-an-email"},
		{"trailing-dot", "user@"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := postJSON(t, d.MagicLinkStart, MagicLinkStartInput{Email: tc.email})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: got %d, want 400", rec.Code)
			}
			if got := readErrCode(t, rec.Body); got != "invalid_email" {
				t.Errorf("code: got %q, want invalid_email", got)
			}
		})
	}
}

func TestMagicLinkStart_InvalidState(t *testing.T) {
	d := emptyDeps()
	rec := postJSON(t, d.MagicLinkStart, MagicLinkStartInput{
		Email: "user@example.com",
		AuthLinkStartFields: AuthLinkStartFields{
			LinkVersion:  authLinkVersion,
			LinkAudience: authLinkAudienceMobile,
			State:        strings.Repeat("x", magicLinkStateMaxBytes+1),
		},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "invalid_link_contract" {
		t.Errorf("code: got %q, want invalid_link_contract", got)
	}
}

func testAuthLinkProof(t *testing.T, key []byte, token, flow, audience, state string) AuthLinkProofFields {
	t.Helper()
	binding := authLinkBinding{
		Version:  authLinkVersion,
		Flow:     flow,
		Audience: audience,
		State:    state,
	}
	signature, err := signAuthLink(key, token, binding)
	if err != nil {
		t.Fatal(err)
	}
	return AuthLinkProofFields{
		LinkVersion:   authLinkVersion,
		LinkFlow:      flow,
		LinkAudience:  audience,
		State:         state,
		LinkSignature: signature,
	}
}

func TestAuthLinkV1ProofBindsFlowAudienceStateAndToken(t *testing.T) {
	key := []byte("test-auth-link-signing-key-32-bytes-minimum")
	proof := testAuthLinkProof(
		t,
		key,
		"one-time-token",
		authLinkFlowMagic,
		authLinkAudienceMobile,
		"device-state",
	)
	d := &Deps{AuthLinkSigningKey: key}
	if err := d.verifyAuthLinkProof("one-time-token", authLinkFlowMagic, proof); err != nil {
		t.Fatalf("valid v1 proof rejected: %v", err)
	}
	for name, mutate := range map[string]func(*AuthLinkProofFields){
		"audience": func(p *AuthLinkProofFields) { p.LinkAudience = authLinkAudienceWeb },
		"state":    func(p *AuthLinkProofFields) { p.State = "other-device" },
		"flow":     func(p *AuthLinkProofFields) { p.LinkFlow = authLinkFlowReset },
		"signature": func(p *AuthLinkProofFields) {
			p.LinkSignature = strings.Repeat("A", 43)
		},
	} {
		t.Run(name, func(t *testing.T) {
			tampered := proof
			mutate(&tampered)
			if err := d.verifyAuthLinkProof("one-time-token", authLinkFlowMagic, tampered); err == nil {
				t.Fatal("tampered auth-link proof was accepted")
			}
		})
	}
	if err := d.verifyAuthLinkProof("other-token", authLinkFlowMagic, proof); err == nil {
		t.Fatal("proof was not bound to its one-time token")
	}
}

func TestVersionedAuthPublicLinkEchoesSignedMobileState(t *testing.T) {
	key := []byte("test-auth-link-signing-key-32-bytes-minimum")
	d := &Deps{
		PublicBaseURL:      "https://app.moosewave.com",
		AuthLinkSigningKey: key,
	}
	got, err := d.buildVersionedAuthPublicLink(
		"/reset-password",
		"reset-token",
		authLinkFlowReset,
		authLinkBinding{
			Version:  authLinkVersion,
			Audience: authLinkAudienceMobile,
			State:    "device-state",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	q := parsed.Query()
	if parsed.Path != "/reset-password" ||
		q.Get("token") != "reset-token" ||
		q.Get("v") != "1" ||
		q.Get("flow") != authLinkFlowReset ||
		q.Get("aud") != authLinkAudienceMobile ||
		q.Get("state") != "device-state" ||
		q.Get("sig") == "" {
		t.Fatalf("unexpected v1 reset URL: %s", got)
	}
	proof := AuthLinkProofFields{
		LinkVersion:   authLinkVersion,
		LinkFlow:      q.Get("flow"),
		LinkAudience:  q.Get("aud"),
		State:         q.Get("state"),
		LinkSignature: q.Get("sig"),
	}
	if err := d.verifyAuthLinkProof(q.Get("token"), authLinkFlowReset, proof); err != nil {
		t.Fatalf("generated URL proof did not verify: %v", err)
	}
}

func TestMagicLinkConsume_BadJSON(t *testing.T) {
	d := emptyDeps()
	rec := postRaw(t, d.MagicLinkConsume, "{")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
	if got := readErrCode(t, rec.Body); got != "bad_json" {
		t.Errorf("code: got %q, want bad_json", got)
	}
}

func TestMagicLinkConsume_MissingToken(t *testing.T) {
	d := emptyDeps()
	cases := []string{"", "   ", "\t\n"}
	for _, tok := range cases {
		t.Run(tok, func(t *testing.T) {
			rec := postJSON(t, d.MagicLinkConsume, MagicLinkConsumeInput{Token: tok})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status: got %d, want 400", rec.Code)
			}
			if got := readErrCode(t, rec.Body); got != "missing_token" {
				t.Errorf("code: got %q, want missing_token", got)
			}
		})
	}
}

// magicLinkTTL is documented as 5 minutes; lock the value with a test
// so a future drive-by edit doesn't silently extend the window.
func TestMagicLinkTTL_Constant(t *testing.T) {
	if magicLinkTTL.Minutes() != 5 {
		t.Errorf("magicLinkTTL drifted: got %v, want 5m", magicLinkTTL)
	}
}
