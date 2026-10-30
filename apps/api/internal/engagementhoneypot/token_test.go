// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"strings"
	"testing"
	"time"
)

func testMinter(t *testing.T) *Minter {
	t.Helper()
	minter, err := NewMinter([]byte("test-secret-with-enough-length-000000"), "k1")
	if err != nil {
		t.Fatalf("NewMinter: %v", err)
	}
	return minter
}

func testClaim(issued time.Time) Claim {
	return Claim{
		TenantID:              "8e3d1c6a-0000-4000-8000-000000000001",
		CampaignID:            "8e3d1c6a-0000-4000-8000-000000000002",
		RecipientIdentityHMAC: strings.Repeat("a", 64),
		Technique:             TechniqueDisplayNone,
		IssuedAt:              issued,
	}
}

func TestMintedTokenVerifies(t *testing.T) {
	minter := testMinter(t)
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	got, err := minter.Verify(token, issued.Add(time.Hour))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.CampaignID != testClaim(issued).CampaignID {
		t.Errorf("CampaignID = %q, want the minted campaign", got.CampaignID)
	}
	if got.Technique != TechniqueDisplayNone {
		t.Errorf("Technique = %q, want display_none", got.Technique)
	}
	if !got.IssuedAt.Equal(issued) {
		t.Errorf("IssuedAt = %v, want %v", got.IssuedAt, issued)
	}
}

func TestTamperedPayloadIsRejected(t *testing.T) {
	// The whole value of a honeypot label is that only we could have issued
	// the URL. An unauthenticated token would let anyone mint machine labels
	// against any tenant and poison the corpus that certifies the classifier —
	// a write path into calibration, dressed up as a GET.
	minter := testMinter(t)
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	payload, signature, found := strings.Cut(token, ".")
	if !found {
		t.Fatalf("token %q has no signature separator", token)
	}
	// Flip one byte of the payload, keeping the original signature.
	forged := payload[:len(payload)-1] + swapRune(payload[len(payload)-1:]) + "." + signature
	if _, err := minter.Verify(forged, issued.Add(time.Hour)); err == nil {
		t.Error("a token with a tampered payload verified; anyone could forge machine labels")
	}
}

func TestTokenFromADifferentSecretIsRejected(t *testing.T) {
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	minter := testMinter(t)
	other, err := NewMinter([]byte("a-completely-different-secret-000000"), "k1")
	if err != nil {
		t.Fatalf("NewMinter: %v", err)
	}
	token, err := other.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := minter.Verify(token, issued.Add(time.Hour)); err == nil {
		t.Error("a token signed with a foreign secret verified")
	}
}

func TestExpiredTokenIsRejected(t *testing.T) {
	// A decoy URL lives forever in someone's mailbox. Without an expiry the
	// corpus would keep accruing labels from archived mail years after the
	// send, long after the scanner population it measured stopped existing.
	minter := testMinter(t)
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := minter.Verify(token, issued.Add(TokenLifetime+time.Second)); err == nil {
		t.Error("a token past TokenLifetime verified")
	}
	if _, err := minter.Verify(token, issued.Add(TokenLifetime-time.Second)); err != nil {
		t.Errorf("a token inside TokenLifetime was rejected: %v", err)
	}
}

func TestTokenIssuedInTheFutureIsRejected(t *testing.T) {
	// Clock skew on a signing host would otherwise let a token predate its own
	// window and survive past the intended expiry.
	minter := testMinter(t)
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := minter.Verify(token, issued.Add(-MaxClockSkew-time.Second)); err == nil {
		t.Error("a token issued beyond MaxClockSkew in the future verified")
	}
}

func TestTokenCarriesNoRecipientAddress(t *testing.T) {
	// The decoy URL crosses every hop between us and the mailbox — including
	// the security gateways we are trying to measure. It must carry the
	// recipient HMAC, never the address.
	minter := testMinter(t)
	claim := testClaim(time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	token, err := minter.Mint(claim)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if strings.Contains(strings.ToLower(token), "@") {
		t.Errorf("token %q contains an at-sign, so it may carry an address", token)
	}
}

func TestMintRejectsANonCertifyingTechnique(t *testing.T) {
	// Refuse at the point of issue. A decoy that cannot produce a valid label
	// is pure downside: it carries the spam-filter cost of hidden content and
	// buys no evidence.
	minter := testMinter(t)
	claim := testClaim(time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	claim.Technique = TechniqueOffScreen
	if _, err := minter.Mint(claim); err == nil {
		t.Error("minted a decoy with a technique that can never certify a label")
	}
}

func TestMinterRejectsAShortSecret(t *testing.T) {
	if _, err := NewMinter([]byte("short"), "k1"); err == nil {
		t.Error("accepted a secret below the minimum length")
	}
}

// swapRune returns a single-character string different from the input, staying
// inside the base64url alphabet so the tamper is a payload change rather than
// a decoding failure.
func swapRune(s string) string {
	if s == "A" {
		return "B"
	}
	return "A"
}

func TestRecipientIdentityIsStableAndDistinct(t *testing.T) {
	minter := testMinter(t)
	const tenant = "8e3d1c6a-0000-4000-8000-000000000001"
	first := minter.RecipientIdentity(tenant, 4242)
	if first != minter.RecipientIdentity(tenant, 4242) {
		t.Error("the same recipient produced two identities, so repeat fetches would not collapse")
	}
	if first == minter.RecipientIdentity(tenant, 4243) {
		t.Error("two recipients share an identity, so their evidence would collide")
	}
	if first == minter.RecipientIdentity("8e3d1c6a-0000-4000-8000-000000000002", 4242) {
		t.Error("two tenants share an identity for the same row id")
	}
	if !hmacPattern.MatchString(first) {
		t.Errorf("identity %q is not a 64-character hex hmac, so Mint would reject it", first)
	}
}

func TestRecipientIdentityIsKeyed(t *testing.T) {
	// An unkeyed digest of a row id is enumerable: anyone could precompute the
	// identity of every recipient of a campaign and forge decoy tokens for them
	// if the signing secret ever leaked separately.
	const tenant = "8e3d1c6a-0000-4000-8000-000000000001"
	other, err := NewMinter([]byte("a-completely-different-secret-000000"), "k1")
	if err != nil {
		t.Fatalf("NewMinter: %v", err)
	}
	if testMinter(t).RecipientIdentity(tenant, 7) == other.RecipientIdentity(tenant, 7) {
		t.Error("recipient identity does not depend on the signing secret")
	}
}
