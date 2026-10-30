// pii.go — local subscriber-email redaction for log lines.
//
// Mirrors apps/api/internal/observability.RedactEmail. Duplicated
// rather than imported because Go's `internal` package convention
// prevents services/automation from reaching into apps/api/internal.
// Keeping the implementation deliberately tiny so the duplication
// stays cheap.

package worker

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// redactEmail produces a stable, non-reversible identifier of the
// form "<10-char-sha256-prefix>@<domain>" for use in structured logs
// that may reach CloudWatch / Sentry / Slack. Empty input → "".
func redactEmail(email string) string {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return ""
	}
	at := strings.LastIndexByte(email, '@')
	sum := sha256.Sum256([]byte(email))
	prefix := hex.EncodeToString(sum[:5])
	if at < 0 || at == len(email)-1 {
		return prefix
	}
	return prefix + "@" + email[at+1:]
}
