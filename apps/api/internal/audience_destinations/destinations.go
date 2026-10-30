// SPDX-License-Identifier: AGPL-3.0-only
//
// Package audience_destinations exposes per-tenant CRUD over the
// audience_destinations + audience_sync_jobs tables (migration 0256).
//
// Scope: GAP-LS-110 (Meta Custom Audiences), GAP-LS-111 (Google Ads
// customer match), GAP-LS-112 (TikTok / LinkedIn / Snap audience APIs).
//
// The schema + sync-job ledger are live and provider-shaped adapters exist
// for the ad platforms. Public create/update APIs still reject raw credential
// material; until credential-reference resolution and provider verification
// are wired end-to-end, these destinations are readiness-gated adapter
// foundations rather than fully verified live Custom Audience delivery.
package audience_destinations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

// Provider is the set of supported ad-network destinations. Mirrors the
// CHECK constraint on audience_destinations.provider.
type Provider string

const (
	ProviderMeta      Provider = "meta"
	ProviderGoogleAds Provider = "google_ads"
	ProviderTikTok    Provider = "tiktok"
	ProviderLinkedIn  Provider = "linkedin"
	ProviderSnap      Provider = "snap"
)

// AllProviders is the canonical catalog (for validation + UI).
var AllProviders = []Provider{
	ProviderMeta, ProviderGoogleAds, ProviderTikTok,
	ProviderLinkedIn, ProviderSnap,
}

// IsValidProvider reports whether p is one of AllProviders.
func IsValidProvider(p string) bool {
	for _, x := range AllProviders {
		if string(x) == p {
			return true
		}
	}
	return false
}

// Status mirrors audience_destinations.status CHECK constraint values.
type Status string

const (
	StatusDraft        Status = "draft"
	StatusActive       Status = "active"
	StatusPaused       Status = "paused"
	StatusSyncing      Status = "syncing"
	StatusError        Status = "error"
	StatusDisconnected Status = "disconnected"
)

// Destination is one row from audience_destinations.
type Destination struct {
	ID                 string          `json:"id"`
	TenantID           string          `json:"tenant_id"`
	Provider           Provider        `json:"provider"`
	ListID             *string         `json:"list_id,omitempty"`
	SegmentID          *string         `json:"segment_id,omitempty"`
	ExternalAudienceID string          `json:"external_audience_id,omitempty"`
	Status             Status          `json:"status"`
	LastSyncedAt       *time.Time      `json:"last_synced_at,omitempty"`
	Config             json.RawMessage `json:"config"`
	CreatedAt          time.Time       `json:"created_at"`
	UpdatedAt          time.Time       `json:"updated_at"`
	rawConfig          map[string]any
}

type DisconnectCleanupEvidence struct {
	Provider                        string   `json:"provider"`
	Status                          string   `json:"status"`
	RecordedAt                      string   `json:"recorded_at,omitempty"`
	PostwaveStatus                  string   `json:"postwave_status"`
	ProviderCleanupPosture          string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup          bool     `json:"managed_provider_cleanup"`
	ProviderScopeType               string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID                 string   `json:"provider_scope_id,omitempty"`
	ExternalAudienceID              string   `json:"external_audience_id,omitempty"`
	CredentialRefPresent            bool     `json:"credential_ref_present,omitempty"`
	AudienceCleanupStatus           string   `json:"audience_cleanup_status"`
	AudienceMembershipCleanupStatus string   `json:"audience_membership_cleanup_status"`
	CredentialCleanupStatus         string   `json:"credential_cleanup_status"`
	PostwaveEffects                 []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions          []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence         []string `json:"provider_cleanup_evidence,omitempty"`
}

type DisconnectResponse struct {
	OK              bool                       `json:"ok"`
	ProviderCleanup *DisconnectCleanupEvidence `json:"provider_cleanup,omitempty"`
}

// AdapterConfig returns the unmasked provider config for server-side delivery
// when the row was loaded from the repo. It falls back to the public Config so
// tests and in-memory destinations remain easy to construct.
func (d *Destination) AdapterConfig() map[string]any {
	if d == nil {
		return nil
	}
	if len(d.rawConfig) > 0 {
		return d.rawConfig
	}
	return parseDestinationConfig(string(d.Config))
}

// SyncJob is one row from audience_sync_jobs.
type SyncJob struct {
	ID                    string     `json:"id"`
	TenantID              string     `json:"tenant_id"`
	DestinationID         string     `json:"destination_id"`
	StartedAt             time.Time  `json:"started_at"`
	FinishedAt            *time.Time `json:"finished_at,omitempty"`
	Status                string     `json:"status"`
	Error                 string     `json:"error,omitempty"`
	MembersSynced         int        `json:"members_synced"`
	ExternalJobID         string     `json:"external_job_id,omitempty"`
	ExternalAudienceID    string     `json:"external_audience_id,omitempty"`
	ProviderMessage       string     `json:"provider_message,omitempty"`
	ProviderStatus        string     `json:"provider_status,omitempty"`
	ProviderCheckedAt     *time.Time `json:"provider_checked_at,omitempty"`
	ProviderNextCheckAt   *time.Time `json:"provider_next_check_at,omitempty"`
	ProviderPollAttempts  int        `json:"provider_poll_attempts,omitempty"`
	TriggerKind           string     `json:"trigger_kind"`
	SourceMembersObserved int        `json:"source_members_observed"`
	CapExceeded           bool       `json:"cap_exceeded"`
	CreatedAt             time.Time  `json:"created_at"`
}

// CreateInput is the body of POST /api/v1/audience-destinations.
type CreateInput struct {
	Provider           string          `json:"provider"`
	ListID             *string         `json:"list_id,omitempty"`
	SegmentID          *string         `json:"segment_id,omitempty"`
	ExternalAudienceID string          `json:"external_audience_id,omitempty"`
	Config             json.RawMessage `json:"config,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/audience-destinations/{id}.
type UpdateInput struct {
	Status             *string         `json:"status,omitempty"`
	ExternalAudienceID *string         `json:"external_audience_id,omitempty"`
	Config             json.RawMessage `json:"config,omitempty"`
	IfMatchToken       string          `json:"-"`
}

// Sentinel errors.
var (
	ErrNotFound           = errors.New("audience_destinations: not found")
	ErrInvalidInput       = errors.New("audience_destinations: invalid input")
	ErrPreconditionFailed = errors.New("audience_destinations: precondition failed")
)

// Repo wraps the pgx pool for audience_destinations + audience_sync_jobs.
type Repo struct {
	Pool *db.Pool
}

// List returns the destinations for a tenant, newest-first. provider
// is optional: empty string returns all providers.
func (r *Repo) List(ctx context.Context, tenantID string, provider string) ([]Destination, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, provider,
       list_id::text, segment_id::text,
       COALESCE(external_audience_id,''), status,
       last_synced_at, config::text,
       created_at, updated_at
  FROM audience_destinations
 WHERE tenant_id = $1::uuid
   AND status <> 'disconnected'
   AND ($2 = '' OR provider = $2)
 ORDER BY created_at DESC`, tenantID, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Destination{}
	for rows.Next() {
		var d Destination
		var listID, segID *string
		var cfgText string
		if err := rows.Scan(
			&d.ID, &d.TenantID, (*string)(&d.Provider),
			&listID, &segID,
			&d.ExternalAudienceID, (*string)(&d.Status),
			&d.LastSyncedAt, &cfgText,
			&d.CreatedAt, &d.UpdatedAt,
		); err != nil {
			return nil, err
		}
		d.ListID = listID
		d.SegmentID = segID
		d.Config = maskedAudienceDestinationConfigJSON(cfgText)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Get returns one destination by id (RLS-scoped to tenant).
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Destination, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var d Destination
	var listID, segID *string
	var cfgText string
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider,
       list_id::text, segment_id::text,
       COALESCE(external_audience_id,''), status,
       last_synced_at, config::text,
       created_at, updated_at
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(
		&d.ID, &d.TenantID, (*string)(&d.Provider),
		&listID, &segID,
		&d.ExternalAudienceID, (*string)(&d.Status),
		&d.LastSyncedAt, &cfgText,
		&d.CreatedAt, &d.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	d.ListID = listID
	d.SegmentID = segID
	d.rawConfig = parseDestinationConfig(cfgText)
	d.Config = maskedAudienceDestinationConfigJSON(cfgText)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}

// Create inserts a new destination row.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Destination, error) {
	if !IsValidProvider(in.Provider) {
		return nil, fmt.Errorf("%w: unknown provider %q", ErrInvalidInput, in.Provider)
	}
	hasList := in.ListID != nil && strings.TrimSpace(*in.ListID) != ""
	hasSegment := in.SegmentID != nil && strings.TrimSpace(*in.SegmentID) != ""
	if hasList == hasSegment {
		return nil, fmt.Errorf("%w: exactly one of list_id or segment_id is required", ErrInvalidInput)
	}
	// GAP-1#2: the desktop list picker sends whichever id the lists API
	// returned — a Listmonk bigint — but list_id is inserted straight into a
	// ::uuid cast. Resolve it to the Moosewave uuid first (same as
	// audience-syncs), or a LIST-sourced destination always fails to create.
	if hasList {
		resolved, rerr := r.resolveListRef(ctx, tenantID, *in.ListID)
		if rerr != nil {
			return nil, rerr
		}
		in.ListID = &resolved
	}
	cfg := in.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage("{}")
	}
	parsedCfg := stripAudienceProviderCleanup(parseDestinationConfig(string(cfg)))
	if raw := rawAudienceCredentialConfigKey(parsedCfg); raw != "" {
		return nil, fmt.Errorf("%w: raw credential config is not accepted: %s", ErrInvalidInput, raw)
	}
	if unsafe := unsafeAudienceTransportConfigKey(parsedCfg); unsafe != "" {
		return nil, fmt.Errorf("%w: provider API host overrides are not accepted: %s", ErrInvalidInput, unsafe)
	}
	cfg = marshalDestinationConfig(parsedCfg)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO audience_destinations
       (tenant_id, provider, list_id, segment_id, external_audience_id, config)
VALUES ($1::uuid, $2, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid, NULLIF($5,''), $6::jsonb)
RETURNING id::text`,
		tenantID, in.Provider,
		strOrEmpty(in.ListID), strOrEmpty(in.SegmentID),
		in.ExternalAudienceID, string(cfg),
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, id)
}

// Update mutates status / external_audience_id / config on a destination.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Destination, error) {
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		current, err := r.Get(ctx, tenantID, id)
		if err != nil {
			return nil, err
		}
		if in.IfMatchToken != httpcache.ConcurrencyToken("audience-destination", id, current.UpdatedAt) {
			return nil, ErrPreconditionFailed
		}
		expected := current.UpdatedAt
		expectedUpdatedAt = &expected
	}
	if len(in.Config) > 0 {
		cfg := stripAudienceProviderCleanup(parseDestinationConfig(string(in.Config)))
		if raw := rawAudienceCredentialConfigKey(cfg); raw != "" {
			return nil, fmt.Errorf("%w: raw credential config is not accepted: %s", ErrInvalidInput, raw)
		}
		if unsafe := unsafeAudienceTransportConfigKey(cfg); unsafe != "" {
			return nil, fmt.Errorf("%w: provider API host overrides are not accepted: %s", ErrInvalidInput, unsafe)
		}
		// GAP-1#1: a client edit round-trips the server-masked config. Drop
		// the mask-sentinel keys so the MERGE below keeps the real stored
		// secret instead of overwriting credential_ref with "••••".
		stripMaskedConfigKeys(cfg)
		in.Config = marshalDestinationConfig(cfg)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// GAP-1#1: MERGE the incoming config over the stored one (was a wholesale
	// REPLACE) so keys the client didn't send — including the masked-and-
	// stripped secrets — survive. Empty config ($5) leaves it untouched.
	tag, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = COALESCE($3, status),
       external_audience_id = COALESCE($4, external_audience_id),
       config = CASE
           WHEN NULLIF($5,'') IS NULL THEN config
           ELSE COALESCE(config, '{}'::jsonb) || $5::jsonb
       END - 'provider_cleanup',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND ($6::timestamptz IS NULL OR updated_at = $6::timestamptz)
   AND NOT COALESCE(sync_lease_expires_at > now(), false)`,
		tenantID, id, in.Status, in.ExternalAudienceID, string(in.Config), expectedUpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, classifyDestinationMutationMiss(ctx, tx, tenantID, id, expectedUpdatedAt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, tenantID, id)
}

// Delete disconnects a destination row while preserving sync history.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	return r.DisconnectWithProviderCleanup(ctx, tenantID, id, nil)
}

func (r *Repo) DisconnectWithProviderCleanup(ctx context.Context, tenantID, id string, cleanup *DisconnectCleanupEvidence) error {
	return r.DisconnectWithProviderCleanupIfCurrent(ctx, tenantID, id, cleanup, "")
}

func (r *Repo) DisconnectWithProviderCleanupIfCurrent(ctx context.Context, tenantID, id string, cleanup *DisconnectCleanupEvidence, ifMatchToken string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var expectedUpdatedAt *time.Time
	if ifMatchToken != "" {
		var updatedAt time.Time
		var leaseActive bool
		if err := tx.QueryRow(ctx, `
SELECT updated_at, COALESCE(sync_lease_expires_at > now(), false)
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, id).Scan(&updatedAt, &leaseActive); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if ifMatchToken != httpcache.ConcurrencyToken("audience-destination", id, updatedAt) {
			return ErrPreconditionFailed
		}
		if leaseActive {
			return ErrOperationInProgress
		}
		expectedUpdatedAt = &updatedAt
	}
	cleanupPayload := ""
	if cleanup != nil {
		payload, err := json.Marshal(cleanup)
		if err != nil {
			return err
		}
		cleanupPayload = string(payload)
	}
	tag, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = 'disconnected',
       config = CASE
           WHEN NULLIF($3, '') IS NULL THEN COALESCE(config, '{}'::jsonb)
           ELSE COALESCE(config, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb)
       END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND ($4::timestamptz IS NULL OR updated_at = $4::timestamptz)
   AND NOT COALESCE(sync_lease_expires_at > now(), false)`,
		tenantID, id, cleanupPayload, expectedUpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return classifyDestinationMutationMiss(ctx, tx, tenantID, id, expectedUpdatedAt)
	}
	return tx.Commit(ctx)
}

func classifyDestinationMutationMiss(ctx context.Context, tx pgx.Tx, tenantID, id string, expectedUpdatedAt *time.Time) error {
	var updatedAt time.Time
	var leaseActive bool
	err := tx.QueryRow(ctx, `
SELECT updated_at, COALESCE(sync_lease_expires_at > now(), false)
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(&updatedAt, &leaseActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if leaseActive {
		return ErrOperationInProgress
	}
	if expectedUpdatedAt != nil && !updatedAt.Equal(*expectedUpdatedAt) {
		return ErrPreconditionFailed
	}
	return ErrPreconditionFailed
}

// RecordSyncJob inserts an audience_sync_jobs ledger row for one sync
// attempt: status ('succeeded'/'failed'/'running'), an error string (empty
// on success), and the number of members actually shipped. finished_at is
// stamped for terminal states. Returns the persisted job.
func (r *Repo) RecordSyncJob(ctx context.Context, tenantID, destinationID, status, errMsg string, membersSynced int, evidence ProviderRunEvidence) (*SyncJob, error) {
	evidence = evidence.truncated()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var provider string
	var cfgText string
	if err := tx.QueryRow(ctx, `
SELECT provider, COALESCE(config::text, '{}')
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, destinationID).Scan(&provider, &cfgText); err != nil {
		return nil, err
	}
	schedule := providerDiagnosticsScheduleContext{Provider: provider, Config: parseDestinationConfig(cfgText)}
	providerStatus, providerNextCheck := initialProviderDiagnosticsSchedule(evidence, schedule)
	var job SyncJob
	err = tx.QueryRow(ctx, `
INSERT INTO audience_sync_jobs
       (tenant_id, destination_id, status, error, members_synced, external_job_id,
        external_audience_id, provider_message, provider_status, provider_next_check_at,
        finished_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
        NULLIF($9,''), $10,
        CASE WHEN $3 IN ('succeeded','failed') THEN now() ELSE NULL END)
RETURNING id::text, tenant_id::text, destination_id::text,
          started_at, finished_at, status,
          COALESCE(error,''), members_synced,
          COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
          COALESCE(provider_message,''), COALESCE(provider_status,''),
          provider_checked_at, provider_next_check_at,
          COALESCE(provider_poll_attempts,0),
          COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
          COALESCE(cap_exceeded,false), created_at`,
		tenantID, destinationID, status, errMsg, membersSynced, evidence.ExternalJobID, evidence.ExternalAudienceID, evidence.ProviderMessage,
		providerStatus, providerNextCheck,
	).Scan(
		&job.ID, &job.TenantID, &job.DestinationID,
		&job.StartedAt, &job.FinishedAt, &job.Status,
		&job.Error, &job.MembersSynced,
		&job.ExternalJobID, &job.ExternalAudienceID, &job.ProviderMessage,
		&job.ProviderStatus, &job.ProviderCheckedAt, &job.ProviderNextCheckAt,
		&job.ProviderPollAttempts,
		&job.TriggerKind, &job.SourceMembersObserved, &job.CapExceeded,
		&job.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &job, nil
}

// markDestinationSynced updates the destination's status + last_synced_at
// after a sync attempt. Best-effort: a failure to update status does not
// invalidate the recorded job.
func (r *Repo) markDestinationSynced(ctx context.Context, tenantID, id string, ok bool, externalAudienceID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	status := string(StatusError)
	if ok {
		status = string(StatusActive)
	}
	if _, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = $3,
       last_synced_at = CASE WHEN $4 THEN now() ELSE last_synced_at END,
       external_audience_id = COALESCE(NULLIF($5,''), external_audience_id),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status <> 'disconnected'`,
		tenantID, id, status, ok, externalAudienceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListSyncJobs returns the recent sync jobs for a destination.
func (r *Repo) ListSyncJobs(ctx context.Context, tenantID, destinationID string, limit int) ([]SyncJob, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, destination_id::text,
       started_at, finished_at, status, COALESCE(error,''),
       members_synced,
       COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
       COALESCE(provider_message,''), COALESCE(provider_status,''),
       provider_checked_at, provider_next_check_at,
       COALESCE(provider_poll_attempts,0),
       COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
       COALESCE(cap_exceeded,false), created_at
  FROM audience_sync_jobs
 WHERE tenant_id = $1::uuid AND destination_id = $2::uuid
 ORDER BY started_at DESC
 LIMIT $3`, tenantID, destinationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SyncJob{}
	for rows.Next() {
		var j SyncJob
		if err := rows.Scan(
			&j.ID, &j.TenantID, &j.DestinationID,
			&j.StartedAt, &j.FinishedAt, &j.Status, &j.Error,
			&j.MembersSynced,
			&j.ExternalJobID, &j.ExternalAudienceID, &j.ProviderMessage,
			&j.ProviderStatus, &j.ProviderCheckedAt, &j.ProviderNextCheckAt,
			&j.ProviderPollAttempts,
			&j.TriggerKind, &j.SourceMembersObserved, &j.CapExceeded,
			&j.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetSyncJob returns one sync-job ledger row under a tenant-owned destination.
func (r *Repo) GetSyncJob(ctx context.Context, tenantID, destinationID, jobID string) (*SyncJob, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var j SyncJob
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, destination_id::text,
       started_at, finished_at, status, COALESCE(error,''),
       members_synced,
       COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
       COALESCE(provider_message,''), COALESCE(provider_status,''),
       provider_checked_at, provider_next_check_at,
       COALESCE(provider_poll_attempts,0),
       COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
       COALESCE(cap_exceeded,false), created_at
  FROM audience_sync_jobs
 WHERE tenant_id = $1::uuid
   AND destination_id = $2::uuid
   AND id = $3::uuid`,
		tenantID, destinationID, jobID,
	).Scan(
		&j.ID, &j.TenantID, &j.DestinationID,
		&j.StartedAt, &j.FinishedAt, &j.Status, &j.Error,
		&j.MembersSynced,
		&j.ExternalJobID, &j.ExternalAudienceID, &j.ProviderMessage,
		&j.ProviderStatus, &j.ProviderCheckedAt, &j.ProviderNextCheckAt,
		&j.ProviderPollAttempts,
		&j.TriggerKind, &j.SourceMembersObserved, &j.CapExceeded,
		&j.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &j, nil
}

func strOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
