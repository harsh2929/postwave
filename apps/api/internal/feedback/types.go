// SPDX-License-Identifier: AGPL-3.0-only
//
// Package feedback ingests deliverability feedback (bounces + complaints)
// from the ESP layer beneath Listmonk. Every ESP has a different webhook
// shape; package-local parsers reduce them to BounceEvent / ComplaintEvent
// which the repo persists and projects into the existing email_suppressions
// table so the next send attempt skips the recipient.
package feedback

import (
	"encoding/json"
	"time"
)

// BounceEvent is the canonical bounce row we persist to bounce_events.
// Field names match the column names so json marshalling round-trips
// cleanly into the DB raw column for support tooling.
type BounceEvent struct {
	ID              int64  `json:"id,omitempty"`
	TenantID        string `json:"tenant_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email"`
	// BounceType is one of "hard", "soft", "transient". Hard bounces are
	// permanent failures (mailbox does not exist, domain dead); soft
	// bounces are transient throttling/quota errors.
	BounceType   string          `json:"bounce_type"`
	ESP          string          `json:"esp"`
	ESPMessageID string          `json:"esp_message_id,omitempty"`
	Raw          json.RawMessage `json:"raw,omitempty"`
	ReceivedAt   time.Time       `json:"received_at"`
}

// ComplaintEvent is the canonical complaint row we persist to
// complaint_events.
type ComplaintEvent struct {
	ID              int64  `json:"id,omitempty"`
	TenantID        string `json:"tenant_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email"`
	// ComplaintType is one of "abuse", "fbl", "spam". "fbl" is what we
	// produce from RFC 5965 ARF reports; "spam" is what we produce from
	// Postmark/SendGrid spamreport events; "abuse" is reserved for direct
	// abuse-desk forwards.
	ComplaintType string          `json:"complaint_type"`
	ESP           string          `json:"esp,omitempty"`
	ESPMessageID  string          `json:"esp_message_id,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
	ReceivedAt    time.Time       `json:"received_at"`
}
