// Package listmonk_events ingests engagement webhooks from the Listmonk
// fork (open / click / bounce / complaint) into our subscriber_events log
// and dispatches them to the automation runtime so that engagement-based
// triggers can fire.
//
// Listmonk's webhook payload shape is loosely defined; the upstream project
// documents one envelope per event with a `type` discriminator and a `data`
// blob. We accept a tolerant superset and translate to our canonical event.
package listmonk_events

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Listmonk event type strings on the wire. Bounce + complaint are surfaced
// by Listmonk's transactional engine; opens/clicks come from its tracking
// pixel + redirect.
const (
	WireOpened       = "subscriber.opened"
	WireClicked      = "subscriber.clicked"
	WireDelivered    = "subscriber.delivered"
	WireBounced      = "subscriber.bounced"
	WireComplained   = "subscriber.complained"
	WireUnsubscribed = "subscriber.unsubscribed"
)

// CanonicalEventType is the value persisted in subscriber_events.event_type.
type CanonicalEventType string

const (
	EventOpened       CanonicalEventType = "opened"
	EventClicked      CanonicalEventType = "clicked"
	EventDelivered    CanonicalEventType = "delivered"
	EventBounced      CanonicalEventType = "bounced"
	EventComplained   CanonicalEventType = "complained"
	EventUnsubscribed CanonicalEventType = "unsubscribed"
)

// WebhookEnvelope is the top-level Listmonk webhook payload. Listmonk batches
// events by default; we accept either a single envelope or a JSON array via
// the handler's tolerant decoder.
type WebhookEnvelope struct {
	ProviderEventMetadata
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
	// At is when Listmonk emitted the event; we fall back to now() if absent.
	At time.Time `json:"at"`
	// TenantID is injected by the gateway when Listmonk is multi-tenanted.
	// Listmonk's vanilla webhook does not include it, so the ingester maps
	// (campaign_id -> tenant_id) via a lookup.
	TenantID string `json:"tenant_id,omitempty"`
}

// ProviderEventMetadata carries provider-specific ids that let ingestion dedupe
// webhook retries without coupling to one exact payload shape.
type ProviderEventMetadata struct {
	ID              string `json:"id,omitempty"`
	UUID            string `json:"uuid,omitempty"`
	EventID         string `json:"event_id,omitempty"`
	ProviderEventID string `json:"provider_event_id,omitempty"`
	MessageID       string `json:"message_id,omitempty"`
	Source          string `json:"source,omitempty"`
}

// SubscriberRef is the embedded subscriber projection Listmonk attaches to
// every engagement event.
type SubscriberRef struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

// CampaignRef is the embedded campaign projection.
type CampaignRef struct {
	ID   string `json:"id"`
	UUID string `json:"uuid,omitempty"`
}

// OpenedEventData matches the body of a Listmonk open webhook.
type OpenedEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	UserAgent  string        `json:"user_agent,omitempty"`
	IP         string        `json:"ip,omitempty"`
}

// ClickedEventData matches the body of a Listmonk click webhook.
type ClickedEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	URL        string        `json:"url"`
	UserAgent  string        `json:"user_agent,omitempty"`
	IP         string        `json:"ip,omitempty"`
}

// DeliveredEventData matches a provider delivery webhook.
type DeliveredEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	MessageID  string        `json:"message_id,omitempty"`
}

// BouncedEventData matches a Listmonk bounce webhook (hard or soft).
type BouncedEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	Type       string        `json:"type"` // "hard" | "soft"
	Reason     string        `json:"reason,omitempty"`
}

// ComplainedEventData matches a Listmonk complaint (FBL) webhook.
type ComplainedEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	Source     string        `json:"source,omitempty"`
}

// UnsubscribedEventData matches a Listmonk unsubscribe webhook.
type UnsubscribedEventData struct {
	ProviderEventMetadata
	Subscriber SubscriberRef `json:"subscriber"`
	Campaign   CampaignRef   `json:"campaign"`
	Reason     string        `json:"reason,omitempty"`
}

// CanonicalEvent is the normalised event the handler writes to
// subscriber_events and forwards to the automation runtime.
type CanonicalEvent struct {
	TenantID        string             `json:"tenant_id"`
	SubscriberEmail string             `json:"subscriber_email"`
	EventType       CanonicalEventType `json:"event_type"`
	CampaignID      string             `json:"campaign_id,omitempty"`
	LinkURL         string             `json:"link_url,omitempty"`
	UserAgent       string             `json:"user_agent,omitempty"`
	IP              string             `json:"ip,omitempty"`
	Source          string             `json:"source,omitempty"`
	ProviderEventID string             `json:"provider_event_id,omitempty"`
	MessageID       string             `json:"message_id,omitempty"`
	BounceType      string             `json:"bounce_type,omitempty"`
	Reason          string             `json:"reason,omitempty"`
	Metadata        map[string]any     `json:"metadata,omitempty"`
	At              time.Time          `json:"at"`
	// ControlledSeed is internal-only. Production persistence derives it from
	// the durable dispatch ledger; webhook JSON can never set this field.
	ControlledSeed bool `json:"-"`
}

// ErrInvalidPayload is returned for missing or malformed envelopes.
var ErrInvalidPayload = errors.New("listmonk_events: invalid payload")

// Translate decodes one envelope into our CanonicalEvent. Unknown event
// types return ErrInvalidPayload so the caller can decide to drop or 4xx.
func Translate(env WebhookEnvelope) (CanonicalEvent, error) {
	out := CanonicalEvent{
		TenantID: strings.TrimSpace(env.TenantID),
		Metadata: map[string]any{},
		At:       env.At,
	}
	applyProviderMetadata(&out, env.ProviderEventMetadata)
	if out.Source == "" {
		out.Source = "listmonk"
	}
	if out.At.IsZero() {
		out.At = time.Now().UTC()
	}

	switch env.Type {
	case WireOpened:
		var d OpenedEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventOpened
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.UserAgent = strings.TrimSpace(d.UserAgent)
		out.IP = strings.TrimSpace(d.IP)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
	case WireClicked:
		var d ClickedEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventClicked
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.LinkURL = strings.TrimSpace(d.URL)
		out.UserAgent = strings.TrimSpace(d.UserAgent)
		out.IP = strings.TrimSpace(d.IP)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
	case WireDelivered:
		var d DeliveredEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventDelivered
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.MessageID = strings.TrimSpace(d.MessageID)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
	case WireBounced:
		var d BouncedEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventBounced
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.BounceType = strings.ToLower(strings.TrimSpace(d.Type))
		out.Reason = strings.TrimSpace(d.Reason)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
		out.Metadata["bounce_type"] = out.BounceType
		out.Metadata["reason"] = out.Reason
	case WireComplained:
		var d ComplainedEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventComplained
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.Reason = strings.TrimSpace(d.Source)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
		out.Metadata["complaint_source"] = out.Reason
	case WireUnsubscribed:
		var d UnsubscribedEventData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return CanonicalEvent{}, err
		}
		out.EventType = EventUnsubscribed
		out.SubscriberEmail = normalizeEmail(d.Subscriber.Email)
		out.CampaignID = campaignIdentifier(d.Campaign)
		out.Reason = strings.TrimSpace(d.Reason)
		applyProviderMetadata(&out, d.ProviderEventMetadata)
		out.Metadata["wire_type"] = env.Type
		out.Metadata["reason"] = out.Reason
	default:
		return CanonicalEvent{}, ErrInvalidPayload
	}

	if out.SubscriberEmail == "" {
		return CanonicalEvent{}, ErrInvalidPayload
	}
	return out, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func campaignIdentifier(c CampaignRef) string {
	if uuid := strings.TrimSpace(c.UUID); uuid != "" {
		return uuid
	}
	return strings.TrimSpace(c.ID)
}

func applyProviderMetadata(out *CanonicalEvent, meta ProviderEventMetadata) {
	if source := strings.TrimSpace(meta.Source); source != "" {
		out.Source = source
	}
	if providerEventID := providerEventIdentifier(meta); providerEventID != "" {
		out.ProviderEventID = providerEventID
	}
	if messageID := strings.TrimSpace(meta.MessageID); messageID != "" {
		out.MessageID = messageID
	}
}

func providerEventIdentifier(meta ProviderEventMetadata) string {
	for _, candidate := range []string{
		meta.ProviderEventID,
		meta.EventID,
		meta.ID,
		meta.UUID,
	} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
