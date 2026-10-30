// SPDX-License-Identifier: AGPL-3.0-only
package pushsend

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
)

// generateTestECKeyPEM mints a fresh P-256 key (the curve APNs's ES256
// requires) and PEM-encodes it as PKCS#8, mirroring the shape of a
// downloaded .p8 APNs auth key, so tests can exercise the real JWT-signing
// code path without a committed credential.
func generateTestECKeyPEM() (string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	block := &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// generateTestRSAKeyPEM mints a fresh RSA key and PEM-encodes it as PKCS#8,
// mirroring the private_key field of a downloaded Firebase service-account
// JSON, so tests can exercise the real JWT-assertion-signing code path
// without a committed credential.
func generateTestRSAKeyPEM() (string, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	block := &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}
