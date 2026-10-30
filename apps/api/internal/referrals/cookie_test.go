// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestReferralCookieV2BindsOwnerAndExpires(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	value := signReferralCookie("code-1", "tenant-1", "subscriber-1", now.Add(time.Hour), "secret")
	if !strings.HasPrefix(value, "v2.") {
		t.Fatalf("cookie = %q, want v2", value)
	}
	code, tenantID, referrerID, legacy, err := parseReferralCookie(value, "secret", now)
	if err != nil || legacy || code != "code-1" || tenantID != "tenant-1" || referrerID != "subscriber-1" {
		t.Fatalf("parse = %q %q %q legacy=%v err=%v", code, tenantID, referrerID, legacy, err)
	}
	if _, _, _, _, err := parseReferralCookie(value, "secret", now.Add(time.Hour)); err == nil {
		t.Fatal("cookie must be invalid at its expiry instant")
	}
}

func TestReferralCookieRejectsLegacyWhenSigningConfigured(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	if _, _, _, _, err := parseReferralCookie("plain-code", "secret", now); err == nil {
		t.Fatal("unsigned cookie accepted while signing secret is configured")
	}
	legacyV1 := "v1." + b64("code") + "." + b64("tenant") + "." + "1900000000.deadbeef"
	if _, _, _, _, err := parseReferralCookie(legacyV1, "secret", now); err == nil {
		t.Fatal("owner-unbound v1 cookie accepted")
	}
	code, tenantID, referrerID, legacy, err := parseReferralCookie("plain-code", "", now)
	if err != nil || !legacy || code != "plain-code" || tenantID != "" || referrerID != "" {
		t.Fatalf("secret-less local legacy parse = %q %q %q legacy=%v err=%v", code, tenantID, referrerID, legacy, err)
	}
}

func TestReferralCookieRejectsOwnerTampering(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	value := signReferralCookie("code", "tenant", "subscriber", now.Add(time.Hour), "secret")
	parts := strings.Split(value, ".")
	parts[3] = b64("other-subscriber")
	if _, _, _, _, err := parseReferralCookie(strings.Join(parts, "."), "secret", now); err == nil {
		t.Fatal("tampered referrer subscriber accepted")
	}
}

func TestReferralFraudScoreRejectsSelfReferral(t *testing.T) {
	r := &Repo{}
	score, err := r.computeFraudScore(context.Background(), "tenant", "subscriber", "subscriber", "")
	if err != nil {
		t.Fatal(err)
	}
	if score != 1 {
		t.Fatalf("self-referral score = %v, want 1", score)
	}
}
