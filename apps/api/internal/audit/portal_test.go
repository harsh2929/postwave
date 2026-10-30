// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// fixedNow returns a deterministic clock for the table-driven tests.
func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestEncodeDecodeJWT_RoundTrip(t *testing.T) {
	secret := []byte("portal-test-secret-bytes")
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	payload := SessionPayload{
		TenantID:  "11111111-1111-1111-1111-111111111111",
		Scope:     PortalScope,
		SessionID: "sess-abc",
		Purpose:   portalPurposeBootstrap,
		IssuedAt:  t0,
		ExpiresAt: t0.Add(30 * time.Minute),
	}
	tok, err := encodeJWT(secret, payload)
	if err != nil {
		t.Fatalf("encodeJWT: %v", err)
	}
	if strings.Count(tok, ".") != 2 {
		t.Fatalf("expected JWT compact form (3 segments), got %q", tok)
	}
	got, err := decodeJWT(secret, tok)
	if err != nil {
		t.Fatalf("decodeJWT: %v", err)
	}
	if got.TenantID != payload.TenantID {
		t.Errorf("tenant mismatch: %s vs %s", got.TenantID, payload.TenantID)
	}
	if got.Scope != PortalScope {
		t.Errorf("scope mismatch: %s", got.Scope)
	}
	if got.SessionID != payload.SessionID {
		t.Errorf("sid mismatch: %s", got.SessionID)
	}
	if !got.ExpiresAt.Equal(payload.ExpiresAt) {
		t.Errorf("exp mismatch: got %v want %v", got.ExpiresAt, payload.ExpiresAt)
	}
}

func TestDecodeJWT_RejectsBadSig(t *testing.T) {
	good := []byte("real-secret")
	bad := []byte("forged-secret")
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	tok, err := encodeJWT(good, SessionPayload{
		TenantID: "t1", Scope: PortalScope,
		SessionID: "s1", Purpose: portalPurposeBootstrap, IssuedAt: t0, ExpiresAt: t0.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("encodeJWT: %v", err)
	}
	if _, err := decodeJWT(bad, tok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken on forged signature, got %v", err)
	}
}

func TestDecodeJWT_RejectsTamperedPayload(t *testing.T) {
	secret := []byte("real-secret")
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	tok, _ := encodeJWT(secret, SessionPayload{
		TenantID: "tenant-A", Scope: PortalScope,
		SessionID: "s1", Purpose: portalPurposeBootstrap, IssuedAt: t0, ExpiresAt: t0.Add(time.Hour),
	})
	parts := strings.Split(tok, ".")
	// Swap the payload segment — signature is now invalid against
	// the swapped bytes.
	other, _ := encodeJWT(secret, SessionPayload{
		TenantID: "tenant-B", Scope: PortalScope,
		SessionID: "s2", Purpose: portalPurposeBootstrap, IssuedAt: t0, ExpiresAt: t0.Add(time.Hour),
	})
	otherParts := strings.Split(other, ".")
	forged := parts[0] + "." + otherParts[1] + "." + parts[2]
	if _, err := decodeJWT(secret, forged); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken on tampered payload, got %v", err)
	}
}

func TestDecodeJWT_RejectsMalformed(t *testing.T) {
	cases := []string{
		"",
		"only.two",
		"a.b.c.d",
		"not-base64.payload.sig",
	}
	for _, c := range cases {
		if _, err := decodeJWT([]byte("k"), c); err == nil {
			t.Errorf("expected error for malformed input %q", c)
		}
	}
}

func TestCreatePortalSession_DefaultsAndOrigin(t *testing.T) {
	deps := &PortalSessionDeps{
		Secret:    []byte("k"),
		NowFn:     fixedNow(time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)),
		OriginURL: "https://app.postwave.io/",
	}
	out, err := CreatePortalSession(context.Background(), deps, CreatePortalSessionInput{
		TenantID: "tenant-1",
	})
	if err != nil {
		t.Fatalf("CreatePortalSession: %v", err)
	}
	if !strings.HasPrefix(out.PortalURL, "https://app.postwave.io/portal/audit#bootstrap=") {
		t.Errorf("portal URL: got %s", out.PortalURL)
	}
	if !strings.Contains(out.PortalURL, out.Token) {
		t.Errorf("portal URL should include token")
	}
	// TTL defaults to DefaultSessionTTL.
	wantExp := deps.now().UTC().Add(DefaultSessionTTL)
	if out.ExpiresAt.Sub(wantExp).Abs() > time.Second {
		t.Errorf("expires_at not aligned with default TTL: got %v want %v",
			out.ExpiresAt, wantExp)
	}
}

func TestCreatePortalSession_TTLClamped(t *testing.T) {
	deps := &PortalSessionDeps{
		Secret: []byte("k"),
		NowFn:  fixedNow(time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)),
	}
	out, err := CreatePortalSession(context.Background(), deps, CreatePortalSessionInput{
		TenantID: "tenant-1",
		TTL:      72 * time.Hour, // > MaxSessionTTL (24h)
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	span := out.ExpiresAt.Sub(deps.now().UTC())
	if span > MaxSessionTTL+time.Minute {
		t.Errorf("TTL not clamped to MaxSessionTTL: span=%v", span)
	}
}

func TestCreatePortalSession_RejectsMissingTenant(t *testing.T) {
	deps := &PortalSessionDeps{Secret: []byte("k")}
	if _, err := CreatePortalSession(context.Background(), deps, CreatePortalSessionInput{}); err == nil {
		t.Fatal("expected error on empty tenant id")
	}
}

func TestCreatePortalSession_RequiresSecret(t *testing.T) {
	deps := &PortalSessionDeps{} // no secret, no env
	// Make sure env doesn't leak through (test process may have it set).
	t.Setenv("POSTWAVE_PORTAL_JWT_SECRET", "")
	_, err := CreatePortalSession(context.Background(), deps, CreatePortalSessionInput{TenantID: "t1"})
	if !errors.Is(err, ErrSecretUnset) {
		t.Fatalf("expected ErrSecretUnset, got %v", err)
	}
}

func TestValidatePortalSessionJWT_ExpiredReturnsRevoked(t *testing.T) {
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	// Mint at t0 with 30m TTL.
	mintDeps := &PortalSessionDeps{Secret: []byte("k"), NowFn: fixedNow(t0)}
	out, err := CreatePortalSession(context.Background(), mintDeps, CreatePortalSessionInput{
		TenantID: "tenant-1", TTL: 30 * time.Minute,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Validate at t0 + 1h — should be revoked-by-expiry.
	verifyDeps := &PortalSessionDeps{Secret: []byte("k"), NowFn: fixedNow(t0.Add(time.Hour))}
	_, err = ValidatePortalSessionJWT(context.Background(), verifyDeps, out.Token)
	if !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("expected ErrSessionRevoked on expired token, got %v", err)
	}
}

func TestValidatePortalSessionJWT_BadSigReturnsInvalid(t *testing.T) {
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	mintDeps := &PortalSessionDeps{Secret: []byte("good"), NowFn: fixedNow(t0)}
	out, err := CreatePortalSession(context.Background(), mintDeps, CreatePortalSessionInput{TenantID: "t1"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	wrongDeps := &PortalSessionDeps{Secret: []byte("bad"), NowFn: fixedNow(t0)}
	_, err = ValidatePortalSessionJWT(context.Background(), wrongDeps, out.Token)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken on bad sig, got %v", err)
	}
}

func TestBuildPortalURL(t *testing.T) {
	tt := []struct {
		origin string
		want   string
	}{
		{"", "/portal/audit#bootstrap=abc"},
		{"https://app.postwave.io", "https://app.postwave.io/portal/audit#bootstrap=abc"},
		{"https://app.postwave.io/", "https://app.postwave.io/portal/audit#bootstrap=abc"},
		{"  https://x.example  ", "https://x.example/portal/audit#bootstrap=abc"},
	}
	for _, c := range tt {
		got := BuildPortalURL(c.origin, "abc")
		if got != c.want {
			t.Errorf("BuildPortalURL(%q): got %q want %q", c.origin, got, c.want)
		}
	}
}

func TestHashToken_StableSHA256(t *testing.T) {
	first := hashToken("abc")
	second := hashToken("abc")
	if first != second {
		t.Fatal("hashToken not deterministic")
	}
	if hashToken("abc") == hashToken("abd") {
		t.Fatal("hashToken collision on trivial input")
	}
}
