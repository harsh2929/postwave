// SPDX-License-Identifier: AGPL-3.0-only
//
// pii.go — helpers for redacting subscriber-identifying data before it
// reaches structured logs, Sentry breadcrumbs, or any other sink that
// lives outside the encryption boundary (CloudWatch, Slack alerts,
// PagerDuty, etc).
//
// The discipline:
//   - Never log a full email address. Use RedactEmail to produce a
//     stable {hash, domain} pair instead. A SHA-256 prefix is enough to
//     correlate two log entries about the same subscriber across a
//     timeline without revealing the address itself.
//   - Never log an IP without redaction. Use RedactIP for /24-style
//     truncation when the IP is incidental to the log line; omit it
//     entirely when not needed for correlation.
//
// Why the helper instead of a sed-style scrubber further downstream:
// emitting structured fields means the value lands in a typed bucket
// (CloudWatch JSON fields, Sentry "extra", etc.) and a scrubber acting
// on serialized output is fragile. Redacting at the slog call site is
// the only way to guarantee no leak.

package observability

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
)

// RedactEmail returns a stable, non-reversible identifier for an
// email address suitable for structured logging. Format:
// "<10-char-sha256-prefix>@<domain>". Empty input returns "".
//
// The hash is salted ONLY with the literal address (not a secret) — a
// dictionary attack on common addresses is feasible, but the goal is
// not cryptographic confidentiality; it's avoiding a casual log-grep
// for "alice@example.com" turning up subscriber identities. CloudWatch
// access is already gated by IAM; this prevents accidental exposure
// when logs get screenshotted in Slack, copied into bug reports, or
// surfaced in third-party log aggregators.
//
// Keeping the domain in clear preserves the operational signal — most
// deliverability triage starts with "are we seeing a spike from
// gmail.com or a small ISP?" — without exposing the local-part.
func RedactEmail(email string) string {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return ""
	}
	at := strings.LastIndexByte(email, '@')
	if at < 0 || at == len(email)-1 {
		// Malformed input: still hash it so we don't accidentally pass
		// the raw value through, but don't try to derive a domain.
		sum := sha256.Sum256([]byte(email))
		return hex.EncodeToString(sum[:5])
	}
	domain := email[at+1:]
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:5]) + "@" + domain
}

// RedactIP returns a /24 (IPv4) or /48 (IPv6) prefix of the supplied
// address — enough to indicate "same network" without identifying the
// individual host. Empty / unparseable input returns "".
func RedactIP(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return ""
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	if v4 := parsed.To4(); v4 != nil {
		return fmt.Sprintf("%d.%d.%d.0/24", v4[0], v4[1], v4[2])
	}
	// IPv6: keep the first 48 bits (3 hextets).
	return parsed.Mask(net.CIDRMask(48, 128)).String() + "/48"
}
