// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import "time"

const (
	ProviderKlaviyo         = "klaviyo"
	ProviderMailchimp       = "mailchimp"
	ProviderActiveCampaign  = "activecampaign"
	ProviderCustomerIO      = "customerio"
	ProviderBrevo           = "brevo"
	ProviderConvertKit      = "convertkit"
	ProviderSubstack        = "substack"
	ProviderBeehiiv         = "beehiiv"
	ProviderMailerLite      = "mailerlite"
	ProviderSendy           = "sendy"
	ProviderConstantContact = "constant-contact"
	ProviderAWeber          = "aweber"
	ProviderDrip            = "drip"
	ProviderCampaignMonitor = "campaign-monitor"
	ProviderOmnisend        = "omnisend"
	ProviderLoops           = "loops"
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

type DisconnectCleanupEvidence struct {
	Provider                string   `json:"provider"`
	Status                  string   `json:"status"`
	RecordedAt              string   `json:"recorded_at,omitempty"`
	AcknowledgedAt          string   `json:"acknowledged_at,omitempty"`
	AcknowledgedBy          string   `json:"acknowledged_by,omitempty"`
	CompletedActions        []string `json:"completed_actions,omitempty"`
	OperatorNotes           string   `json:"operator_notes,omitempty"`
	PostwaveStatus          string   `json:"postwave_status"`
	ProviderCleanupPosture  string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup  bool     `json:"managed_provider_cleanup"`
	CleanupKind             string   `json:"cleanup_kind,omitempty"`
	ProviderScopeType       string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID         string   `json:"provider_scope_id,omitempty"`
	ProviderWebhookID       string   `json:"provider_webhook_id,omitempty"`
	Endpoint                string   `json:"endpoint,omitempty"`
	Deleted                 bool     `json:"deleted,omitempty"`
	NotFound                bool     `json:"not_found,omitempty"`
	Skipped                 bool     `json:"skipped,omitempty"`
	SkipReason              string   `json:"skip_reason,omitempty"`
	CleanupReason           string   `json:"cleanup_reason,omitempty"`
	Topics                  []string `json:"topics,omitempty"`
	CredentialRefPresent    bool     `json:"credential_ref_present,omitempty"`
	WebhookSecretRefPresent bool     `json:"webhook_secret_ref_present,omitempty"`
	CredentialCleanupStatus string   `json:"credential_cleanup_status"`
	WebhookCleanupStatus    string   `json:"webhook_cleanup_status"`
	PostwaveEffects         []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions  []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence []string `json:"provider_cleanup_evidence,omitempty"`
}

type ProviderCleanupAcknowledgementInput struct {
	CompletedActions []string `json:"completed_actions,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	AcknowledgedBy   string   `json:"acknowledged_by,omitempty"`
}

type SyncRequest struct {
	RunMode  string         `json:"run_mode,omitempty"`
	Cursor   string         `json:"cursor,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type SyncSummary struct {
	IntegrationID string         `json:"integration_id"`
	RunID         string         `json:"run_id,omitempty"`
	Status        string         `json:"status"`
	ProfilesSeen  int            `json:"profiles_seen"`
	EventsSeen    int            `json:"events_seen"`
	ListsSeen     int            `json:"lists_seen"`
	RowsFailed    int            `json:"rows_failed"`
	Cursor        string         `json:"cursor,omitempty"`
	ErrorMessage  string         `json:"error_message,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

type SyncRun struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenant_id,omitempty"`
	IntegrationID string         `json:"integration_id,omitempty"`
	RunMode       string         `json:"run_mode"`
	Status        string         `json:"status"`
	CursorFrom    string         `json:"cursor_from,omitempty"`
	CursorTo      string         `json:"cursor_to,omitempty"`
	ProfilesSeen  int            `json:"profiles_seen"`
	EventsSeen    int            `json:"events_seen"`
	ListsSeen     int            `json:"lists_seen"`
	RowsFailed    int            `json:"rows_failed"`
	ErrorMessage  string         `json:"error_message,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	StartedAt     time.Time      `json:"started_at"`
	CompletedAt   *time.Time     `json:"completed_at,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
}

type WebhookClaim string

const (
	WebhookClaimed    WebhookClaim = "claimed"
	WebhookProcessed  WebhookClaim = "processed"
	WebhookInProgress WebhookClaim = "in_progress"
)
