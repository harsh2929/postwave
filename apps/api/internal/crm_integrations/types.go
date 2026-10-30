// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import "time"

const (
	ProviderHubSpot     = "hubspot"
	ProviderSalesforce  = "salesforce"
	ProviderPipedrive   = "pipedrive"
	ProviderZohoCRM     = "zoho-crm"
	ProviderDynamics365 = "microsoft-dynamics-365"
	ProviderKeap        = "keap"
	ProviderClose       = "close"
	ProviderCopper      = "copper"
	ProviderFreshsales  = "freshsales"
	ProviderHighLevel   = "highlevel"
	ProviderPostscript  = "postscript"
	ProviderAttentive   = "attentive"
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
	WebhookMode      string          `json:"webhook_mode,omitempty"`
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
	// TrustedRuntimeMetadata is set only by provider callbacks after Moosewave
	// verifies the OAuth exchange. Public JSON cannot opt a credential-ref row
	// into webhook routing by forging provider-owned settings.
	TrustedRuntimeMetadata bool `json:"-"`
}

type DisconnectCleanupEvidence struct {
	Provider                  string   `json:"provider"`
	Status                    string   `json:"status"`
	RecordedAt                string   `json:"recorded_at,omitempty"`
	PostwaveStatus            string   `json:"postwave_status"`
	ProviderCleanupPosture    string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup    bool     `json:"managed_provider_cleanup"`
	ProviderScopeType         string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID           string   `json:"provider_scope_id,omitempty"`
	Endpoint                  string   `json:"endpoint,omitempty"`
	ProviderWebhookIDs        []string `json:"provider_webhook_ids,omitempty"`
	DeletedProviderWebhookIDs []string `json:"deleted_provider_webhook_ids,omitempty"`
	OAuthRevocationStatus     string   `json:"oauth_revocation_status,omitempty"`
	OAuthTokenType            string   `json:"oauth_token_type,omitempty"`
	OAuthRevoked              bool     `json:"oauth_revoked,omitempty"`
	OAuthRevocationSkipped    bool     `json:"oauth_revocation_skipped,omitempty"`
	OAuthRevocationSkipReason string   `json:"oauth_revocation_skip_reason,omitempty"`
	CredentialRefPresent      bool     `json:"credential_ref_present,omitempty"`
	WebhookCleanupStatus      string   `json:"webhook_cleanup_status"`
	CredentialCleanupStatus   string   `json:"credential_cleanup_status"`
	PostwaveEffects           []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions    []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence   []string `json:"provider_cleanup_evidence,omitempty"`
}

type DisconnectResponse struct {
	OK                        bool                              `json:"ok"`
	ProviderCleanup           *DisconnectCleanupEvidence        `json:"provider_cleanup,omitempty"`
	HubSpotOAuthRevocation    *HubSpotOAuthRevocationSummary    `json:"hubspot_oauth_revocation,omitempty"`
	PipedriveOAuthRevocation  *PipedriveOAuthRevocationSummary  `json:"pipedrive_oauth_revocation,omitempty"`
	SalesforceOAuthRevocation *SalesforceOAuthRevocationSummary `json:"salesforce_oauth_revocation,omitempty"`
}

type ContactInput struct {
	SourceID       string         `json:"source_id"`
	Email          string         `json:"email"`
	FirstName      string         `json:"first_name,omitempty"`
	LastName       string         `json:"last_name,omitempty"`
	FullName       string         `json:"full_name,omitempty"`
	Phone          string         `json:"phone,omitempty"`
	Company        string         `json:"company,omitempty"`
	LifecycleStage string         `json:"lifecycle_stage,omitempty"`
	ListIDs        []string       `json:"list_ids,omitempty"`
	Tags           []string       `json:"tags,omitempty"`
	Properties     map[string]any `json:"properties,omitempty"`
	UpdatedAt      *time.Time     `json:"updated_at,omitempty"`
}

type EventInput struct {
	SourceID   string         `json:"source_id,omitempty"`
	Email      string         `json:"email"`
	Phone      string         `json:"phone,omitempty"`
	EventName  string         `json:"event_name"`
	Properties map[string]any `json:"properties,omitempty"`
	OccurredAt *time.Time     `json:"occurred_at,omitempty"`
}

type SyncRequest struct {
	RunMode                     string                        `json:"run_mode,omitempty"`
	Contacts                    []ContactInput                `json:"contacts,omitempty"`
	Events                      []EventInput                  `json:"events,omitempty"`
	Cursor                      string                        `json:"cursor,omitempty"`
	nativeListMembershipScans   []CRMNativeListMembershipScan `json:"-"`
	nativeListMembershipManaged bool                          `json:"-"`
}

type SyncSummary struct {
	IntegrationID    string `json:"integration_id"`
	RunID            string `json:"run_id,omitempty"`
	Status           string `json:"status"`
	ContactsSeen     int    `json:"contacts_seen"`
	ContactsUpserted int    `json:"contacts_upserted"`
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
	ContactsSeen     int            `json:"contacts_seen"`
	ContactsUpserted int            `json:"contacts_upserted"`
	EventsSeen       int            `json:"events_seen"`
	EventsTracked    int            `json:"events_tracked"`
	RowsFailed       int            `json:"rows_failed"`
	ErrorMessage     string         `json:"error_message,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	StartedAt        time.Time      `json:"started_at"`
	CompletedAt      *time.Time     `json:"completed_at,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
}

type CRMNativeListMembershipScan struct {
	IntegrationID       string
	Provider            string
	ProviderSegmentType string
	ProviderListID      string
	NativeListID        string
	Start               bool
	Complete            bool
}

type CRMNativeListMembershipSeen struct {
	IntegrationID       string
	Provider            string
	ProviderSegmentType string
	ProviderListID      string
	NativeListID        string
	ProviderMemberID    string
	SubscriberID        string
	Email               string
	Metadata            map[string]any
}

type WebhookClaim string

const (
	WebhookClaimed    WebhookClaim = "claimed"
	WebhookProcessed  WebhookClaim = "processed"
	WebhookInProgress WebhookClaim = "in_progress"
)
