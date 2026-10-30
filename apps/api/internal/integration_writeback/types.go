// SPDX-License-Identifier: AGPL-3.0-only
//
// Package integration_writeback is the bidirectional / reverse-ETL layer: it
// pushes Moosewave audience membership + profile fields BACK into the source
// platforms (Shopify, HubSpot, …) — the two-way capability that separates a
// read-only connector from a Klaviyo-class integration. A tenant registers a
// write-back Target (provider + credential ref + source list/segment + tag/field
// mapping); a Runner resolves the audience and applies each member's tags/fields
// to the matching platform record via a per-provider Adapter, auditing each Run.
package integration_writeback

import (
	"context"
	"time"
)

const (
	ProviderShopify     = "shopify"
	ProviderHubSpot     = "hubspot"
	ProviderSalesforce  = "salesforce"
	ProviderPipedrive   = "pipedrive"
	ProviderWooCommerce = "woocommerce"
	ProviderZoho        = "zoho-crm"
	ProviderKlaviyo     = "klaviyo"
)

// Target is a registered write-back destination (a source platform we push to).
type Target struct {
	ID             string         `json:"id"`
	TenantID       string         `json:"tenant_id,omitempty"`
	Provider       string         `json:"provider"`
	Name           string         `json:"name"`
	Status         string         `json:"status"`
	CredentialsRef string         `json:"credentials_ref,omitempty"`
	Settings       map[string]any `json:"settings,omitempty"`
	// SyncIntervalMinutes > 0 makes the scheduler run this target continuously
	// (0 = manual-only).
	SyncIntervalMinutes int        `json:"sync_interval_minutes"`
	LastRunAt           *time.Time `json:"last_run_at,omitempty"`
	ErrorMessage        string     `json:"error_message,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

// TargetInput is the create/update payload.
type TargetInput struct {
	Provider            string         `json:"provider"`
	Name                string         `json:"name"`
	Status              string         `json:"status"`
	CredentialsRef      string         `json:"credentials_ref"`
	Settings            map[string]any `json:"settings"`
	SyncIntervalMinutes int            `json:"sync_interval_minutes"`
}

// ProfileWrite is one subscriber's data to push to a platform record (keyed by
// email). Tags use APPEND semantics where the platform supports it; Fields are
// platform-field -> value (replace semantics per field).
type ProfileWrite struct {
	Email  string            `json:"email"`
	Tags   []string          `json:"tags,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
}

// WriteResult is one profile's outcome from an adapter.
type WriteResult struct {
	// Matched is true when a platform record was found for the email. A miss is
	// not an error — the person may not exist on that platform yet.
	Matched       bool
	TagsWritten   int
	FieldsWritten int
}

// Adapter applies one profile's tags/fields to a platform record found by email.
// Implementations are pure HTTP clients; credential + audience resolution happen
// in the Runner so adapters stay stateless and unit-testable against mock servers.
type Adapter interface {
	Provider() string
	WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error)
}

// BatchResult is the aggregate outcome of a batched write across many profiles.
type BatchResult struct {
	Matched       int // platform records found + written
	TagsWritten   int
	FieldsWritten int
	RowsFailed    int // profiles whose write errored (partial-batch failures)
}

// Batcher is an OPTIONAL Adapter capability: write a whole audience in a handful
// of bulk API calls instead of one request per member. The runner prefers it
// whenever an adapter implements it and the audience has more than one member, so
// a 1k-member HubSpot sync becomes ~tens of calls instead of ~1k. Implementations
// chunk internally and MUST preserve WriteProfile's no-create semantics — only
// records that already exist on the platform are updated, never created.
type Batcher interface {
	BatchWrite(ctx context.Context, creds map[string]string, settings map[string]any, profiles []ProfileWrite) (BatchResult, error)
}

// RunSummary is the aggregate outcome of a write-back run.
type RunSummary struct {
	RunID         string `json:"run_id,omitempty"`
	Status        string `json:"status"`
	MembersSeen   int    `json:"members_seen"`
	Matched       int    `json:"matched"`
	TagsWritten   int    `json:"tags_written"`
	FieldsWritten int    `json:"fields_written"`
	RowsFailed    int    `json:"rows_failed"`
	ErrorMessage  string `json:"error_message,omitempty"`
}

// Run is an audited write-back execution.
type Run struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenant_id,omitempty"`
	TargetID      string         `json:"target_id,omitempty"`
	RunMode       string         `json:"run_mode"`
	Status        string         `json:"status"`
	MembersSeen   int            `json:"members_seen"`
	Matched       int            `json:"matched"`
	TagsWritten   int            `json:"tags_written"`
	FieldsWritten int            `json:"fields_written"`
	RowsFailed    int            `json:"rows_failed"`
	ErrorMessage  string         `json:"error_message,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	StartedAt     time.Time      `json:"started_at"`
	CompletedAt   *time.Time     `json:"completed_at,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
}

// AudienceMember is a resolved subscriber from the source list/segment.
type AudienceMember struct {
	Email  string
	Traits map[string]any
}
