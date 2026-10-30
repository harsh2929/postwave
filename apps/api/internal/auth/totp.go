// SPDX-License-Identifier: AGPL-3.0-only
//
// TOTP (RFC 6238) primitives — the pure functions. All deterministic
// behavior lives here so it's table-test-friendly; storage + handler
// glue lives in totp_handlers.go.
//
// Algorithm choice: SHA-1, 6-digit, 30-second period. Standard. Every
// authenticator app (Google Authenticator, 1Password, Authy, Bitwarden,
// Apple Passwords, etc.) supports SHA-1 + 30s; the more exotic SHA-256
// / SHA-512 / 8-digit variants do not enroll cleanly across all apps,
// so we stick to the universally compatible profile.
//
// Secret length: 20 bytes (160 bits). RFC 4226 §4 says "the shared secret
// MUST be at least 128 bits" and "RECOMMENDED 160 bits" — that's where
// the 20 falls. base32 encodes that to 32 ASCII characters with no
// padding (the otpauth:// convention; padding "=" is forbidden by some
// authenticator app parsers).
//
// Recovery codes: 8 of them, formatted xxxx-xxxx-xxxx where each x is a
// lowercase hex digit. 12 hex chars = 48 bits of entropy per code,
// well above the threshold for a code that's never rate-limited (we
// also one-shot consume them — see ConsumeRecoveryCode in repo.go). We
// store sha256(code) and present the plaintext exactly once at
// enrollment.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 -- RFC 6238 interoperability profile; HMAC-SHA1 remains required by common authenticator apps
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTPPeriod is the rolling window length. RFC 6238 default.
const TOTPPeriod = 30 * time.Second

// TOTPDigits is the displayed code length.
const TOTPDigits = 6

// TOTPSecretBytes is the raw secret length (RFC 4226 RECOMMENDED).
const TOTPSecretBytes = 20

// RecoveryCodeCount is how many one-shot codes we hand out at enrollment.
const RecoveryCodeCount = 8

// GenerateSecret returns (raw 20-byte secret, base32-encoded form, err).
// The base32 form is what goes into the otpauth:// URI; the raw form is
// what we encrypt at rest.
func GenerateSecret() ([]byte, string, error) {
	b := make([]byte, TOTPSecretBytes)
	if _, err := rand.Read(b); err != nil {
		return nil, "", fmt.Errorf("totp secret rand: %w", err)
	}
	// NoPadding because some authenticator apps (notably older Android
	// builds) reject "=" padding in otpauth:// secret param.
	return b, base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// Code returns the 6-digit TOTP for the given absolute time. RFC 6238
// step is floor(t / 30s); HMAC-SHA1 of the 8-byte big-endian step is
// dynamically truncated per RFC 4226 §5.3.
func Code(secret []byte, t time.Time) string {
	unixSeconds := t.Unix()
	if unixSeconds < 0 {
		unixSeconds = 0
	}
	// unixSeconds is non-negative above, so the conversion is exact.
	step := uint64(unixSeconds / int64(TOTPPeriod.Seconds())) // #nosec G115 -- bounded by the non-negative int64 domain
	return codeAtStep(secret, step)
}

// VerifyCode constant-time-compares the supplied code against the
// expected code at the current step ± skewSteps. A skew of 1 covers
// 90s of clock drift between the device and the server, which is the
// industry-standard tolerance.
func VerifyCode(secret []byte, supplied string, t time.Time, skewSteps int) bool {
	supplied = strings.TrimSpace(supplied)
	if len(supplied) != TOTPDigits {
		return false
	}
	unixSeconds := t.Unix()
	if unixSeconds < 0 {
		return false
	}
	step := unixSeconds / int64(TOTPPeriod.Seconds())
	for i := -skewSteps; i <= skewSteps; i++ {
		s := step + int64(i)
		if s < 0 {
			continue
		}
		expected := codeAtStep(secret, uint64(s))
		// ConstantTimeCompare returns 0 on length mismatch — both sides
		// here are exactly TOTPDigits, so the timing channel is clean.
		if subtle.ConstantTimeCompare([]byte(expected), []byte(supplied)) == 1 {
			return true
		}
	}
	return false
}

// codeAtStep is the RFC 6238 / 4226 core: HMAC-SHA1 over the 8-byte BE
// counter, dynamic truncation, mod 10^digits.
func codeAtStep(secret []byte, step uint64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], step)

	mac := hmac.New(sha1.New, secret)
	mac.Write(counter[:])
	sum := mac.Sum(nil) // 20 bytes

	offset := sum[len(sum)-1] & 0x0F
	binCode := (uint32(sum[offset])&0x7F)<<24 |
		(uint32(sum[offset+1])&0xFF)<<16 |
		(uint32(sum[offset+2])&0xFF)<<8 |
		(uint32(sum[offset+3]) & 0xFF)
	mod := uint32(1)
	for i := 0; i < TOTPDigits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", TOTPDigits, binCode%mod)
}

// BuildOtpauthURI returns the otpauth://totp URI an authenticator app
// can ingest as a QR code. issuer is hard-coded to "Moosewave"; the
// account label is the user's email so multiple Moosewave-account users
// can co-exist on the same phone without collision.
//
// Spec: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
func BuildOtpauthURI(email, base32Secret string) string {
	// The label per the key-URI spec is "issuer:account". The issuer
	// query param should match (some apps key off the path, some off
	// the query, some off both — supplying both is the safe play).
	label := "Moosewave:" + email
	q := url.Values{}
	q.Set("secret", base32Secret)
	q.Set("issuer", "Moosewave")
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprintf("%d", TOTPDigits))
	q.Set("period", fmt.Sprintf("%d", int(TOTPPeriod.Seconds())))
	// url.PathEscape on the label preserves the colon (which spec
	// requires literal) — but Go's PathEscape also encodes ":" so we
	// build the path manually. The "/" path separator is part of the
	// scheme-specific syntax, not the encoded label.
	return "otpauth://totp/" + escapeLabel(label) + "?" + q.Encode()
}

// escapeLabel percent-encodes everything except letters, digits, and a
// short safe set, including a literal ":". Matches what the QR-code
// format spec calls "label" component encoding.
func escapeLabel(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z',
			r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == ':' || r == '@' || r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteString("%20")
		default:
			// Re-use net/url's escape rules for anything weirder.
			b.WriteString(url.QueryEscape(string(r)))
		}
	}
	return b.String()
}

// GenerateRecoveryCodes returns (plaintext-codes, sha256-hashes). The
// plaintext is shown to the user exactly once; the hashes go in the
// auth_totp_secrets.recovery_codes_hash bytea[] column for one-shot
// lookup via ConsumeRecoveryCode.
//
// Format: lowercase hex grouped 4-4-4 with hyphens. 48 bits of entropy
// per code; n codes default to 8, totaling 384 bits across the bundle.
func GenerateRecoveryCodes(n int) ([]string, [][]byte, error) {
	plain := make([]string, n)
	hashes := make([][]byte, n)
	raw := make([]byte, 6) // 12 hex chars
	for i := 0; i < n; i++ {
		if _, err := rand.Read(raw); err != nil {
			return nil, nil, fmt.Errorf("recovery code rand: %w", err)
		}
		hex := fmt.Sprintf("%02x%02x%02x%02x%02x%02x",
			raw[0], raw[1], raw[2], raw[3], raw[4], raw[5])
		plain[i] = hex[0:4] + "-" + hex[4:8] + "-" + hex[8:12]
		h := sha256.Sum256([]byte(plain[i]))
		hashes[i] = append([]byte(nil), h[:]...)
	}
	return plain, hashes, nil
}

// HashRecoveryCode returns sha256(code) for the consume path. Lower-cases
// + trims whitespace so users can paste with surrounding whitespace or
// shouty caps without rejection.
func HashRecoveryCode(code string) []byte {
	normalized := strings.ToLower(strings.TrimSpace(code))
	h := sha256.Sum256([]byte(normalized))
	return h[:]
}
