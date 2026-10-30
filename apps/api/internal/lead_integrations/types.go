// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import "time"

const (
	ProviderTypeform        = "typeform"
	ProviderJotform         = "jotform"
	ProviderGoogleForms     = "google-forms"
	ProviderMicrosoftForms  = "microsoft-forms"
	ProviderSurveyMonkey    = "surveymonkey"
	ProviderFacebookLeadAds = "facebook-lead-ads"
	ProviderLinkedInLeadGen = "linkedin-lead-gen"
	ProviderGoogleLeadForms = "google-lead-form-extensions"
	ProviderTikTokLeadGen   = "tiktok-lead-generation"
	ProviderSnapLeadAds     = "snap-lead-ads"
	ProviderRedditLeadGen   = "reddit-lead-gen"
	ProviderPinterestLeads  = "pinterest-lead-ads"
	ProviderUnbounce        = "unbounce"
	ProviderLeadpages       = "leadpages"
	ProviderInstapage       = "instapage"
	ProviderCarrd           = "carrd"
	ProviderPaperform       = "paperform"
	ProviderFormstack       = "formstack"
	ProviderFillout         = "fillout"
	ProviderOptinMonster    = "optinmonster"
	ProviderPrivy           = "privy"
	ProviderConvertFlow     = "convertflow"
	ProviderSleeknote       = "sleeknote"
	ProviderWisepops        = "wisepops"
	ProviderPoptin          = "poptin"
	ProviderHelloBar        = "hello-bar"
	ProviderUnstack         = "unstack"
	ProviderLandingi        = "landingi"
	ProviderKickoffLabs     = "kickofflabs"
	ProviderShortStack      = "shortstack"
	ProviderFormsite        = "formsite"
	ProviderCognitoForms    = "cognito-forms"
	ProviderNinjaForms      = "ninja-forms"
	ProviderFormidableForms = "formidable-forms"
	ProviderInteract        = "interact"
	ProviderOutgrow         = "outgrow"
	ProviderRiddle          = "riddle"
	ProviderQualtricsForms  = "qualtrics-forms"
	ProviderFeathery        = "feathery"
	ProviderFormaloo        = "formaloo"
	Provider123FormBuilder  = "123formbuilder"
	ProviderGravityForms    = "gravity-forms"
	ProviderWPForms         = "wpforms"
	ProviderWordPress       = "wordpress"
	ProviderWebflow         = "webflow"
	ProviderWix             = "wix"
	ProviderSquarespace     = "squarespace"
	ProviderTally           = "tally"
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
	Provider                  string   `json:"provider"`
	Status                    string   `json:"status"`
	RecordedAt                string   `json:"recorded_at,omitempty"`
	PostwaveStatus            string   `json:"postwave_status"`
	ProviderCleanupPosture    string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup    bool     `json:"managed_provider_cleanup"`
	CleanupKind               string   `json:"cleanup_kind,omitempty"`
	ProviderScopeType         string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID           string   `json:"provider_scope_id,omitempty"`
	ProviderWebhookID         string   `json:"provider_webhook_id,omitempty"`
	PreviousProviderWebhookID string   `json:"previous_provider_webhook_id,omitempty"`
	Endpoint                  string   `json:"endpoint,omitempty"`
	Deleted                   bool     `json:"deleted,omitempty"`
	NotFound                  bool     `json:"not_found,omitempty"`
	Skipped                   bool     `json:"skipped,omitempty"`
	SkipReason                string   `json:"skip_reason,omitempty"`
	CleanupReason             string   `json:"cleanup_reason,omitempty"`
	Fields                    []string `json:"fields,omitempty"`
	CredentialRefPresent      bool     `json:"credential_ref_present,omitempty"`
	WebhookSecretRefPresent   bool     `json:"webhook_secret_ref_present,omitempty"`
	WebhookCleanupStatus      string   `json:"webhook_cleanup_status"`
	CredentialCleanupStatus   string   `json:"credential_cleanup_status"`
	PostwaveEffects           []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions    []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence   []string `json:"provider_cleanup_evidence,omitempty"`
}

type SubmissionInput struct {
	SourceID    string         `json:"source_id,omitempty"`
	Email       string         `json:"email"`
	FirstName   string         `json:"first_name,omitempty"`
	LastName    string         `json:"last_name,omitempty"`
	FullName    string         `json:"full_name,omitempty"`
	Phone       string         `json:"phone,omitempty"`
	Company     string         `json:"company,omitempty"`
	FormID      string         `json:"form_id,omitempty"`
	FormName    string         `json:"form_name,omitempty"`
	EventName   string         `json:"event_name,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
	Fields      map[string]any `json:"fields,omitempty"`
	SubmittedAt *time.Time     `json:"submitted_at,omitempty"`
}

type SyncRequest struct {
	RunMode     string            `json:"run_mode,omitempty"`
	Submissions []SubmissionInput `json:"submissions,omitempty"`
	Cursor      string            `json:"cursor,omitempty"`
}

type SyncSummary struct {
	IntegrationID       string `json:"integration_id"`
	RunID               string `json:"run_id,omitempty"`
	Status              string `json:"status"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	RowsFailed          int    `json:"rows_failed"`
	Cursor              string `json:"cursor,omitempty"`
	ErrorMessage        string `json:"error_message,omitempty"`
}

type SyncRun struct {
	ID                  string         `json:"id"`
	TenantID            string         `json:"tenant_id,omitempty"`
	IntegrationID       string         `json:"integration_id,omitempty"`
	RunMode             string         `json:"run_mode"`
	Status              string         `json:"status"`
	CursorFrom          string         `json:"cursor_from,omitempty"`
	CursorTo            string         `json:"cursor_to,omitempty"`
	SubmissionsSeen     int            `json:"submissions_seen"`
	SubscribersUpserted int            `json:"subscribers_upserted"`
	EventsTracked       int            `json:"events_tracked"`
	RowsFailed          int            `json:"rows_failed"`
	ErrorMessage        string         `json:"error_message,omitempty"`
	Metadata            map[string]any `json:"metadata,omitempty"`
	StartedAt           time.Time      `json:"started_at"`
	CompletedAt         *time.Time     `json:"completed_at,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
}

type WebhookClaim string

const (
	WebhookClaimed    WebhookClaim = "claimed"
	WebhookProcessed  WebhookClaim = "processed"
	WebhookInProgress WebhookClaim = "in_progress"
)
