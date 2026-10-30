// SPDX-License-Identifier: AGPL-3.0-only
//
// Package mailer is the system-of-record for outbound transactional
// email — verify-your-email, password reset, magic link, security
// notifications. NOT to be confused with the campaign-send pipeline,
// which routes through Listmonk.
//
// Two implementations:
//
//   - DevMailer: logs the rendered email (subject + body + recipient)
//     to slog and optionally writes a copy to a directory under
//     /tmp. Used for local dev and CI; never call in prod.
//
//   - SESMailer: AWS SES SendEmail (v2). Lives in mailer_ses.go behind
//     the `ses` build tag so the dev binary can ship without the SDK.
//
// Pick one in main.go via env (POSTWAVE_MAILER=ses|dev).
//
// AWS-readiness:
//
//   - SES requires the sending domain (DKIM-signed) to be verified in
//     the Moosewave AWS account. The IAM role attached to the ECS
//     task needs `ses:SendEmail` (and `ses:SendRawEmail` for future
//     attachments). Document the policy in docs/runbooks/auth-aws.md.
//   - Bounce + complaint feedback already lands in /api/internal/feedback/*
//     via the SES topic SNS subscription — same FBL pipeline shipped
//     in Phase 10 handles transactional bounces too.
package mailer

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Message is the typed envelope all callers send. Body is plain text;
// HTMLBody is optional and rendered as multipart/alternative when set.
type Message struct {
	// TenantID is server-owned attribution metadata. It is never accepted
	// from a public request body. SESMailer converts it into a reserved SES
	// message tag so authenticated bounce/complaint events can be bound to one
	// tenant without recipient-email fan-out.
	TenantID string

	From     string // "Moosewave <noreply@moosewave.com>"
	To       string
	Subject  string
	Body     string // text/plain
	HTMLBody string // optional; text/html

	// ReplyTo lets users hit reply on auth emails and reach support.
	// Defaults to From when blank.
	ReplyTo string

	// Tags get forwarded to SES as message tags so ops can filter
	// CloudWatch dashboards by purpose ("verify_email", "reset", etc).
	Tags map[string]string

	// --- Optional fields for the public transactional send API (Resend
	// parity). All zero-valued for the internal auth/system mail callers, so
	// they stay fully backward compatible. ---

	// ToList, when non-empty, replaces the single To with a multi-recipient
	// envelope. Cc/Bcc are additive secondary recipients.
	ToList []string
	Cc     []string
	Bcc    []string

	// Headers are arbitrary custom MIME headers (e.g. "X-Entity-Ref-ID").
	Headers map[string]string

	// Attachments ride on the message as MIME parts (SES SendEmail v2
	// Simple.Attachments). Keep the total message under ~40 MB (SES ceiling).
	Attachments []Attachment

	// Raw, when set, is a complete pre-built MIME message (the SMTP relay path).
	// It is sent verbatim (SES SendEmail v2 Content.Raw); Subject/Body/Headers/
	// Attachments are ignored. ToList/Cc/Bcc + From still form the envelope.
	Raw []byte
}

// Attachment is one file on an outbound message. Content is the raw
// (already-decoded) bytes; the ESP layer base64-encodes for the wire.
type Attachment struct {
	Filename    string
	Content     []byte
	ContentType string // defaults to application/octet-stream
	// Inline + ContentID render the part inline (e.g. an embedded image
	// referenced by cid:ContentID) rather than as a download.
	Inline    bool
	ContentID string
}

// Validate is the cheap precondition check. SendEmail callers should
// run it before round-tripping to the ESP.
func (m Message) Validate() error {
	if tenantID := strings.TrimSpace(m.TenantID); tenantID != "" {
		if _, err := uuid.Parse(tenantID); err != nil {
			return fmt.Errorf("TenantID must be a UUID: %w", err)
		}
	}
	if m.From == "" {
		return errors.New("From is required")
	}
	if m.To == "" && len(m.ToList) == 0 {
		return errors.New("To is required")
	}
	// A raw MIME message carries its own Subject/Body inside the bytes.
	if len(m.Raw) > 0 {
		return nil
	}
	if m.Subject == "" {
		return errors.New("Subject is required")
	}
	if m.Body == "" && m.HTMLBody == "" {
		return errors.New("Body or HTMLBody is required")
	}
	return nil
}

// Mailer is the interface every transactional sender satisfies.
// Implementations must be safe for concurrent use.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// DeliveryReceipt is optional provider evidence returned by mailers that can
// expose it. Callers must still treat a successful Send without a receipt as a
// successful delivery attempt; ReceiptMailer is an additive capability.
type DeliveryReceipt struct {
	ProviderMessageID string
}

// ReceiptMailer lets tenant send ledgers persist the provider message ID used
// later for cryptographically bound feedback attribution.
type ReceiptMailer interface {
	Mailer
	SendWithReceipt(ctx context.Context, m Message) (DeliveryReceipt, error)
}
