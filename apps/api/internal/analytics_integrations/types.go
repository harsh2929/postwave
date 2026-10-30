// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import "time"

const (
	ProviderGA4              = "ga4"
	ProviderGoogleTagManager = "google-tag-manager"
	ProviderSegment          = "segment"
	ProviderRudderStack      = "rudderstack"
	ProviderMixpanel         = "mixpanel"
	ProviderAmplitude        = "amplitude"
	ProviderPostHog          = "posthog"
	ProviderHeap             = "heap"
	ProviderHotjar           = "hotjar"
	ProviderFullStory        = "fullstory"
	ProviderPlausible        = "plausible"
	ProviderFathomAnalytics  = "fathom-analytics"
	ProviderMatomo           = "matomo"
	ProviderAdobeAnalytics   = "adobe-analytics"
	ProviderLookerStudio     = "looker-studio"
	ProviderLooker           = "looker"
	ProviderTableau          = "tableau"
	ProviderPowerBI          = "power-bi"
	ProviderMode             = "mode"
	ProviderMetabase         = "metabase"
	ProviderSisense          = "sisense"
	ProviderKissmetrics      = "kissmetrics"
	ProviderWoopra           = "woopra"
	ProviderChartMogul       = "chartmogul"
	ProviderBaremetrics      = "baremetrics"
	ProviderProfitWell       = "profitwell"
	ProviderTripleWhale      = "triple-whale"
	ProviderNorthbeam        = "northbeam"
	ProviderDaasity          = "daasity"
	ProviderGlew             = "glew"
	ProviderPeelInsights     = "peel-insights"
)

type ProviderField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Required bool   `json:"required,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
	Help     string `json:"help,omitempty"`
}

type ProviderSpec struct {
	Provider         string          `json:"provider"`
	Name             string          `json:"name"`
	Category         string          `json:"category"`
	AuthMode         string          `json:"auth_mode"`
	Managed          bool            `json:"managed"`
	RuntimeStatus    string          `json:"runtime_status"`
	SyncModel        string          `json:"sync_model,omitempty"`
	VerificationMode string          `json:"verification_mode,omitempty"`
	Capabilities     []string        `json:"capabilities"`
	RequiredSettings []ProviderField `json:"required_settings"`
	OptionalSettings []ProviderField `json:"optional_settings,omitempty"`
	Scopes           []string        `json:"scopes"`
	SyncObjects      []string        `json:"sync_objects"`
	WebhookTopics    []string        `json:"webhook_topics,omitempty"`
	DocsURL          string          `json:"docs_url"`
}

type Integration struct {
	ID             string         `json:"id"`
	TenantID       string         `json:"tenant_id,omitempty"`
	Provider       string         `json:"provider"`
	Name           string         `json:"name"`
	Status         string         `json:"status"`
	Scopes         []string       `json:"scopes"`
	CredentialsRef string         `json:"credentials_ref,omitempty"`
	Settings       map[string]any `json:"settings,omitempty"`
	SyncCursor     string         `json:"sync_cursor,omitempty"`
	LastSyncAt     *time.Time     `json:"last_sync_at,omitempty"`
	ErrorMessage   string         `json:"error_message,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
}

type IntegrationInput struct {
	Provider       string         `json:"provider"`
	Name           string         `json:"name"`
	Status         string         `json:"status"`
	Scopes         []string       `json:"scopes"`
	CredentialsRef string         `json:"credentials_ref"`
	Settings       map[string]any `json:"settings"`
}

type ProfileInput struct {
	SourceID    string         `json:"source_id,omitempty"`
	Email       string         `json:"email"`
	UserID      string         `json:"user_id,omitempty"`
	AnonymousID string         `json:"anonymous_id,omitempty"`
	FirstName   string         `json:"first_name,omitempty"`
	LastName    string         `json:"last_name,omitempty"`
	FullName    string         `json:"full_name,omitempty"`
	Phone       string         `json:"phone,omitempty"`
	Traits      map[string]any `json:"traits,omitempty"`
	UpdatedAt   *time.Time     `json:"updated_at,omitempty"`
}

type EventInput struct {
	SourceID    string `json:"source_id,omitempty"`
	Email       string `json:"email"`
	UserID      string `json:"user_id,omitempty"`
	AnonymousID string `json:"anonymous_id,omitempty"`
	EventName   string `json:"event_name"`
	// EventID is the upstream provider's own event id, when the payload carries
	// one. Used as the idempotency key on ingest: a replayed webhook from
	// Segment or Amplitude is the same class of duplicate as a retried /track.
	EventID    string         `json:"event_id,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
	OccurredAt *time.Time     `json:"occurred_at,omitempty"`
}

type SyncRequest struct {
	RunMode  string         `json:"run_mode,omitempty"`
	Profiles []ProfileInput `json:"profiles,omitempty"`
	Events   []EventInput   `json:"events,omitempty"`
	Cursor   string         `json:"cursor,omitempty"`
}

type SyncSummary struct {
	IntegrationID    string `json:"integration_id"`
	RunID            string `json:"run_id,omitempty"`
	Status           string `json:"status"`
	ProfilesSeen     int    `json:"profiles_seen"`
	ProfilesUpserted int    `json:"profiles_upserted"`
	EventsSeen       int    `json:"events_seen"`
	EventsTracked    int    `json:"events_tracked"`
	RowsFailed       int    `json:"rows_failed"`
	Cursor           string `json:"cursor,omitempty"`
	ErrorMessage     string `json:"error_message,omitempty"`
}

type SyncRun struct {
	ID               string         `json:"id"`
	TenantID         string         `json:"tenant_id,omitempty"`
	IntegrationID    string         `json:"integration_id,omitempty"`
	RunMode          string         `json:"run_mode"`
	Status           string         `json:"status"`
	CursorFrom       string         `json:"cursor_from,omitempty"`
	CursorTo         string         `json:"cursor_to,omitempty"`
	ProfilesSeen     int            `json:"profiles_seen"`
	ProfilesUpserted int            `json:"profiles_upserted"`
	EventsSeen       int            `json:"events_seen"`
	EventsTracked    int            `json:"events_tracked"`
	RowsFailed       int            `json:"rows_failed"`
	ErrorMessage     string         `json:"error_message,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	StartedAt        time.Time      `json:"started_at"`
	CompletedAt      *time.Time     `json:"completed_at,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
}
