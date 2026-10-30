// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// sendgridEvent models the subset of SendGrid's event-webhook envelope we
// care about. SendGrid POSTs an array of these objects; one batch can
// mix delivery + open + bounce + spamreport rows for many recipients,
// so we filter to bounce/dropped/spamreport here.
//
// Reference: https://docs.sendgrid.com/for-developers/tracking-events/event
type sendgridEvent struct {
	Event                string `json:"event"`
	Email                string `json:"email"`
	SGMessageID          string `json:"sg_message_id"`
	Type                 string `json:"type"`
	Reason               string `json:"reason"`
	Timestamp            int64  `json:"timestamp"`
	BounceClassification string `json:"bounce_classification"`
}

// ParseSendGridBatch converts a SendGrid event-webhook body into separate
// bounce + complaint slices. Filters out non-feedback events (delivered,
// open, click, etc) silently — those are handled by the listmonk_events
// pipeline upstream.
//
// Mapping:
//
//	event=bounce   → BounceEvent. bounce_type=hard if
//	                  bounce_classification == "Invalid Mailbox", else soft.
//	event=dropped  → BounceEvent. SendGrid `dropped` is a pre-send rejection
//	                  (e.g. Invalid SMTPAPI), modelled as a hard bounce.
//	event=spamreport → ComplaintEvent (complaint_type=spam).
//
// Returns ([], [], nil) for an empty array; that's a valid (no-op) batch.
func ParseSendGridBatch(body []byte) ([]BounceEvent, []ComplaintEvent, error) {
	var events []sendgridEvent
	if err := json.Unmarshal(body, &events); err != nil {
		return nil, nil, fmt.Errorf("sendgrid: bad json: %w", err)
	}
	bounces := []BounceEvent{}
	complaints := []ComplaintEvent{}
	for i, e := range events {
		email := strings.TrimSpace(e.Email)
		if email == "" {
			// Skip rows missing recipient — SendGrid occasionally emits
			// account-level events that don't address a recipient.
			continue
		}
		ts := time.Time{}
		if e.Timestamp > 0 {
			ts = time.Unix(e.Timestamp, 0).UTC()
		}
		raw, err := json.Marshal(events[i])
		if err != nil {
			return nil, nil, fmt.Errorf("sendgrid: re-marshal event %d: %w", i, err)
		}
		switch e.Event {
		case "bounce":
			bounceType := "soft"
			if strings.EqualFold(strings.TrimSpace(e.BounceClassification), "Invalid Mailbox") {
				bounceType = "hard"
			}
			bounces = append(bounces, BounceEvent{
				SubscriberEmail: email,
				BounceType:      bounceType,
				ESP:             "sendgrid",
				ESPMessageID:    strings.TrimSpace(e.SGMessageID),
				Raw:             json.RawMessage(raw),
				ReceivedAt:      ts,
			})
		case "dropped":
			bounces = append(bounces, BounceEvent{
				SubscriberEmail: email,
				BounceType:      "hard",
				ESP:             "sendgrid",
				ESPMessageID:    strings.TrimSpace(e.SGMessageID),
				Raw:             json.RawMessage(raw),
				ReceivedAt:      ts,
			})
		case "spamreport":
			complaints = append(complaints, ComplaintEvent{
				SubscriberEmail: email,
				ComplaintType:   "spam",
				ESP:             "sendgrid",
				ESPMessageID:    strings.TrimSpace(e.SGMessageID),
				Raw:             json.RawMessage(raw),
				ReceivedAt:      ts,
			})
		default:
			// Non-feedback event; ignore.
		}
	}
	return bounces, complaints, nil
}
