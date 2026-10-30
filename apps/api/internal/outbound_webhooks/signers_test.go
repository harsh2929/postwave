// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// --- algorithm sanity ---

func TestIsAllowedAlgorithm(t *testing.T) {
	for _, a := range []string{AlgorithmHMACSHA256, AlgorithmECDSAP256, AlgorithmEd25519} {
		require.True(t, IsAllowedAlgorithm(a), a)
	}
	require.False(t, IsAllowedAlgorithm("rsa"))
	require.False(t, IsAllowedAlgorithm(""))
}

// --- HMAC round-trip ---

func TestSignVerify_HMAC(t *testing.T) {
	mat, err := GenerateSigningMaterial(AlgorithmHMACSHA256)
	require.NoError(t, err)
	require.NotEmpty(t, mat.Secret)
	require.Empty(t, mat.PublicKeyPEM)

	body := []byte(`{"event":"campaign.sent"}`)
	now := time.Unix(1_700_000_000, 0)
	sig, err := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(mat.Secret), now, body)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(sig, "t=1700000000,v1="))

	require.NoError(t, VerifySignatureAlgo(sig, body, AlgorithmHMACSHA256, []byte(mat.Secret), now, 60*time.Second))
}

func TestVerify_HMAC_BadBodyFails(t *testing.T) {
	mat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	now := time.Now()
	sig, err := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(mat.Secret), now, []byte("a"))
	require.NoError(t, err)
	err = VerifySignatureAlgo(sig, []byte("b"), AlgorithmHMACSHA256, []byte(mat.Secret), now, 60*time.Second)
	require.Error(t, err)
}

func TestVerify_TimestampOutsideTolerance(t *testing.T) {
	mat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	body := []byte("x")
	signedAt := time.Unix(1_700_000_000, 0)
	sig, _ := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(mat.Secret), signedAt, body)

	// Verify with a "now" that's 10 minutes later + tolerance of 5min.
	tenMinLater := signedAt.Add(10 * time.Minute)
	err := VerifySignatureAlgo(sig, body, AlgorithmHMACSHA256, []byte(mat.Secret), tenMinLater, 5*time.Minute)
	require.Error(t, err)
	require.Contains(t, err.Error(), "outside tolerance")
}

// --- ECDSA P-256 round-trip ---

func TestSignVerify_ECDSA(t *testing.T) {
	mat, err := GenerateSigningMaterial(AlgorithmECDSAP256)
	require.NoError(t, err)
	require.NotEmpty(t, mat.PrivateKeyPEM)
	require.NotEmpty(t, mat.PublicKeyPEM)
	require.Contains(t, mat.PublicKeyPEM, "BEGIN PUBLIC KEY")
	require.Contains(t, mat.PrivateKeyPEM, "BEGIN EC PRIVATE KEY")

	body := []byte("payload")
	now := time.Unix(1_700_000_100, 0)
	sig, err := SignBodyWithAlgorithm(AlgorithmECDSAP256, []byte(mat.PrivateKeyPEM), now, body)
	require.NoError(t, err)
	require.True(t, strings.Contains(sig, "v2="))

	require.NoError(t, VerifySignatureAlgo(sig, body, AlgorithmECDSAP256, []byte(mat.PublicKeyPEM), now, 60*time.Second))
}

func TestVerify_ECDSA_WrongKeyFails(t *testing.T) {
	a, _ := GenerateSigningMaterial(AlgorithmECDSAP256)
	b, _ := GenerateSigningMaterial(AlgorithmECDSAP256)
	now := time.Now()
	sig, _ := SignBodyWithAlgorithm(AlgorithmECDSAP256, []byte(a.PrivateKeyPEM), now, []byte("x"))
	err := VerifySignatureAlgo(sig, []byte("x"), AlgorithmECDSAP256, []byte(b.PublicKeyPEM), now, 60*time.Second)
	require.Error(t, err)
}

// --- Ed25519 round-trip ---

func TestSignVerify_Ed25519(t *testing.T) {
	mat, err := GenerateSigningMaterial(AlgorithmEd25519)
	require.NoError(t, err)
	require.NotEmpty(t, mat.PrivateKeyPEM)
	require.NotEmpty(t, mat.PublicKeyPEM)

	body := []byte("ping")
	now := time.Unix(1_700_000_200, 0)
	sig, err := SignBodyWithAlgorithm(AlgorithmEd25519, []byte(mat.PrivateKeyPEM), now, body)
	require.NoError(t, err)
	require.True(t, strings.Contains(sig, "v3="))

	require.NoError(t, VerifySignatureAlgo(sig, body, AlgorithmEd25519, []byte(mat.PublicKeyPEM), now, 60*time.Second))
}

func TestVerify_Ed25519_TamperedBody(t *testing.T) {
	mat, _ := GenerateSigningMaterial(AlgorithmEd25519)
	now := time.Now()
	sig, _ := SignBodyWithAlgorithm(AlgorithmEd25519, []byte(mat.PrivateKeyPEM), now, []byte("orig"))
	err := VerifySignatureAlgo(sig, []byte("tampered"), AlgorithmEd25519, []byte(mat.PublicKeyPEM), now, 60*time.Second)
	require.Error(t, err)
}

// --- Dual-signing (rotation grace window) ---

func TestMergeSignatures_DualAlgo(t *testing.T) {
	hmacMat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	ecMat, _ := GenerateSigningMaterial(AlgorithmECDSAP256)
	body := []byte("dual")
	now := time.Unix(1_700_000_300, 0)
	hmacSig, _ := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(hmacMat.Secret), now, body)
	ecSig, _ := SignBodyWithAlgorithm(AlgorithmECDSAP256, []byte(ecMat.PrivateKeyPEM), now, body)

	merged, err := MergeSignatures(hmacSig, ecSig)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(merged, "t=1700000300,"))
	require.True(t, strings.Contains(merged, "v1="))
	require.True(t, strings.Contains(merged, "v2="))

	// Both sides verify independently.
	require.NoError(t, VerifySignatureAlgo(merged, body, AlgorithmHMACSHA256, []byte(hmacMat.Secret), now, 60*time.Second))
	require.NoError(t, VerifySignatureAlgo(merged, body, AlgorithmECDSAP256, []byte(ecMat.PublicKeyPEM), now, 60*time.Second))
}

func TestMergeSignatures_TimestampMismatchRefused(t *testing.T) {
	a := "t=1,v1=ff"
	b := "t=2,v1=ee"
	_, err := MergeSignatures(a, b)
	require.Error(t, err)
}

func TestMergeSignatures_DualHMAC(t *testing.T) {
	// Verify the rotation scenario: tenant rotates HMAC secret. Old +
	// new HMAC secrets both signed. Each verifier (using only old or
	// only new) succeeds.
	oldMat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	newMat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	body := []byte("rotation-window")
	now := time.Unix(1_700_000_400, 0)

	primary, _ := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(newMat.Secret), now, body)
	secondary, _ := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(oldMat.Secret), now, body)

	// Both signatures use v1=; merging concatenates them. The verifier
	// tries every matching value so either the new or old secret remains
	// usable throughout the grace window.
	merged, err := MergeSignatures(primary, secondary)
	require.NoError(t, err)
	require.Contains(t, merged, "v1=")

	require.NoError(t, VerifySignatureAlgo(merged, body, AlgorithmHMACSHA256, []byte(newMat.Secret), now, 60*time.Second))
	require.NoError(t, VerifySignatureAlgo(merged, body, AlgorithmHMACSHA256, []byte(oldMat.Secret), now, 60*time.Second))
}

// --- Unsupported algorithms ---

func TestGenerateSigningMaterial_UnsupportedAlgorithm(t *testing.T) {
	_, err := GenerateSigningMaterial("rsa")
	require.Error(t, err)
}

func TestSignBodyWithAlgorithm_UnsupportedAlgorithm(t *testing.T) {
	_, err := SignBodyWithAlgorithm("rsa", nil, time.Now(), nil)
	require.Error(t, err)
}

// --- StoreEncode ---

func TestStoreEncode_HMACReturnsSecret(t *testing.T) {
	mat, _ := GenerateSigningMaterial(AlgorithmHMACSHA256)
	enc, err := StoreEncode(mat)
	require.NoError(t, err)
	require.Equal(t, []byte(mat.Secret), enc)
}

func TestStoreEncode_ECDSAReturnsPEM(t *testing.T) {
	mat, _ := GenerateSigningMaterial(AlgorithmECDSAP256)
	enc, err := StoreEncode(mat)
	require.NoError(t, err)
	require.Contains(t, string(enc), "BEGIN EC PRIVATE KEY")
}

// --- Legacy SignBody compat ---

func TestLegacySignBody_StillMatchesHMACAlgo(t *testing.T) {
	// The existing SignBody must continue to produce a byte-identical
	// value for a given input — workers in production still call it.
	secret := "owhsec_deadbeef"
	body := []byte("event-payload")
	now := time.Unix(1_700_000_500, 0)
	legacy := SignBody(secret, now, body)
	via, err := SignBodyWithAlgorithm(AlgorithmHMACSHA256, []byte(secret), now, body)
	require.NoError(t, err)
	require.Equal(t, legacy, via)
}
