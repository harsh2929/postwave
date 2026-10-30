// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import "time"

const (
	ProviderYotpo        = "yotpo"
	ProviderJudgeMe      = "judge-me"
	ProviderOkendo       = "okendo"
	ProviderLoox         = "loox"
	ProviderStamped      = "stamped"
	ProviderTrustpilot   = "trustpilot"
	ProviderReviewsIO    = "reviews-io"
	ProviderBazaarvoice  = "bazaarvoice"
	ProviderPowerReviews = "powerreviews"
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
	Provider                    string   `json:"provider"`
	Status                      string   `json:"status"`
	RecordedAt                  string   `json:"recorded_at,omitempty"`
	AcknowledgedAt              string   `json:"acknowledged_at,omitempty"`
	AcknowledgedBy              string   `json:"acknowledged_by,omitempty"`
	CompletedActions            []string `json:"completed_actions,omitempty"`
	OperatorNotes               string   `json:"operator_notes,omitempty"`
	PostwaveStatus              string   `json:"postwave_status"`
	ProviderCleanupPosture      string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup      bool     `json:"managed_provider_cleanup"`
	ProviderScopeType           string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID             string   `json:"provider_scope_id,omitempty"`
	CredentialRefPresent        bool     `json:"credential_ref_present,omitempty"`
	WebhookSecretRefPresent     bool     `json:"webhook_secret_ref_present,omitempty"`
	TokenizedIngestTokenPresent bool     `json:"tokenized_ingest_token_present,omitempty"`
	WebhookCleanupStatus        string   `json:"webhook_cleanup_status"`
	CredentialCleanupStatus     string   `json:"credential_cleanup_status"`
	PostwaveEffects             []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions      []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence     []string `json:"provider_cleanup_evidence,omitempty"`
}

type ProviderCleanupAcknowledgementInput struct {
	CompletedActions []string `json:"completed_actions,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	AcknowledgedBy   string   `json:"acknowledged_by,omitempty"`
}

type ReviewInput struct {
	SourceID      string         `json:"source_id,omitempty"`
	ProductID     string         `json:"product_id,omitempty"`
	VariantID     string         `json:"variant_id,omitempty"`
	OrderID       string         `json:"order_id,omitempty"`
	CustomerID    string         `json:"customer_id,omitempty"`
	ReviewerName  string         `json:"reviewer_name,omitempty"`
	ReviewerEmail string         `json:"reviewer_email,omitempty"`
	Rating        int            `json:"rating"`
	Title         string         `json:"title,omitempty"`
	Body          string         `json:"body,omitempty"`
	ReviewType    string         `json:"review_type,omitempty"`
	Status        string         `json:"status,omitempty"`
	VerifiedBuyer bool           `json:"verified_buyer,omitempty"`
	Incentivized  bool           `json:"incentivized,omitempty"`
	Featured      bool           `json:"featured,omitempty"`
	EventName     string         `json:"event_name,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	RawPayload    map[string]any `json:"raw_payload,omitempty"`
	SubmittedAt   *time.Time     `json:"submitted_at,omitempty"`
}

type SyncRequest struct {
	RunMode string        `json:"run_mode,omitempty"`
	Reviews []ReviewInput `json:"reviews,omitempty"`
	Cursor  string        `json:"cursor,omitempty"`
}

type SyncSummary struct {
	IntegrationID    string `json:"integration_id"`
	RunID            string `json:"run_id,omitempty"`
	Status           string `json:"status"`
	ReviewsSeen      int    `json:"reviews_seen"`
	ReviewsImported  int    `json:"reviews_imported"`
	ProfilesUpserted int    `json:"profiles_upserted"`
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
	ReviewsSeen      int            `json:"reviews_seen"`
	ReviewsImported  int            `json:"reviews_imported"`
	ProfilesUpserted int            `json:"profiles_upserted"`
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
