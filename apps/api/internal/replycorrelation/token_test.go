// SPDX-License-Identifier: AGPL-3.0-only

package replycorrelation

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	testTenant   = "11111111-1111-4111-8111-111111111111"
	testCampaign = "22222222-2222-4222-8222-222222222222"
	testDelivery = "33333333-3333-4333-8333-333333333333"
)

func TestMintIsCompactOpaqueDeterministicAndLedgerBound(t *testing.T) {
	issuedAt := time.Date(2026, 8, 13, 8, 0, 0, 0, time.UTC)
	now := issuedAt.Add(time.Hour)
	service := testService(t, now)
	input := MintInput{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery, IssuedAt: issuedAt}
	first, err := service.Mint(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Mint(input)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("mint replay drifted: %#v != %#v", first, second)
	}
	local := strings.Split(first.Address, "@")[0]
	if len(local) > MaxLocalPartBytes || len(local) != 62 {
		t.Fatalf("local-part bytes = %d, want 62 and <= 64", len(local))
	}
	for _, forbidden := range []string{testTenant, testCampaign, testDelivery, "@example"} {
		if strings.Contains(first.Address, forbidden) {
			t.Fatalf("opaque address leaked %q: %s", forbidden, first.Address)
		}
	}
	binding := Binding{
		TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery,
		Address: first.Address, TokenHash: first.TokenHash, Version: first.Version,
		KeyID: first.KeyID, ExpiresAt: first.ExpiresAt,
	}
	if err := service.Verify(first.Address, binding); err != nil {
		t.Fatalf("verify: %v", err)
	}
	for name, mutate := range map[string]func(*Binding){
		"tenant":   func(value *Binding) { value.TenantID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
		"campaign": func(value *Binding) { value.CampaignID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
		"delivery": func(value *Binding) { value.DeliveryID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
		"key":      func(value *Binding) { value.KeyID = "unknown" },
		"hash":     func(value *Binding) { value.TokenHash = strings.Repeat("0", 64) },
		"expiry":   func(value *Binding) { value.ExpiresAt = value.ExpiresAt.Add(time.Second) },
	} {
		t.Run(name, func(t *testing.T) {
			changed := binding
			mutate(&changed)
			if err := service.Verify(first.Address, changed); !errors.Is(err, ErrBindingMismatch) {
				t.Fatalf("verify changed binding = %v, want mismatch", err)
			}
		})
	}
}

func TestRotationSchedulePinsIssuedAtAndRetainsOldVerification(t *testing.T) {
	boundary := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	now := boundary.Add(time.Hour)
	keys := []Key{
		{ID: "k1", Secret: []byte(strings.Repeat("a", 32)), NotBefore: boundary.Add(-180 * 24 * time.Hour), NotAfter: boundary},
		{ID: "k2", Secret: []byte(strings.Repeat("b", 32)), NotBefore: boundary, NotAfter: boundary.Add(180 * 24 * time.Hour)},
	}
	service, err := NewService("reply.example.test", 120*24*time.Hour, keys, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	old, err := service.Mint(MintInput{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery, IssuedAt: boundary.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if old.KeyID != "k1" {
		t.Fatalf("old key = %q", old.KeyID)
	}
	current, err := service.Mint(MintInput{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: "44444444-4444-4444-8444-444444444444", IssuedAt: boundary})
	if err != nil {
		t.Fatal(err)
	}
	if current.KeyID != "k2" {
		t.Fatalf("current key = %q", current.KeyID)
	}
	if err := service.Verify(old.Address, Binding{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery, Address: old.Address, TokenHash: old.TokenHash, Version: old.Version, KeyID: old.KeyID, ExpiresAt: old.ExpiresAt}); err != nil {
		t.Fatalf("retained old-key verification: %v", err)
	}
	keys[1].NotBefore = boundary.Add(-time.Second)
	if _, err := NewService("reply.example.test", DefaultTTL, keys, nil); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("overlap error = %v", err)
	}
}

func TestExpiredAndForgedTokensFailClosed(t *testing.T) {
	issuedAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	service := testService(t, issuedAt.Add(DefaultTTL-time.Hour))
	correlation, err := service.Mint(MintInput{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery, IssuedAt: issuedAt})
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{TenantID: testTenant, CampaignID: testCampaign, DeliveryID: testDelivery, Address: correlation.Address, TokenHash: correlation.TokenHash, Version: correlation.Version, KeyID: correlation.KeyID, ExpiresAt: correlation.ExpiresAt}
	service.now = func() time.Time { return correlation.ExpiresAt }
	if err := service.Verify(correlation.Address, binding); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired verify = %v", err)
	}
	service.now = func() time.Time { return correlation.ExpiresAt.Add(-time.Hour) }
	parts := strings.Split(correlation.Address, "@")
	forged := parts[0][:len(parts[0])-1] + "a@" + parts[1]
	if forged == correlation.Address {
		forged = parts[0][:len(parts[0])-1] + "b@" + parts[1]
	}
	if err := service.Verify(forged, binding); err == nil {
		t.Fatal("forged address verified")
	}
}

func TestParseConfigRejectsUnknownFieldsAndWeakSecrets(t *testing.T) {
	secret := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32)))
	valid := `{"version":"postwave.reply-correlation-keyring.v1","keys":[{"id":"k1","secret_base64":"` + secret + `","not_before":"2026-01-01T00:00:00Z","not_after":"2027-01-01T00:00:00Z"}]}`
	if _, err := ParseConfig(valid, "reply.example.test", DefaultTTL); err != nil {
		t.Fatalf("valid config: %v", err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"keys"`, `"unknown":true,"keys"`, 1),
		strings.Replace(valid, secret, base64.StdEncoding.EncodeToString([]byte("weak")), 1),
		strings.Replace(valid, `"k1"`, `"UPPER"`, 1),
	} {
		if _, err := ParseConfig(raw, "reply.example.test", DefaultTTL); !errors.Is(err, ErrInvalidConfiguration) {
			t.Fatalf("invalid config error = %v", err)
		}
	}
}

func testService(t *testing.T, now time.Time) *Service {
	t.Helper()
	service, err := NewService("reply.example.test", DefaultTTL, []Key{{
		ID: "k1", Secret: []byte(strings.Repeat("s", 32)),
		NotBefore: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:  time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
	}}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return service
}
