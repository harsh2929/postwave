// SPDX-License-Identifier: AGPL-3.0-only
//
// segment.go — native Segment CDP inbound runtime.
//
// Segment is the canonical event pipe for the mid-market: a native Segment
// destination ingests the customer's entire identify/track stream in one
// integration. This file is the translation core (Segment spec -> canonical
// profile/event) plus the optional shared-secret signature verifier; the public
// ingest endpoint and per-integration token routing live in segment_ingest.go.
package analytics_integrations

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type segmentEvent struct {
	Type        string         `json:"type"`
	MessageID   string         `json:"messageId"`
	UserID      string         `json:"userId"`
	AnonymousID string         `json:"anonymousId"`
	Event       string         `json:"event"`
	Traits      map[string]any `json:"traits"`
	Properties  map[string]any `json:"properties"`
	Context     struct {
		Traits map[string]any `json:"traits"`
	} `json:"context"`
	Timestamp string `json:"timestamp"`
}

// mapSegmentEvent translates a single Segment identify/track payload into a
// canonical profile or event upsert. Other event types (page/screen/group/etc.)
// and identity-less events are skipped.
func mapSegmentEvent(body []byte) (SyncRequest, bool) {
	return mapCDPEvent(body, "segment")
}

// mapCDPEvent translates a single Segment-spec identify/track payload (used by
// Segment and any spec-compatible CDP such as RudderStack) into a canonical
// profile or event upsert. The scheme parameter namespaces the source IDs.
func mapCDPEvent(body []byte, scheme string) (SyncRequest, bool) {
	var ev segmentEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return SyncRequest{}, false
	}
	switch strings.ToLower(strings.TrimSpace(ev.Type)) {
	case "identify":
		email := strings.ToLower(strings.TrimSpace(firstSegment(
			segmentTrait(ev.Traits, "email"),
			segmentTrait(ev.Context.Traits, "email"),
		)))
		if email == "" {
			return SyncRequest{}, false
		}
		p := ProfileInput{
			SourceID:    scheme + "://identify/" + firstSegment(strings.TrimSpace(ev.MessageID), email),
			Email:       email,
			UserID:      strings.TrimSpace(ev.UserID),
			AnonymousID: strings.TrimSpace(ev.AnonymousID),
			FirstName:   segmentTrait(ev.Traits, "firstName"),
			LastName:    segmentTrait(ev.Traits, "lastName"),
			FullName:    segmentTrait(ev.Traits, "name"),
			Phone:       segmentTrait(ev.Traits, "phone"),
			Traits:      ev.Traits,
		}
		if t := parseSegmentTime(ev.Timestamp); t != nil {
			p.UpdatedAt = t
		}
		return SyncRequest{RunMode: "webhook", Profiles: []ProfileInput{p}}, true
	case "track":
		email := strings.ToLower(strings.TrimSpace(firstSegment(
			segmentTrait(ev.Properties, "email"),
			segmentTrait(ev.Context.Traits, "email"),
			segmentTrait(ev.Traits, "email"),
		)))
		if email == "" && strings.TrimSpace(ev.UserID) == "" {
			return SyncRequest{}, false
		}
		e := EventInput{
			SourceID:    scheme + "://track/" + firstSegment(strings.TrimSpace(ev.MessageID), strings.TrimSpace(ev.Event)),
			Email:       email,
			UserID:      strings.TrimSpace(ev.UserID),
			AnonymousID: strings.TrimSpace(ev.AnonymousID),
			EventName:   strings.TrimSpace(ev.Event),
			Properties:  ev.Properties,
		}
		if t := parseSegmentTime(ev.Timestamp); t != nil {
			e.OccurredAt = t
		}
		return SyncRequest{RunMode: "webhook", Events: []EventInput{e}}, true
	default:
		return SyncRequest{}, false
	}
}

func segmentTrait(traits map[string]any, key string) string {
	if traits == nil {
		return ""
	}
	if v, ok := traits[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func firstSegment(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func parseSegmentTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05Z"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

// segmentHexHMAC reproduces Segment's Webhooks-destination signature
// (hex(HMAC-SHA1(sharedSecret, body))), exposed as X-Signature.
func segmentHexHMAC(secret string, body []byte) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifySegmentSignature validates the optional Segment webhook shared-secret
// signature. An empty configured secret disables verification (Segment webhook
// signing is optional).
func VerifySegmentSignature(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	header = strings.TrimSpace(header)
	if _, after, found := strings.Cut(header, "="); found {
		header = strings.TrimSpace(after)
	}
	if header == "" {
		return fmt.Errorf("segment webhook signature is required")
	}
	expected := segmentHexHMAC(secret, body)
	if !hmac.Equal([]byte(strings.ToLower(expected)), []byte(strings.ToLower(header))) {
		return fmt.Errorf("segment webhook signature mismatch")
	}
	return nil
}
