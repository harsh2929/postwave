// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestVerifySignatureAlgoTriesEverySameAlgorithmRotationValue(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name      string
		algorithm string
		verify    func(*SigningSecret) []byte
	}{
		{
			name:      "hmac",
			algorithm: AlgorithmHMACSHA256,
			verify:    func(material *SigningSecret) []byte { return []byte(material.Secret) },
		},
		{
			name:      "ecdsa",
			algorithm: AlgorithmECDSAP256,
			verify:    func(material *SigningSecret) []byte { return []byte(material.PublicKeyPEM) },
		},
		{
			name:      "ed25519",
			algorithm: AlgorithmEd25519,
			verify:    func(material *SigningSecret) []byte { return []byte(material.PublicKeyPEM) },
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			primary, err := GenerateSigningMaterial(testCase.algorithm)
			require.NoError(t, err)
			secondary, err := GenerateSigningMaterial(testCase.algorithm)
			require.NoError(t, err)

			body := []byte("same-algorithm-rotation")
			now := time.Unix(1_700_000_700, 0)
			primarySignature, err := SignBodyWithAlgorithm(
				testCase.algorithm,
				mustStoreEncode(t, primary),
				now,
				body,
			)
			require.NoError(t, err)
			secondarySignature, err := SignBodyWithAlgorithm(
				testCase.algorithm,
				mustStoreEncode(t, secondary),
				now,
				body,
			)
			require.NoError(t, err)
			merged, err := MergeSignatures(primarySignature, secondarySignature)
			require.NoError(t, err)

			require.NoError(t, VerifySignatureAlgo(
				merged,
				body,
				testCase.algorithm,
				testCase.verify(primary),
				now,
				time.Minute,
			))
			require.NoError(t, VerifySignatureAlgo(
				merged,
				body,
				testCase.algorithm,
				testCase.verify(secondary),
				now,
				time.Minute,
			))
		})
	}
}

func TestVerifySignatureAlgoSkipsMalformedMatchingCandidates(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name      string
		algorithm string
		version   string
		verify    func(*SigningSecret) []byte
	}{
		{
			name:      "hmac",
			algorithm: AlgorithmHMACSHA256,
			version:   SignatureVersionHMAC,
			verify:    func(material *SigningSecret) []byte { return []byte(material.Secret) },
		},
		{
			name:      "ecdsa",
			algorithm: AlgorithmECDSAP256,
			version:   SignatureVersionECDSA,
			verify:    func(material *SigningSecret) []byte { return []byte(material.PublicKeyPEM) },
		},
		{
			name:      "ed25519",
			algorithm: AlgorithmEd25519,
			version:   SignatureVersionEd25519,
			verify:    func(material *SigningSecret) []byte { return []byte(material.PublicKeyPEM) },
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			material, err := GenerateSigningMaterial(testCase.algorithm)
			require.NoError(t, err)
			body := []byte("candidate-order")
			now := time.Unix(1_700_000_800, 0)
			validHeader, err := SignBodyWithAlgorithm(
				testCase.algorithm,
				mustStoreEncode(t, material),
				now,
				body,
			)
			require.NoError(t, err)
			validPart := strings.SplitN(validHeader, ",", 2)[1]
			malformedPart := testCase.version + "=not-hex"

			for _, header := range []string{
				"t=1700000800," + malformedPart + "," + validPart,
				"t=1700000800," + validPart + "," + malformedPart,
			} {
				require.NoError(t, VerifySignatureAlgo(
					header,
					body,
					testCase.algorithm,
					testCase.verify(material),
					now,
					time.Minute,
				))
			}
		})
	}
}

func TestVerifySignatureAlgoRejectsAmbiguousOrInvalidTimestampWithoutTolerance(t *testing.T) {
	t.Parallel()

	material, err := GenerateSigningMaterial(AlgorithmHMACSHA256)
	require.NoError(t, err)
	body := []byte("timestamp-contract")
	now := time.Unix(1_700_000_900, 0)
	validHeader, err := SignBodyWithAlgorithm(
		AlgorithmHMACSHA256,
		[]byte(material.Secret),
		now,
		body,
	)
	require.NoError(t, err)

	invalidHeaders := []string{
		validHeader + ",t=1700000900",
		"t=,v1=00",
		"t=not-a-number,v1=00",
		"t=0,v1=00",
		"t=-1,v1=00",
		"t=+1,v1=00",
		"t=999999999999999999999999999999,v1=00",
	}
	for _, header := range invalidHeaders {
		require.Error(t, VerifySignatureAlgo(
			header,
			body,
			AlgorithmHMACSHA256,
			[]byte(material.Secret),
			now,
			0,
		), header)
	}
}

func TestAsymmetricSigningMaterialCannotSerializePrivateKey(t *testing.T) {
	t.Parallel()

	material, err := GenerateSigningMaterial(AlgorithmEd25519)
	require.NoError(t, err)
	require.NotEmpty(t, material.PrivateKeyPEM)

	encoded, err := json.Marshal(material)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "private_key_pem")
	require.NotContains(t, string(encoded), "PRIVATE KEY")
	require.Contains(t, string(encoded), "public_key_pem")

	response := CreateResponse{
		Webhook:      &Webhook{},
		PublicKeyPEM: material.PublicKeyPEM,
	}
	encoded, err = json.Marshal(response)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "private_key_pem")
	require.NotContains(t, string(encoded), "PRIVATE KEY")
	require.Contains(t, string(encoded), "public_key_pem")
}

func mustStoreEncode(t *testing.T, material *SigningSecret) []byte {
	t.Helper()
	encoded, err := StoreEncode(material)
	require.NoError(t, err)
	return encoded
}
