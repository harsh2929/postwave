// SPDX-License-Identifier: AGPL-3.0-only
//
// Package webhooks owns the outbound webhook subscription admin surface +
// the delivery log. The dispatcher itself (event fan-out, retries with
// exponential backoff, signing) is intentionally NOT here in V1 — that
// belongs in services/* once we shard event ingestion. This package only
// stores subscriptions, hashes the signing secret, records deliveries, and
// exposes a "send test event" entrypoint that exercises the same outbound
// HTTP path the dispatcher will use.
package webhooks

import "time"

// EventType is one of the catalog of events Moosewave can emit. The catalog
// is fixed at the gateway layer — adding a new event requires a code change
// here AND a producer in the relevant service.
type EventType string

const (
	EventSubscriberCreated      EventType = "subscriber.created"
	EventSubscriberUpdated      EventType = "subscriber.updated"
	EventSubscriberConfirmed    EventType = "subscriber.confirmed"
	EventSubscriberUnsubscribed EventType = "subscriber.unsubscribed"
	EventSubscriberBounced      EventType = "subscriber.bounced"
	EventSubscriberComplained   EventType = "subscriber.complained"
	// SUB-118 — full subscriber lifecycle event catalog. These four close the
	// outbound-webhook coverage gaps so a tenant can subscribe to deletes,
	// merges, and the status / consent transitions the subscribers repo now
	// fires (apps/api/internal/subscribers/repo.go). The producers live in the
	// subscribers package; this catalog only registers them as subscribable.
	EventSubscriberDeleted        EventType = "subscriber.deleted"
	EventSubscriberMerged         EventType = "subscriber.merged"
	EventSubscriberStatusChanged  EventType = "subscriber.status_changed"
	EventSubscriberConsentChanged EventType = "subscriber.consent_changed"
	EventCampaignSent             EventType = "campaign.sent"
	// Per-recipient open/click events are catalog-listed but firing
	// one webhook per row would mean N×subscribers events per campaign
	// — easily 10k-100k for a real send. The expected pattern is to
	// subscribe to the .digest variants below, which are emitted
	// hourly per (tenant, campaign) by the analytics digest cron
	// (apps/api/internal/analytics/digest.go) with a per-window
	// rollup + top-clicked links payload.
	EventCampaignOpened       EventType = "campaign.opened"
	EventCampaignClicked      EventType = "campaign.clicked"
	EventCampaignOpensDigest  EventType = "campaign.opens.digest"
	EventCampaignClicksDigest EventType = "campaign.clicks.digest"
	EventAutomationCompleted  EventType = "automation.completed"
	// EventAutomationFailed has no producer in V1: failure paths in
	// the automation engine return errors that asynq retries until
	// exhausted, with no clean "give up forever" hook at the engine
	// layer. Wiring this requires hooking asynq's terminal-failure
	// callback in services/automation/main.go.
	EventAutomationFailed   EventType = "automation.failed"
	EventMigrationCompleted EventType = "migration.completed"
	EventMigrationFailed    EventType = "migration.failed"
	EventFormSubmitted      EventType = "form.submitted"
	EventFormConfirmed      EventType = "form.confirmed"
	EventSequenceGenerated  EventType = "sequence.generated"
	// EventSequenceParticipantsStuck is emitted by the voice service's stuck
	// scanner (services/voice/internal/stuckworker) once a sweep, for every
	// sequence with `stuck_after_days >= 1` that has participants idling past
	// the threshold.
	//
	// AUTOMATION#41 — IT WAS MISSING FROM THIS CATALOG, and that was not
	// cosmetic. services/voice is a separate module, so it announces by writing
	// a `webhook.fanout` outbox row; FanoutHandler DLQs any row whose event
	// type fails IsValidEvent. The scanner has therefore been detecting stuck
	// participants and dead-ending every alert in the DLQ — no webhook, no
	// integration, no notification, and no error anyone would see, because a
	// DLQ row is exactly as quiet as the condition it was reporting.
	EventSequenceParticipantsStuck EventType = "sequence.participants.stuck"
	// EventApprovalRequested fires when a pending approvals row is
	// created. approvals.Repo inserts both the approval and its legacy
	// compatibility outbox intent in the same transaction; per-user mobile
	// push is delivered independently through the session-scoped sender.
	EventApprovalRequested EventType = "approval.requested"
)

// AllEvents is the canonical list. Mirrored in the admin UI multi-select.
var AllEvents = []EventType{
	EventSubscriberCreated, EventSubscriberUpdated, EventSubscriberConfirmed,
	EventSubscriberUnsubscribed, EventSubscriberBounced, EventSubscriberComplained,
	// SUB-118 lifecycle additions.
	EventSubscriberDeleted, EventSubscriberMerged,
	EventSubscriberStatusChanged, EventSubscriberConsentChanged,
	EventCampaignSent, EventCampaignOpened, EventCampaignClicked,
	EventCampaignOpensDigest, EventCampaignClicksDigest,
	EventAutomationCompleted, EventAutomationFailed,
	EventMigrationCompleted, EventMigrationFailed,
	EventFormSubmitted, EventFormConfirmed,
	EventSequenceGenerated, EventSequenceParticipantsStuck,
	EventApprovalRequested,
}

// IsValidEvent reports whether s is one of AllEvents.
func IsValidEvent(s string) bool {
	for _, e := range AllEvents {
		if string(e) == s {
			return true
		}
	}
	return false
}

// Status is the operational state surfaced in the admin list.
type Status string

const (
	StatusActive  Status = "active"
	StatusPaused  Status = "paused"
	StatusFailing Status = "failing"
)

// Webhook mirrors the webhooks table.
type Webhook struct {
	ID       string      `json:"id"`
	TenantID string      `json:"tenantId"`
	URL      string      `json:"url"`
	Events   []EventType `json:"events"`
	Status   Status      `json:"status"`
	// Environment tag: production | staging | development. Defaults
	// to "production". Today this is a label for organisation +
	// filtering; dispatcher routing by env is a future PR.
	Environment string    `json:"environment"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// LastDelivery is the most recent webhook_deliveries row, if any.
	LastDelivery *Delivery `json:"lastDelivery,omitempty"`
}

// CreateInput is the body of POST /api/v1/webhooks.
type CreateInput struct {
	URL    string      `json:"url"`
	Events []EventType `json:"events"`
}

// UpdateInput is the body of PATCH /api/v1/webhooks/{id}.
type UpdateInput struct {
	URL    *string      `json:"url,omitempty"`
	Events *[]EventType `json:"events,omitempty"`
	Status *Status      `json:"status,omitempty"`
}

// CreateResponse returns the freshly-minted plaintext signing secret to the
// caller exactly once. Subsequent fetches only return the prefix-truncated
// hint stored alongside the hash.
type CreateResponse struct {
	Webhook Webhook `json:"webhook"`
	Secret  string  `json:"secret"`
}

// Delivery is one row in webhook_deliveries.
type Delivery struct {
	ID         int64     `json:"id"`
	WebhookID  string    `json:"webhookId"`
	Event      string    `json:"event"`
	StatusCode int       `json:"statusCode"`
	Attempt    int       `json:"attempt"`
	ResponseMS int       `json:"responseMs"`
	Error      string    `json:"error,omitempty"`
	At         time.Time `json:"at"`
}

// DeliveryDetail is one delivery plus its retained request payload (SETA-004).
// RequestBody is the wire-format JSON the dispatcher posted (the WireEnvelope);
// PayloadRetained is false when payload_bytes was NULL (retention disabled, or
// the row pre-dates migration 0050) — the metadata is still returned so the
// admin can inspect status/latency/error even without a body.
type DeliveryDetail struct {
	Delivery
	RequestBody     string `json:"requestBody"`
	PayloadRetained bool   `json:"payloadRetained"`
}
