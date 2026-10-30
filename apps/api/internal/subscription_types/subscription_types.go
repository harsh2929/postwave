// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subscription_types owns the per-tenant catalog of subscription
// categories (a la HubSpot subscription types, Resend Unsubscribe Topics,
// SendGrid ASM groups) and the per-subscriber opt-out ledger.
//
// Backed by tables `subscription_types` and `subscription_type_opt_outs`
// from migration 0247. Absence of an opt-out row means the subscriber is
// opted IN to that type on that channel — i.e. opt-out is the negation of
// the default.
package subscription_types

import "time"

// Channel mirrors the CHECK constraint in 0247_subscription_types.sql.
type Channel string

const (
	ChannelEmail Channel = "email"
	ChannelSMS   Channel = "sms"
	ChannelPush  Channel = "push"
	ChannelAll   Channel = "all"
)

// ValidChannels lets handlers pre-validate without round-tripping to PG.
var ValidChannels = map[Channel]bool{
	ChannelEmail: true,
	ChannelSMS:   true,
	ChannelPush:  true,
	ChannelAll:   true,
}

// OptOutSource is the CHECK enum on subscription_type_opt_outs.source.
type OptOutSource string

const (
	SourcePreferenceCenter OptOutSource = "preference_center"
	SourceAPI              OptOutSource = "api"
	SourceAdmin            OptOutSource = "admin"
	SourceOneClick         OptOutSource = "one_click"
	SourceImport           OptOutSource = "import"
	SourceWebhook          OptOutSource = "webhook"
)

var validOptOutSources = map[OptOutSource]bool{
	SourcePreferenceCenter: true,
	SourceAPI:              true,
	SourceAdmin:            true,
	SourceOneClick:         true,
	SourceImport:           true,
	SourceWebhook:          true,
}

// SubscriptionType mirrors one row of subscription_types.
type SubscriptionType struct {
	ID          string    `json:"id"`
	TenantID    string    `json:"tenant_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Channel     Channel   `json:"channel"`
	IsDefault   bool      `json:"is_default"`
	IsInternal  bool      `json:"is_internal"`
	SortOrder   int       `json:"sort_order"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// SubscriberView is one row of the per-subscriber list. OptedOut is true
// iff there's a matching opt-out row for the (subscriber, type, channel)
// tuple; false (the default) means the subscriber is still subscribed.
type SubscriberView struct {
	Type       SubscriptionType `json:"type"`
	OptedOut   bool             `json:"opted_out"`
	OptedOutAt *time.Time       `json:"opted_out_at,omitempty"`
	Source     OptOutSource     `json:"source,omitempty"`
	Channel    Channel          `json:"channel,omitempty"`
}

// CreateInput is the body of POST /api/v1/subscription-types.
type CreateInput struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Channel     Channel `json:"channel,omitempty"`
	IsDefault   bool    `json:"is_default,omitempty"`
	SortOrder   int     `json:"sort_order,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/subscription-types/{id}.
// All fields optional; nil pointer means "leave alone".
type UpdateInput struct {
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Channel     *Channel `json:"channel,omitempty"`
	IsDefault   *bool    `json:"is_default,omitempty"`
	SortOrder   *int     `json:"sort_order,omitempty"`
}

// OptOutInput is the body of POST /…/opt-out. All fields optional;
// channel defaults to the subscription type's channel and source
// defaults to api when the caller is an authenticated agent.
type OptOutInput struct {
	Channel       Channel      `json:"channel,omitempty"`
	Source        OptOutSource `json:"source,omitempty"`
	SourceEventID string       `json:"source_event_id,omitempty"`
}
