// SPDX-License-Identifier: AGPL-3.0-only

// Push channels: the two ways the ops console reaches a human — a Slack
// incoming webhook and an email seam. Channels are dumb pipes on purpose;
// dedup, escalation, and scheduling all live in the pusher, so a channel
// only ever answers "did this one message get out?".

package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// PushKind is what a message IS, not how urgent it is. Severity carries
// urgency; kind picks the emoji and lets the pusher route/dedup.
type PushKind string

const (
	PushAlert    PushKind = "alert"
	PushResolved PushKind = "resolved"
	PushRepush   PushKind = "repush"
	PushDigest   PushKind = "digest"
	PushCanary   PushKind = "canary"
)

type PushMessage struct {
	Kind     PushKind
	CheckID  string   // empty for digest
	Severity Severity // zero for digest/canary
	Title    string
	Body     string
}

// Channel is one delivery pipe. Send is synchronous and returns an error the
// caller can count against the channel; it must not retry internally.
type Channel interface {
	Name() string // "slack" | "email"
	Send(ctx context.Context, m PushMessage) error
}

// EmailSender is the narrow seam main.go adapts authMailer onto — mirrors how
// billing/webhook_retry keeps its own Mailer interface rather than importing
// a concrete mailer.
type EmailSender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// emoji maps kind (and, for alerts, severity) to the prefix glyph. An alert
// that is not critical renders orange: the board's red/orange split is
// critical vs everything-else, and the push layer follows it.
func emoji(m PushMessage) string {
	switch m.Kind {
	case PushAlert:
		if m.Severity == SevCritical {
			return "🔴"
		}
		return "🟠"
	case PushResolved:
		return "✅"
	case PushRepush:
		return "⏰"
	case PushDigest:
		return "🗞️"
	case PushCanary:
		return "🪶"
	}
	return ""
}

// formatText renders the plain-text Slack payload: emoji prefix, bold title,
// body on the next line. Deliberately not Block Kit — a text-only payload is
// portable across Slack-compatible webhook sinks and trivially assertable.
func formatText(m PushMessage) string {
	text := "*" + m.Title + "*\n" + m.Body
	if e := emoji(m); e != "" {
		return e + " " + text
	}
	return text
}

// SlackWebhookChannel posts {"text": ...} to a Slack incoming webhook.
type SlackWebhookChannel struct {
	url string
	hc  *http.Client
}

// NewSlackWebhookChannel wraps an operator-configured incoming-webhook URL.
// No URL-prefix validation: the URL is operator-set, and local verification
// points it at a loopback sink. A nil client gets a 10s-timeout default so a
// hung webhook can never wedge the pusher.
func NewSlackWebhookChannel(url string, hc *http.Client) *SlackWebhookChannel {
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	return &SlackWebhookChannel{url: url, hc: hc}
}

func (c *SlackWebhookChannel) Name() string { return "slack" }

// Send is strict about success: 2xx AND a body of exactly "ok" (modulo
// whitespace). Slack answers 200 with an error string for some failure modes
// (e.g. "no_service"), so trusting the status code alone would count dropped
// messages as delivered. Every failure carries status + body snippet.
func (c *SlackWebhookChannel) Send(ctx context.Context, m PushMessage) error {
	payload, err := json.Marshal(map[string]string{"text": formatText(m)})
	if err != nil {
		return fmt.Errorf("slack webhook: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("slack webhook: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("slack webhook: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Slack's answer is a short token; 512 bytes is plenty for a snippet and
	// caps what a misconfigured URL can feed us.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	ok := resp.StatusCode >= 200 && resp.StatusCode < 300 &&
		strings.TrimSpace(string(body)) == "ok"
	if !ok {
		return fmt.Errorf("slack webhook: status %d, body %q", resp.StatusCode,
			strings.TrimSpace(string(body)))
	}
	return nil
}

var _ Channel = (*SlackWebhookChannel)(nil)

// EmailChannel adapts an EmailSender into a Channel aimed at one recipient.
type EmailChannel struct {
	sender EmailSender
	to     string
}

func NewEmailChannel(s EmailSender, to string) *EmailChannel {
	return &EmailChannel{sender: s, to: to}
}

func (c *EmailChannel) Name() string { return "email" }

// Send puts the emoji in the subject — "[postwave-ops] 🔴 Title" — so an
// inbox skim carries the same signal as the Slack channel. Body goes as-is.
func (c *EmailChannel) Send(ctx context.Context, m PushMessage) error {
	subject := "[postwave-ops] " + m.Title
	if e := emoji(m); e != "" {
		subject = "[postwave-ops] " + e + " " + m.Title
	}
	return c.sender.Send(ctx, c.to, subject, m.Body)
}

var _ Channel = (*EmailChannel)(nil)
