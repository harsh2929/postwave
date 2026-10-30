// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// AlgorithmHMACSHA256 / AlgorithmECDSAP256 / AlgorithmEd25519 are the
// supported signing algorithms. The string identifiers are stable —
// they appear in the webhooks table + the public API.
const (
	AlgorithmHMACSHA256 = "hmac_sha256" // legacy default; symmetric HMAC
	AlgorithmECDSAP256  = "ecdsa_p256"  // ECDSA over secp256r1 (P-256) with SHA-256
	AlgorithmEd25519    = "ed25519"     // Ed25519 (RFC 8032)
)

// SignatureVersionHMAC etc. are the v* tags emitted in
// X-Postwave-Signature. v1 = HMAC (legacy, retained), v2 = ECDSA P-256,
// v3 = Ed25519. Old verifiers keep working on v1; new verifiers see
// extra tags they can use.
const (
	SignatureVersionHMAC    = "v1"
	SignatureVersionECDSA   = "v2"
	SignatureVersionEd25519 = "v3"
)

// IsAllowedAlgorithm returns true for one of the canonical algorithm
// identifiers above.
func IsAllowedAlgorithm(a string) bool {
	switch a {
	case AlgorithmHMACSHA256, AlgorithmECDSAP256, AlgorithmEd25519:
		return true
	}
	return false
}

// SigningSecret bundles freshly generated signing material. For HMAC,
// Secret is returned once to the customer. For ECDSA / Ed25519,
// PublicKeyPEM is safe verification material while PrivateKeyPEM is an
// internal-only value that Moosewave envelope-encrypts at rest. The
// private key must never be serialized into an API response.
type SigningSecret struct {
	Algorithm     string `json:"algorithm"`
	Secret        string `json:"secret,omitempty"`         // HMAC only
	PublicKeyPEM  string `json:"public_key_pem,omitempty"` // ECDSA / Ed25519
	PrivateKeyPEM string `json:"-"`
}

// GenerateSigningMaterial produces fresh keying material for `algorithm`.
// StoreEncode derives the private representation that is persisted
// after envelope encryption. Callers may expose Secret for HMAC or
// PublicKeyPEM for asymmetric algorithms, but never PrivateKeyPEM.
func GenerateSigningMaterial(algorithm string) (*SigningSecret, error) {
	switch algorithm {
	case AlgorithmHMACSHA256, "":
		sec, err := newSecret()
		if err != nil {
			return nil, err
		}
		return &SigningSecret{Algorithm: AlgorithmHMACSHA256, Secret: sec}, nil

	case AlgorithmECDSAP256:
		priv, err := ecdsaGenerateKey()
		if err != nil {
			return nil, err
		}
		pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("ecdsa: marshal public: %w", err)
		}
		privDER, err := x509.MarshalECPrivateKey(priv)
		if err != nil {
			return nil, fmt.Errorf("ecdsa: marshal private: %w", err)
		}
		return &SigningSecret{
			Algorithm:     AlgorithmECDSAP256,
			PublicKeyPEM:  pemEncode("PUBLIC KEY", pubDER),
			PrivateKeyPEM: pemEncode("EC PRIVATE KEY", privDER),
		}, nil

	case AlgorithmEd25519:
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("ed25519: %w", err)
		}
		pubDER, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			return nil, fmt.Errorf("ed25519: marshal public: %w", err)
		}
		// Ed25519 has no x509 spec for the private key alone; encode as
		// PKCS#8 which the Go stdlib supports.
		privDER, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return nil, fmt.Errorf("ed25519: marshal private: %w", err)
		}
		return &SigningSecret{
			Algorithm:     AlgorithmEd25519,
			PublicKeyPEM:  pemEncode("PUBLIC KEY", pubDER),
			PrivateKeyPEM: pemEncode("PRIVATE KEY", privDER),
		}, nil

	default:
		return nil, fmt.Errorf("unsupported algorithm %q", algorithm)
	}
}

// StoreEncode returns the bytes to persist for `mat`. For HMAC this is
// the raw secret bytes; for ECDSA / Ed25519 it's the PEM-encoded private
// key. All forms are envelope-encrypted by the caller before hitting the
// DB.
func StoreEncode(mat *SigningSecret) ([]byte, error) {
	switch mat.Algorithm {
	case AlgorithmHMACSHA256:
		return []byte(mat.Secret), nil
	case AlgorithmECDSAP256, AlgorithmEd25519:
		return []byte(mat.PrivateKeyPEM), nil
	default:
		return nil, fmt.Errorf("unsupported algorithm %q", mat.Algorithm)
	}
}

// SignBodyWithAlgorithm emits the X-Postwave-Signature value for body
// at time t using the named algorithm.
//
//	HMAC-SHA256 → "t=<unix>,v1=<hex>"
//	ECDSA P-256 → "t=<unix>,v2=<hex(asn.1 r||s)>"
//	Ed25519     → "t=<unix>,v3=<hex>"
//
// material is the algorithm-appropriate keying material (HMAC secret
// string for v1; PEM-encoded private key for v2/v3). The format is
// chosen so multi-algorithm rotation can produce headers like
// "t=…,v1=…,v2=…" by concatenating.
func SignBodyWithAlgorithm(algorithm string, material []byte, t time.Time, body []byte) (string, error) {
	ts := strconvFormatI64(t.Unix())
	payload := append([]byte(ts+"."), body...)

	switch algorithm {
	case AlgorithmHMACSHA256, "":
		mac := hmac.New(sha256.New, material)
		mac.Write([]byte(ts))
		mac.Write([]byte("."))
		mac.Write(body)
		return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil)), nil

	case AlgorithmECDSAP256:
		priv, err := parseECDSAKey(material)
		if err != nil {
			return "", err
		}
		digest := sha256.Sum256(payload)
		r, s, err := ecdsaSignDigest(priv, digest[:])
		if err != nil {
			return "", fmt.Errorf("ecdsa sign: %w", err)
		}
		sig, err := asn1.Marshal(ecdsaSignatureASN1{R: r, S: s})
		if err != nil {
			return "", fmt.Errorf("ecdsa asn.1: %w", err)
		}
		return "t=" + ts + ",v2=" + hex.EncodeToString(sig), nil

	case AlgorithmEd25519:
		priv, err := parseEd25519Key(material)
		if err != nil {
			return "", err
		}
		sig := ed25519.Sign(priv, payload)
		return "t=" + ts + ",v3=" + hex.EncodeToString(sig), nil

	default:
		return "", fmt.Errorf("unsupported algorithm %q", algorithm)
	}
}

// MergeSignatures combines two single-algorithm signatures (each
// produced by SignBodyWithAlgorithm at the SAME timestamp) into a
// dual-signed header. Used during the rotation grace window so
// subscribers can verify against either the primary or the secondary
// key.
//
// Output: "t=<unix>,v1=...,v2=..." (preserves the leading t= only
// once; both inputs MUST share the same timestamp or the function
// returns an error).
func MergeSignatures(a, b string) (string, error) {
	tsA, partsA, err := splitSig(a)
	if err != nil {
		return "", err
	}
	tsB, partsB, err := splitSig(b)
	if err != nil {
		return "", err
	}
	if tsA != tsB {
		return "", fmt.Errorf("merge signatures: timestamp mismatch %q vs %q", tsA, tsB)
	}
	merged := append([]string{"t=" + tsA}, partsA...)
	merged = append(merged, partsB...)
	return strings.Join(merged, ","), nil
}

// VerifySignatureAlgo verifies an X-Postwave-Signature header against
// body + algorithm + verification material:
//
//	hmac_sha256 → material is the shared secret bytes
//	ecdsa_p256  → material is PEM-encoded PUBLIC key (caller has the public key)
//	ed25519     → material is PEM-encoded PUBLIC key
//
// Tolerance bounds the timestamp skew; pass 0 to skip the check (e.g.
// in tests).
func VerifySignatureAlgo(header string, body []byte, algorithm string, material []byte, now time.Time, tolerance time.Duration) error {
	ts, parts, err := splitSig(header)
	if err != nil {
		return err
	}
	if tolerance > 0 {
		tsInt, _ := strconvParseI64(ts)
		skew := now.Sub(time.Unix(tsInt, 0))
		if skew < 0 {
			skew = -skew
		}
		if skew > tolerance {
			return errors.New("signature: timestamp outside tolerance")
		}
	}
	payload := append([]byte(ts+"."), body...)
	switch algorithm {
	case AlgorithmHMACSHA256:
		signatures := pluckParts(parts, SignatureVersionHMAC+"=")
		if len(signatures) == 0 {
			return errors.New("signature: missing v1")
		}
		mac := hmac.New(sha256.New, material)
		mac.Write([]byte(ts))
		mac.Write([]byte("."))
		mac.Write(body)
		want := mac.Sum(nil)
		for _, sigHex := range signatures {
			got, err := hex.DecodeString(sigHex)
			if err == nil && hmac.Equal(want, got) {
				return nil
			}
		}
		return errors.New("signature: mismatch")

	case AlgorithmECDSAP256:
		signatures := pluckParts(parts, SignatureVersionECDSA+"=")
		if len(signatures) == 0 {
			return errors.New("signature: missing v2")
		}
		pub, err := parseECDSAPub(material)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(payload)
		for _, sigHex := range signatures {
			sig, err := hex.DecodeString(sigHex)
			if err != nil {
				continue
			}
			var ecsig ecdsaSignatureASN1
			rest, err := asn1.Unmarshal(sig, &ecsig)
			if err != nil || len(rest) != 0 || ecsig.R == nil || ecsig.S == nil {
				continue
			}
			if ecdsa.Verify(pub, digest[:], ecsig.R, ecsig.S) {
				return nil
			}
		}
		return errors.New("signature: ecdsa verify failed")

	case AlgorithmEd25519:
		signatures := pluckParts(parts, SignatureVersionEd25519+"=")
		if len(signatures) == 0 {
			return errors.New("signature: missing v3")
		}
		pub, err := parseEd25519Pub(material)
		if err != nil {
			return err
		}
		for _, sigHex := range signatures {
			sig, err := hex.DecodeString(sigHex)
			if err == nil && ed25519.Verify(pub, payload, sig) {
				return nil
			}
		}
		return errors.New("signature: ed25519 verify failed")

	default:
		return fmt.Errorf("signature: unsupported algorithm %q", algorithm)
	}
}

// --- internals ---

// splitSig parses a Moosewave signature header into exactly one positive
// decimal timestamp plus the remaining v*=… parts. Returns ts (string
// form), parts (e.g. ["v1=abc", "v2=def"]).
func splitSig(header string) (ts string, parts []string, err error) {
	timestampCount := 0
	for _, raw := range strings.Split(header, ",") {
		part := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(part, "t="):
			timestampCount++
			if timestampCount > 1 {
				return "", nil, errors.New("signature: duplicate t=")
			}
			ts = strings.TrimPrefix(part, "t=")
			if ts == "" {
				return "", nil, errors.New("signature: empty t=")
			}
			for _, character := range ts {
				if character < '0' || character > '9' {
					return "", nil, errors.New("signature: invalid t=")
				}
			}
			parsed, parseErr := strconv.ParseInt(ts, 10, 64)
			if parseErr != nil || parsed <= 0 {
				return "", nil, errors.New("signature: invalid t=")
			}
		case strings.HasPrefix(part, "v"):
			parts = append(parts, part)
		}
	}
	if timestampCount == 0 {
		return "", nil, errors.New("signature: missing t=")
	}
	if len(parts) == 0 {
		return "", nil, errors.New("signature: no v* parts")
	}
	return ts, parts, nil
}

// pluckParts returns every signature with the requested algorithm
// version. Rotation deliberately emits duplicate version tags when
// the old and new keys use the same algorithm, so verifiers must try
// every matching value rather than trusting the first one.
func pluckParts(parts []string, prefix string) []string {
	values := make([]string, 0, 1)
	for _, p := range parts {
		if strings.HasPrefix(p, prefix) {
			values = append(values, strings.TrimPrefix(p, prefix))
		}
	}
	return values
}

func pemEncode(typ string, der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}))
}

func parseECDSAKey(material []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(material)
	if block == nil {
		return nil, errors.New("ecdsa: not PEM")
	}
	switch block.Type {
	case "EC PRIVATE KEY":
		return x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		priv, ok := k.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("ecdsa: PKCS8 key is not ECDSA")
		}
		return priv, nil
	default:
		return nil, fmt.Errorf("ecdsa: unsupported PEM type %q", block.Type)
	}
}

func parseECDSAPub(material []byte) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode(material)
	if block == nil {
		return nil, errors.New("ecdsa: not PEM")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("ecdsa: not an ECDSA public key")
	}
	return key, nil
}

func parseEd25519Key(material []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(material)
	if block == nil {
		return nil, errors.New("ed25519: not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("ed25519: PKCS8 key is not Ed25519")
	}
	return priv, nil
}

func parseEd25519Pub(material []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(material)
	if block == nil {
		return nil, errors.New("ed25519: not PEM")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("ed25519: not an Ed25519 public key")
	}
	return key, nil
}

func ecdsaGenerateKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

func ecdsaSignDigest(priv *ecdsa.PrivateKey, digest []byte) (*big.Int, *big.Int, error) {
	return ecdsa.Sign(rand.Reader, priv, digest)
}

type ecdsaSignatureASN1 struct {
	R, S *big.Int
}
