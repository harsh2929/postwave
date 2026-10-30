// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import "time"

const (
	ProviderZendesk                = "zendesk"
	ProviderIntercom               = "intercom"
	ProviderGorgias                = "gorgias"
	ProviderFreshdesk              = "freshdesk"
	ProviderHelpScout              = "help-scout"
	ProviderFront                  = "front"
	ProviderZohoDesk               = "zoho-desk"
	ProviderKustomer               = "kustomer"
	ProviderFreshchat              = "freshchat"
	ProviderLiveChat               = "livechat"
	ProviderCrisp                  = "crisp"
	ProviderTidio                  = "tidio"
	ProviderOlark                  = "olark"
	ProviderDrift                  = "drift"
	ProviderAda                    = "ada"
	ProviderGladly                 = "gladly"
	ProviderReamaze                = "reamaze"
	ProviderGroove                 = "groove"
	ProviderKayako                 = "kayako"
	ProviderHelpCrunch             = "helpcrunch"
	ProviderHubSpotServiceHub      = "hubspot-service-hub"
	ProviderSalesforceServiceCloud = "salesforce-service-cloud"
	ProviderJiraServiceManagement  = "jira-service-management"
	ProviderLinear                 = "linear"
	ProviderAsanaSupport           = "asana-support"
	ProviderClickUpSupport         = "clickup-support"
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

// IntegrationProjection is the minimized exact-admin read model. It is
// intentionally incapable of carrying credential references, provider
// settings, cursors, or raw provider errors.
type IntegrationProjection struct {
	ID                   string    `json:"id"`
	TenantID             string    `json:"tenant_id"`
	Provider             string    `json:"provider"`
	Name                 string    `json:"name"`
	Status               string    `json:"status"`
	CredentialConfigured bool      `json:"credential_configured"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

type IntegrationInput struct {
	Provider       string         `json:"provider"`
	Name           string         `json:"name"`
	Status         string         `json:"status"`
	Scopes         []string       `json:"scopes"`
	CredentialsRef string         `json:"credentials_ref"`
	Settings       map[string]any `json:"settings"`
}

type DisconnectCleanupEvidence struct {
	Provider                string   `json:"provider"`
	Status                  string   `json:"status"`
	RecordedAt              string   `json:"recorded_at,omitempty"`
	PostwaveStatus          string   `json:"postwave_status"`
	ProviderCleanupPosture  string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup  bool     `json:"managed_provider_cleanup"`
	ProviderScopeType       string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID         string   `json:"provider_scope_id,omitempty"`
	ProviderWebhookID       string   `json:"provider_webhook_id,omitempty"`
	CredentialRefPresent    bool     `json:"credential_ref_present,omitempty"`
	WebhookSecretRefPresent bool     `json:"webhook_secret_ref_present,omitempty"`
	WebhookCleanupStatus    string   `json:"webhook_cleanup_status"`
	CredentialCleanupStatus string   `json:"credential_cleanup_status"`
	PostwaveEffects         []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions  []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence []string `json:"provider_cleanup_evidence,omitempty"`
}

type TicketInput struct {
	SourceID       string         `json:"source_id,omitempty"`
	ConversationID string         `json:"conversation_id,omitempty"`
	Email          string         `json:"email"`
	RequesterName  string         `json:"requester_name,omitempty"`
	Subject        string         `json:"subject,omitempty"`
	Status         string         `json:"status,omitempty"`
	Priority       string         `json:"priority,omitempty"`
	Assignee       string         `json:"assignee,omitempty"`
	Tags           []string       `json:"tags,omitempty"`
	Properties     map[string]any `json:"properties,omitempty"`
	UpdatedAt      *time.Time     `json:"updated_at,omitempty"`
}

type MessageInput struct {
	SourceID       string         `json:"source_id,omitempty"`
	ConversationID string         `json:"conversation_id,omitempty"`
	Email          string         `json:"email"`
	RequesterName  string         `json:"requester_name,omitempty"`
	Subject        string         `json:"subject,omitempty"`
	Direction      string         `json:"direction,omitempty"`
	SenderType     string         `json:"sender_type,omitempty"`
	Sender         string         `json:"sender,omitempty"`
	BodyText       string         `json:"body_text,omitempty"`
	BodyHTML       string         `json:"body_html,omitempty"`
	Properties     map[string]any `json:"properties,omitempty"`
	OccurredAt     *time.Time     `json:"occurred_at,omitempty"`
}

type SupportEventInput struct {
	SourceID       string         `json:"source_id,omitempty"`
	Email          string         `json:"email"`
	EventName      string         `json:"event_name"`
	ConversationID string         `json:"conversation_id,omitempty"`
	TicketID       string         `json:"ticket_id,omitempty"`
	Status         string         `json:"status,omitempty"`
	Properties     map[string]any `json:"properties,omitempty"`
	OccurredAt     *time.Time     `json:"occurred_at,omitempty"`
}

type SyncRequest struct {
	RunMode       string              `json:"run_mode,omitempty"`
	Tickets       []TicketInput       `json:"tickets,omitempty"`
	Messages      []MessageInput      `json:"messages,omitempty"`
	Events        []SupportEventInput `json:"events,omitempty"`
	Cursor        string              `json:"cursor,omitempty"`
	StopAfterPage bool                `json:"stop_after_page,omitempty"`
}

type SyncSummary struct {
	IntegrationID    string `json:"integration_id"`
	RunID            string `json:"run_id,omitempty"`
	Status           string `json:"status"`
	TicketsSeen      int    `json:"tickets_seen"`
	TicketsUpserted  int    `json:"tickets_upserted"`
	MessagesSeen     int    `json:"messages_seen"`
	MessagesUpserted int    `json:"messages_upserted"`
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
	TicketsSeen      int            `json:"tickets_seen"`
	TicketsUpserted  int            `json:"tickets_upserted"`
	MessagesSeen     int            `json:"messages_seen"`
	MessagesUpserted int            `json:"messages_upserted"`
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

type WebhookClaim string

const (
	WebhookClaimed    WebhookClaim = "claimed"
	WebhookProcessed  WebhookClaim = "processed"
	WebhookInProgress WebhookClaim = "in_progress"
)
