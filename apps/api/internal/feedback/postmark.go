// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// postmarkPayload models the subset of Postmark's webhook envelope we
// inspect. Postmark sends a single object per event (not an array). The
// `Type` field discriminates the bounce class; SpamComplaint is a
// complaint, not a bounce, and is routed to ParsePostmarkComplaint by
// the handler.
//
// Reference: https://postmarkapp.com/developer/webhooks/bounce-webhook
type postmarkPayload struct {
	Type        string `json:"Type"`
	Email       string `json:"Email"`
	MessageID   string `json:"MessageID"`
	Description string `json:"Description"`
	Details     string `json:"Details"`
	BouncedAt   string `json:"BouncedAt"`
}

// ParsePostmarkBounce converts a Postmark bounce webhook body into a
// canonical BounceEvent. Postmark's `Type` values map as:
//
//	HardBounce → hard
//	SoftBounce → soft
//	Transient  → transient
//
// SpamComplaint is NOT a bounce; the handler routes that Type to
// ParsePostmarkComplaint instead. Other Postmark `Type` values (e.g.
// SubscriptionChange) are rejected as not-a-bounce.
func ParsePostmarkBounce(body []byte) (*BounceEvent, error) {
	var p postmarkPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("postmark: bad json: %w", err)
	}
	if strings.TrimSpace(p.Email) == "" {
		return nil, fmt.Errorf("postmark: missing Email")
	}
	var bounceType string
	switch p.Type {
	case "HardBounce":
		bounceType = "hard"
	case "SoftBounce":
		bounceType = "soft"
	case "Transient":
		bounceType = "transient"
	case "SpamComplaint":
		return nil, fmt.Errorf("postmark: SpamComplaint is a complaint, route to ParsePostmarkComplaint")
	case "":
		return nil, fmt.Errorf("postmark: missing Type")
	default:
		return nil, fmt.Errorf("postmark: unrecognized bounce Type %q", p.Type)
	}
	return &BounceEvent{
		SubscriberEmail: strings.TrimSpace(p.Email),
		BounceType:      bounceType,
		ESP:             "postmark",
		ESPMessageID:    strings.TrimSpace(p.MessageID),
		Raw:             json.RawMessage(append([]byte(nil), body...)),
		ReceivedAt:      parsePostmarkTime(p.BouncedAt),
	}, nil
}

// ParsePostmarkComplaint converts a Postmark SpamComplaint payload into a
// ComplaintEvent. We accept either a literal SpamComplaint Type or any
// payload that names an Email — the handler always calls this when the
// Type discriminator says `SpamComplaint`.
func ParsePostmarkComplaint(body []byte) (*ComplaintEvent, error) {
	var p postmarkPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("postmark: bad json: %w", err)
	}
	if strings.TrimSpace(p.Email) == "" {
		return nil, fmt.Errorf("postmark: missing Email")
	}
	if p.Type != "" && p.Type != "SpamComplaint" {
		return nil, fmt.Errorf("postmark: not a complaint Type=%q", p.Type)
	}
	return &ComplaintEvent{
		SubscriberEmail: strings.TrimSpace(p.Email),
		ComplaintType:   "spam",
		ESP:             "postmark",
		ESPMessageID:    strings.TrimSpace(p.MessageID),
		Raw:             json.RawMessage(append([]byte(nil), body...)),
		ReceivedAt:      parsePostmarkTime(p.BouncedAt),
	}, nil
}

// parsePostmarkTime tolerates Postmark's RFC3339 timestamps (with or
// without sub-second precision). On parse failure we fall back to the
// zero time so the repo stamps now() at insert.
func parsePostmarkTime(in string) time.Time {
	in = strings.TrimSpace(in)
	if in == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, in); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, in); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
