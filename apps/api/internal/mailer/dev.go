// SPDX-License-Identifier: AGPL-3.0-only
package mailer

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// DevMailer is the local-dev / CI sender. It logs every send via slog
// and optionally writes a numbered copy under SpoolDir so engineers
// can open the rendered email body in a browser tab.
//
// Production code MUST NOT use this — main.go selects DevMailer only
// when POSTWAVE_MAILER is unset or set to "dev".
type DevMailer struct {
	Logger   *slog.Logger
	SpoolDir string // optional; e.g. /tmp/postwave-email; "" disables file spool
	counter  atomic.Uint64
}

// NewDevMailer constructs a DevMailer. SpoolDir is created if missing.
func NewDevMailer(logger *slog.Logger, spoolDir string) (*DevMailer, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if spoolDir != "" {
		if err := os.MkdirAll(spoolDir, 0o755); err != nil {
			return nil, fmt.Errorf("mailer spool: %w", err)
		}
	}
	return &DevMailer{Logger: logger, SpoolDir: spoolDir}, nil
}

// Send logs the message and writes a copy to SpoolDir if configured.
// Never returns an error in dev — emails should not block the request
// path even if the spool dir is read-only.
func (m *DevMailer) Send(_ context.Context, msg Message) error {
	if err := msg.Validate(); err != nil {
		return err
	}
	id := m.counter.Add(1)
	m.Logger.Info("dev mailer send",
		"id", id,
		"to", msg.To,
		"subject", msg.Subject,
		"tags", msg.Tags,
	)
	if m.SpoolDir == "" {
		return nil
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	name := fmt.Sprintf("%s-%05d-%s.eml", stamp, id, sanitize(msg.To))
	path := filepath.Join(m.SpoolDir, name)
	body := renderEML(msg)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		// Spool failure is non-fatal — log and continue.
		m.Logger.Warn("dev mailer spool write failed",
			"path", path, "err", err)
	}
	return nil
}

// renderEML produces a minimal RFC 5322-ish dump suitable for opening
// with `less` or `mu`. Not a real .eml — just enough for human
// inspection.
func renderEML(m Message) string {
	if len(m.Raw) > 0 {
		return string(m.Raw)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "From: %s\n", m.From)
	fmt.Fprintf(&sb, "To: %s\n", m.To)
	if m.ReplyTo != "" {
		fmt.Fprintf(&sb, "Reply-To: %s\n", m.ReplyTo)
	}
	fmt.Fprintf(&sb, "Subject: %s\n", m.Subject)
	for k, v := range m.Tags {
		fmt.Fprintf(&sb, "X-Tag-%s: %s\n", k, v)
	}
	sb.WriteString("\n")
	if m.Body != "" {
		sb.WriteString(m.Body)
		sb.WriteString("\n")
	}
	if m.HTMLBody != "" {
		sb.WriteString("\n--- HTML ---\n")
		sb.WriteString(m.HTMLBody)
		sb.WriteString("\n")
	}
	return sb.String()
}

// sanitize trims a string into something safe to use as part of a
// filename (no path traversal, no spaces). Keep it conservative; the
// only correctness requirement is "doesn't break ext4/apfs."
func sanitize(s string) string {
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	s = strings.ReplaceAll(s, "..", "_")
	s = strings.ReplaceAll(s, " ", "_")
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}
