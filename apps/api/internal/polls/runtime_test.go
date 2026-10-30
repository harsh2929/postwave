// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func encodedTestKeyring(now time.Time, secret []byte) string {
	return fmt.Sprintf(`{"active_key_id":"poll-2026-08","token_ttl_seconds":2592000,"keys":[{"id":"poll-2026-08","secret_b64":"%s","mint_not_before":"%s","mint_not_after":"%s","verify_not_after":"%s"}]}`,
		base64.RawURLEncoding.EncodeToString(secret),
		now.Add(-time.Hour).UTC().Format(time.RFC3339),
		now.Add(45*24*time.Hour).UTC().Format(time.RFC3339),
		now.Add(90*24*time.Hour).UTC().Format(time.RFC3339))
}

func TestRuntimeConfigurationIsDefaultClosedAndRequiresBoundedKeyring(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)

	disabled, err := runtimeConfigurationFromEnvironmentAt(func(string) string { return "" }, now)
	if err != nil || disabled.Enabled {
		t.Fatalf("default configuration=%+v err=%v, want disabled", disabled, err)
	}

	_, err = runtimeConfigurationFromEnvironmentAt(func(key string) string {
		if key == RuntimeFeatureEnvironmentKey {
			return "true"
		}
		if key == RuntimeSecretEnvironmentKey {
			return "legacy-static-secret-must-not-be-accepted"
		}
		return ""
	}, now)
	if !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("enabled runtime with legacy forever-secret err=%v", err)
	}

	secret := []byte("dedicated-poll-token-secret-32-bytes-minimum")
	enabled, err := runtimeConfigurationFromEnvironmentAt(func(key string) string {
		switch key {
		case RuntimeFeatureEnvironmentKey:
			return "true"
		case RuntimeKeyringEnvironmentKey:
			return encodedTestKeyring(now, secret)
		case RuntimePublicBaseEnvironmentKey:
			return "https://api.example.test"
		default:
			return ""
		}
	}, now)
	if err != nil || !enabled.Enabled || enabled.TokenKeyring.ActiveKeyID != "poll-2026-08" ||
		enabled.PublicBaseURL != "https://api.example.test" {
		t.Fatalf("enabled configuration=%+v err=%v", enabled, err)
	}
	if err := enabled.ValidateDedicated("POSTWAVE_SENDING_KEK", secret); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("reused sending KEK err=%v, want invalid configuration", err)
	}
}

func TestPollTokenBindsTenantRevisionTimesAndRecipient(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	repo := &Repo{Pool: &db.Pool{}, TokenKeyring: testTokenKeyring(now), Now: func() time.Time { return now }}
	input := LinkTokenInput{
		TenantID: "11111111-1111-1111-1111-111111111111", PollKey: "launch",
		OptionKey: "yes", RecipientReference: "recipient-42",
		ContentRevisionID: "33333333-3333-3333-3333-333333333333",
		IssuedAt:          now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}
	first, err := repo.MintToken(input)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if _, err := repo.verifyLinkToken(first, input); err != nil {
		t.Fatalf("verify exact binding: %v", err)
	}
	mutations := map[string]func(*LinkTokenInput){
		"tenant":    func(value *LinkTokenInput) { value.TenantID = "22222222-2222-2222-2222-222222222222" },
		"revision":  func(value *LinkTokenInput) { value.ContentRevisionID = "44444444-4444-4444-4444-444444444444" },
		"poll":      func(value *LinkTokenInput) { value.PollKey = "other" },
		"option":    func(value *LinkTokenInput) { value.OptionKey = "no" },
		"recipient": func(value *LinkTokenInput) { value.RecipientReference = "recipient-43" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			changed := input
			mutate(&changed)
			if _, err := repo.verifyLinkToken(first, changed); !errors.Is(err, ErrUnknownToken) {
				t.Fatalf("changed binding err=%v, want ErrUnknownToken", err)
			}
		})
	}
}

func TestPollTokenRotationIsDeterministicAcrossCutoverAndRevocationFailsClosed(t *testing.T) {
	t.Parallel()
	cutover := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	now := cutover.Add(time.Hour)
	ring := TokenKeyring{ActiveKeyID: "new", TokenTTL: 24 * time.Hour, Keys: []TokenKey{
		{ID: "old", Secret: []byte("old-poll-token-secret-32-bytes-long"),
			MintNotBefore: cutover.Add(-30 * 24 * time.Hour), MintNotAfter: cutover,
			VerifyNotAfter: cutover.Add(7 * 24 * time.Hour)},
		{ID: "new", Secret: []byte("new-poll-token-secret-32-bytes-long"),
			MintNotBefore: cutover, MintNotAfter: cutover.Add(30 * 24 * time.Hour),
			VerifyNotAfter: cutover.Add(40 * 24 * time.Hour)},
	}}
	repo := &Repo{Pool: &db.Pool{}, TokenKeyring: ring, Now: func() time.Time { return now }}
	input := LinkTokenInput{
		TenantID: "11111111-1111-1111-1111-111111111111", PollKey: "launch",
		OptionKey: "yes", RecipientReference: "recipient-42",
		ContentRevisionID: "33333333-3333-3333-3333-333333333333",
		IssuedAt:          cutover.Add(-time.Hour), ExpiresAt: cutover.Add(12 * time.Hour),
	}
	first, err := repo.MintToken(input)
	if err != nil {
		t.Fatalf("mint pre-cutover retry: %v", err)
	}
	second, err := repo.MintToken(input)
	if err != nil || first != second {
		t.Fatalf("retry token drifted across cutover: equal=%v err=%v", first == second, err)
	}
	if !strings.HasPrefix(first, "pwpt3.old.") {
		t.Fatalf("pre-cutover issued_at did not select old key: %s", first)
	}
	revoked := now.Add(-time.Minute)
	repo.TokenKeyring.Keys[0].RevokedAt = &revoked
	if _, err := repo.verifyLinkToken(first, input); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("revoked key verified token: %v", err)
	}
}

func TestPollTokenExpiresAndFutureIssuedTokensFailClosed(t *testing.T) {
	t.Parallel()
	issuedAt := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	now := issuedAt
	repo := &Repo{
		Pool:         &db.Pool{},
		TokenKeyring: testTokenKeyring(issuedAt),
		Now:          func() time.Time { return now },
	}
	input := LinkTokenInput{
		TenantID: "11111111-1111-1111-1111-111111111111", PollKey: "launch",
		OptionKey: "yes", RecipientReference: "recipient-42",
		ContentRevisionID: "33333333-3333-3333-3333-333333333333",
		IssuedAt:          issuedAt, ExpiresAt: issuedAt.Add(time.Hour),
	}
	token, err := repo.MintToken(input)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}

	now = input.ExpiresAt
	if _, err := repo.verifyLinkToken(token, input); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("token verified at exclusive expiry: %v", err)
	}

	now = issuedAt.Add(-maximumTokenClockSkew - time.Second)
	if _, err := repo.verifyLinkToken(token, input); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("future-issued token verified beyond clock skew: %v", err)
	}
}
