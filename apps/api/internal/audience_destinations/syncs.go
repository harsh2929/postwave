// SPDX-License-Identifier: AGPL-3.0-only
//
// syncs.go — types + repository for the audience_syncs /
// audience_sync_runs tables (migrations 0376 + 0377).
//
// This is the *working* audience-sync surface (GAPS-REMAINING item A13).
// Webhook destinations run end-to-end in-repo: the executor resolves the
// source list/segment members and POSTs them in HMAC-signed batches to a
// tenant URL. Ad-platform destinations share the runner, consent firewall, and
// credential-reference resolver; provider-specific driver/app-review evidence
// still gates full native availability.
package audience_destinations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

// DestinationTypeWebhook is the in-repo, credential-free destination.
// SUB-113 adds the credentialed ad-platform destination types below; the
// CHECK constraint on audience_syncs.destination_type is widened to match
// in migration 1114.
const DestinationTypeWebhook = "webhook"

// Platform destination types (SUB-113). A sync of one of these types routes
// through the runner's PlatformAdapter path instead of a signed webhook POST.
// They mirror Provider above + the AdapterRegistry keys. The public API stores
// credential references, so live delivery depends on a trusted resolver feeding
// adapters the concrete provider credentials outside tenant-supplied config.
const (
	DestinationTypeMeta      = "meta"
	DestinationTypeGoogleAds = "google_ads"
	DestinationTypeTikTok    = "tiktok"
	DestinationTypeLinkedIn  = "linkedin"
	DestinationTypeSnap      = "snap"
)

// allowedDestinationTypes is the canonical set a sync may use — mirrors
// the migration 1114 CHECK constraint exactly.
var allowedDestinationTypes = map[string]struct{}{
	DestinationTypeWebhook:   {},
	DestinationTypeMeta:      {},
	DestinationTypeGoogleAds: {},
	DestinationTypeTikTok:    {},
	DestinationTypeLinkedIn:  {},
	DestinationTypeSnap:      {},
}

// normalizeDestinationType lower-cases + trims a raw destination type,
// defaulting empty to webhook (back-compat with v1 callers that omit it),
// and validates it against allowedDestinationTypes.
func normalizeDestinationType(raw string) (string, error) {
	t := strings.ToLower(strings.TrimSpace(raw))
	if t == "" {
		t = DestinationTypeWebhook
	}
	if _, ok := allowedDestinationTypes[t]; !ok {
		return "", fmt.Errorf("%w: destination.type %q not supported (use one of webhook, meta, google_ads, tiktok, linkedin, snap)", ErrInvalidInput, raw)
	}
	return t, nil
}

// isPlatformDestinationType reports whether t is a credentialed
// ad-platform destination (anything other than the webhook type).
func isPlatformDestinationType(t string) bool {
	return t != "" && t != DestinationTypeWebhook
}

// Sync schedules. "manual" runs only via POST /{id}/run; hourly/daily
// are picked up by the SyncScheduler tick.
const (
	ScheduleManual = "manual"
	ScheduleHourly = "hourly"
	ScheduleDaily  = "daily"
)

// Run statuses (audience_sync_runs.status CHECK).
const (
	RunStatusRunning             = "running"
	RunStatusSucceeded           = "succeeded"
	RunStatusFailed              = "failed"
	RunStatusRejected            = "rejected"
	RunStatusPartial             = "partial"
	RunStatusNeedsReconciliation = "needs_reconciliation"
)

// SyncSource is the {list_id | segment_id} pair — exactly one is set
// (enforced by the 0376 XOR CHECK).
type SyncSource struct {
	ListID    *string `json:"list_id,omitempty"`
	SegmentID *string `json:"segment_id,omitempty"`
}

// SyncDestination is the wire shape of the destination block. Secret
// is write-only: reads return SecretSet=true + a masked tail instead.
type SyncDestination struct {
	Type string `json:"type"`
	URL  string `json:"url"`
	// Secret is accepted on create/update and NEVER echoed back.
	Secret string `json:"secret,omitempty"`
	// SecretSet + SecretHint are the read-side substitute for Secret.
	SecretSet  bool   `json:"secret_set,omitempty"`
	SecretHint string `json:"secret_hint,omitempty"`
	// Config carries non-secret platform-adapter destination settings for
	// non-webhook destination types (SUB-113): audience_id, account ids,
	// approval flags, and credential refs. Raw access tokens are rejected by
	// public APIs; a trusted credential resolver must hydrate adapter secrets
	// before live provider delivery.
	Config map[string]any `json:"config,omitempty"`
}

// Sync is one row from audience_syncs as returned by the API. The
// destination secret is masked (see maskSecret).
type Sync struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Source        SyncSource      `json:"source"`
	Destination   SyncDestination `json:"destination"`
	Schedule      string          `json:"schedule"`
	Enabled       bool            `json:"enabled"`
	LastRunAt     *time.Time      `json:"last_run_at,omitempty"`
	LastRunStatus string          `json:"last_run_status,omitempty"`
	// RequiredConsentPurpose (feature #2, migration 0407) optionally
	// overrides the destination-derived consent purpose for the firewall.
	RequiredConsentPurpose string    `json:"required_consent_purpose,omitempty"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`

	// secret is the plaintext signing secret, loaded for the runner
	// only — never serialized (lowercase field).
	secret string
	// rawConfig is the UNMASKED platform-destination config, loaded for
	// the runner/adapter only — never serialized. Destination.Config holds
	// the masked copy that the read API returns.
	rawConfig map[string]any
}

// AdapterConfig returns the unmasked platform-destination config the
// runner hands to the PlatformAdapter (credentials intact). Falls back to
// the (possibly masked) wire Config when rawConfig is unset — e.g. a Sync
// constructed in-memory by a test or the firewall preview path.
func (s *Sync) AdapterConfig() map[string]any {
	if len(s.rawConfig) > 0 {
		return s.rawConfig
	}
	return s.Destination.Config
}

// SyncRun is one row from audience_sync_runs.
type SyncRun struct {
	ID                    string     `json:"id"`
	SyncID                string     `json:"sync_id"`
	Status                string     `json:"status"`
	RowsExported          int        `json:"rows_exported"`
	BatchesSent           int        `json:"batches_sent"`
	StartedAt             time.Time  `json:"started_at"`
	FinishedAt            *time.Time `json:"finished_at,omitempty"`
	Error                 string     `json:"error,omitempty"`
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
	// ExcludedCount (feature #2, migration 0407) is how many members the
	// activation firewall withheld for this run.
	ExcludedCount int `json:"excluded_count"`
}

// SyncCreateInput is the body of POST /api/v1/audience-syncs.
type SyncCreateInput struct {
	Name        string          `json:"name"`
	Source      SyncSource      `json:"source"`
	Destination SyncDestination `json:"destination"`
	Schedule    string          `json:"schedule"`
	Enabled     *bool           `json:"enabled,omitempty"`
}

// SyncUpdateInput is the body of PATCH /api/v1/audience-syncs/{id}.
// nil fields are left untouched.
type SyncUpdateInput struct {
	Name         *string          `json:"name,omitempty"`
	Source       *SyncSource      `json:"source,omitempty"`
	Destination  *SyncDestination `json:"destination,omitempty"`
	Schedule     *string          `json:"schedule,omitempty"`
	Enabled      *bool            `json:"enabled,omitempty"`
	IfMatchToken string           `json:"-"`
}

// validateSchedule returns the normalized schedule or an error.
func validateSchedule(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", ScheduleManual:
		return ScheduleManual, nil
	case ScheduleHourly:
		return ScheduleHourly, nil
	case ScheduleDaily:
		return ScheduleDaily, nil
	}
	return "", fmt.Errorf("%w: schedule must be manual|hourly|daily", ErrInvalidInput)
}

// validateDestinationURL enforces the same posture as outbound
// webhooks: http(s) only, no embedded credentials, and HTTPS required
// when requireHTTPS (non-dev). SSRF protection at delivery time comes
// from outbound_webhooks.NewSecureHTTPClient in the runner.
func validateDestinationURL(raw string, requireHTTPS bool) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return fmt.Errorf("%w: destination.url required (max 2048 chars)", ErrInvalidInput)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("%w: destination.url is not a valid URL", ErrInvalidInput)
	}
	if u.User != nil {
		return fmt.Errorf("%w: destination.url must not embed credentials", ErrInvalidInput)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if requireHTTPS {
			return fmt.Errorf("%w: destination.url must be https in this environment", ErrInvalidInput)
		}
	default:
		return fmt.Errorf("%w: destination.url must be http(s)", ErrInvalidInput)
	}
	return nil
}

// validateCreate normalizes + validates a SyncCreateInput in place.
func validateCreate(in *SyncCreateInput, requireHTTPS bool) error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		return fmt.Errorf("%w: name required (max 200 chars)", ErrInvalidInput)
	}
	if err := validateSource(in.Source); err != nil {
		return err
	}
	dtype, err := normalizeDestinationType(in.Destination.Type)
	if err != nil {
		return err
	}
	in.Destination.Type = dtype
	if isPlatformDestinationType(dtype) {
		// Credentialed ad-platform destination (SUB-113): no webhook URL /
		// HMAC secret — delivery goes through the platform adapter using the
		// destination Config (audience id, account id, credential ref).
		if len(in.Destination.Config) == 0 {
			return fmt.Errorf("%w: destination.config required for %q (audience id + credentials)", ErrInvalidInput, dtype)
		}
		if raw := rawAudienceCredentialConfigKey(in.Destination.Config); raw != "" {
			return fmt.Errorf("%w: destination.config must store credential references, not raw %s", ErrInvalidInput, raw)
		}
		if unsafe := unsafeAudienceTransportConfigKey(in.Destination.Config); unsafe != "" {
			return fmt.Errorf("%w: destination.config must not override provider API hosts: %s", ErrInvalidInput, unsafe)
		}
	} else {
		if err := validateDestinationURL(in.Destination.URL, requireHTTPS); err != nil {
			return err
		}
		if strings.TrimSpace(in.Destination.Secret) == "" {
			return fmt.Errorf("%w: destination.secret required (HMAC signing key)", ErrInvalidInput)
		}
	}
	sched, err := validateSchedule(in.Schedule)
	if err != nil {
		return err
	}
	in.Schedule = sched
	return nil
}

// validateSource enforces the exactly-one-of contract.
func validateSource(s SyncSource) error {
	hasList := s.ListID != nil && strings.TrimSpace(*s.ListID) != ""
	hasSeg := s.SegmentID != nil && strings.TrimSpace(*s.SegmentID) != ""
	if hasList == hasSeg {
		return fmt.Errorf("%w: exactly one of source.list_id or source.segment_id is required", ErrInvalidInput)
	}
	return nil
}

// maskSecret renders the read-side hint: last 4 chars, or "set" when
// the secret is too short to safely reveal a tail.
func maskSecret(secret string) string {
	if secret == "" {
		return ""
	}
	if len(secret) <= 8 {
		return "••••"
	}
	return "••••" + secret[len(secret)-4:]
}

const syncSelectColumns = `
       id::text, name,
       list_id::text, segment_id::text,
       destination_type, destination_url, destination_secret,
       schedule, enabled,
       last_run_at, COALESCE(last_run_status,''),
       COALESCE(required_consent_purpose,''),
       COALESCE(destination_config::text, '{}'),
       created_at, updated_at`

// scanSync scans one audience_syncs row (column order above).
func scanSync(row pgx.Row) (*Sync, error) {
	var s Sync
	var listID, segID *string
	var cfgText string
	if err := row.Scan(
		&s.ID, &s.Name,
		&listID, &segID,
		&s.Destination.Type, &s.Destination.URL, &s.secret,
		&s.Schedule, &s.Enabled,
		&s.LastRunAt, &s.LastRunStatus,
		&s.RequiredConsentPurpose,
		&cfgText,
		&s.CreatedAt, &s.UpdatedAt,
	); err != nil {
		return nil, err
	}
	s.Source.ListID = listID
	s.Source.SegmentID = segID
	s.Destination.SecretSet = s.secret != ""
	s.Destination.SecretHint = maskSecret(s.secret)
	// Platform-destination config (SUB-113): loaded for the runner. It can
	// carry credential references, so it is masked on the read API rather
	// than echoed verbatim (see maskDestinationConfig).
	if cfg := parseDestinationConfig(cfgText); len(cfg) > 0 {
		s.Destination.Config = maskDestinationConfig(cfg)
		s.rawConfig = cfg
	}
	return &s, nil
}

// parseDestinationConfig decodes the jsonb config text into a map,
// returning nil for empty / "{}" / unparseable input.
func parseDestinationConfig(text string) map[string]any {
	t := strings.TrimSpace(text)
	if t == "" || t == "{}" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(t), &m); err != nil {
		return nil
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// configSecretKeys are config fields that must never be echoed back by
// the read API — they hold credentials. Masked to a fixed sentinel so the
// UI can show "configured" without leaking the value.
var configSecretKeys = map[string]struct{}{
	"access_token":        {},
	"access_token_ref":    {},
	"api_key":             {},
	"api_secret":          {},
	"client_secret":       {},
	"credential_ref":      {},
	"credentials_ref":     {},
	"developer_token":     {},
	"developer_token_ref": {},
	"password":            {},
	"private_key":         {},
	"refresh_token":       {},
	"secret":              {},
	"token":               {},
	"token_ref":           {},
}

// configMaskSentinel is the fixed value the read API substitutes for a
// secret-bearing config key (maskDestinationConfig). A client that edits a
// destination round-trips this sentinel; the write path must ignore it so
// the real stored credential isn't overwritten with "••••" (GAP-1#1).
const configMaskSentinel = "••••"

// maskDestinationConfig returns a copy of cfg with secret-bearing keys
// replaced by a fixed mask. Non-secret ids (audience_id, account_id, …)
// pass through so the UI can render them.
func maskDestinationConfig(cfg map[string]any) map[string]any {
	if len(cfg) == 0 {
		return nil
	}
	out := make(map[string]any, len(cfg))
	for k, v := range cfg {
		if _, secret := configSecretKeys[strings.ToLower(strings.TrimSpace(k))]; secret {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				out[k] = configMaskSentinel
				continue
			}
		}
		out[k] = v
	}
	return out
}

// stripMaskedConfigKeys deletes keys whose value is the read-API mask
// sentinel, in place. A destination edit round-trips the masked config
// (GAP-1#1); dropping the sentinel keys lets the write path MERGE the
// remainder over the stored config so the real secret survives, mirroring
// the audience-sync secret_set/secret_hint write-only pattern.
func stripMaskedConfigKeys(cfg map[string]any) {
	for k, v := range cfg {
		if s, ok := v.(string); ok && s == configMaskSentinel {
			delete(cfg, k)
		}
	}
}

// ListSyncs returns the tenant's syncs, newest-first.
func (r *Repo) ListSyncs(ctx context.Context, tenantID string) ([]Sync, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+syncSelectColumns+`
  FROM audience_syncs
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sync{}
	for rows.Next() {
		s, err := scanSync(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetSync returns one sync (RLS-scoped). The returned Sync carries the
// plaintext secret internally for the runner; JSON output stays masked.
func (r *Repo) GetSync(ctx context.Context, tenantID, id string) (*Sync, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := scanSync(tx.QueryRow(ctx, `
SELECT `+syncSelectColumns+`
  FROM audience_syncs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// CreateSync inserts a new sync. Input must already be validated
// (validateCreate normalizes Destination.Type + branches on it).
func (r *Repo) CreateSync(ctx context.Context, tenantID string, in SyncCreateInput) (*Sync, error) {
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	dtype := in.Destination.Type
	if dtype == "" {
		dtype = DestinationTypeWebhook
	}
	// Platform destinations carry no webhook URL/secret; the column CHECK
	// requires a length-1+ URL, so persist the destination type as a
	// non-empty placeholder and leave the secret empty.
	destURL := strings.TrimSpace(in.Destination.URL)
	destSecret := in.Destination.Secret
	cfgJSON := "{}"
	if isPlatformDestinationType(dtype) {
		if destURL == "" {
			destURL = dtype
		}
		destSecret = ""
		if len(in.Destination.Config) > 0 {
			b, err := json.Marshal(in.Destination.Config)
			if err != nil {
				return nil, fmt.Errorf("%w: destination.config is not valid JSON", ErrInvalidInput)
			}
			cfgJSON = string(b)
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO audience_syncs
       (tenant_id, name, list_id, segment_id,
        destination_type, destination_url, destination_secret,
        destination_config, schedule, enabled)
VALUES ($1::uuid, $2, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid,
        $5, $6, $7, $10::jsonb, $8, $9)
RETURNING id::text`,
		tenantID, in.Name,
		strOrEmpty(in.Source.ListID), strOrEmpty(in.Source.SegmentID),
		dtype, destURL,
		destSecret, in.Schedule, enabled, cfgJSON,
	).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a sync named %q already exists", ErrInvalidInput, in.Name)
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetSync(ctx, tenantID, id)
}

// UpdateSync applies a partial patch. Source replacement keeps the XOR
// invariant by clearing the other column.
func (r *Repo) UpdateSync(ctx context.Context, tenantID, id string, in SyncUpdateInput, requireHTTPS bool) (*Sync, error) {
	cur, err := r.GetSync(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		if in.IfMatchToken != httpcache.ConcurrencyToken("audience-sync", id, cur.UpdatedAt) {
			return nil, ErrPreconditionFailed
		}
		expected := cur.UpdatedAt
		expectedUpdatedAt = &expected
	}
	next := *cur
	if in.Name != nil {
		next.Name = strings.TrimSpace(*in.Name)
		if next.Name == "" || len(next.Name) > 200 {
			return nil, fmt.Errorf("%w: name required (max 200 chars)", ErrInvalidInput)
		}
	}
	if in.Source != nil {
		if err := validateSource(*in.Source); err != nil {
			return nil, err
		}
		next.Source = *in.Source
	}
	if in.Destination != nil {
		// Resolve the effective destination type: an explicit type in the
		// patch wins; otherwise keep the current one.
		if strings.TrimSpace(in.Destination.Type) != "" {
			dt, err := normalizeDestinationType(in.Destination.Type)
			if err != nil {
				return nil, err
			}
			next.Destination.Type = dt
		}
		if isPlatformDestinationType(next.Destination.Type) {
			// Platform destination (SUB-113): config-driven, no webhook URL/
			// secret. A config in the patch replaces the stored one.
			if in.Destination.Config != nil {
				if raw := rawAudienceCredentialConfigKey(in.Destination.Config); raw != "" {
					return nil, fmt.Errorf("%w: destination.config must store credential references, not raw %s", ErrInvalidInput, raw)
				}
				if unsafe := unsafeAudienceTransportConfigKey(in.Destination.Config); unsafe != "" {
					return nil, fmt.Errorf("%w: destination.config must not override provider API hosts: %s", ErrInvalidInput, unsafe)
				}
				next.rawConfig = in.Destination.Config
			}
			if len(next.rawConfig) == 0 {
				return nil, fmt.Errorf("%w: destination.config required for %q", ErrInvalidInput, next.Destination.Type)
			}
		} else {
			if in.Destination.URL != "" {
				if err := validateDestinationURL(in.Destination.URL, requireHTTPS); err != nil {
					return nil, err
				}
				next.Destination.URL = strings.TrimSpace(in.Destination.URL)
			}
			if strings.TrimSpace(in.Destination.Secret) != "" {
				next.secret = in.Destination.Secret
			}
		}
	}
	if in.Schedule != nil {
		sched, err := validateSchedule(*in.Schedule)
		if err != nil {
			return nil, err
		}
		next.Schedule = sched
	}
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}

	// Derive the persisted URL/secret/config from the effective type.
	destType := next.Destination.Type
	if destType == "" {
		destType = DestinationTypeWebhook
	}
	destURL := next.Destination.URL
	destSecret := next.secret
	cfgJSON := "{}"
	if isPlatformDestinationType(destType) {
		if strings.TrimSpace(destURL) == "" {
			destURL = destType
		}
		destSecret = ""
		if len(next.rawConfig) > 0 {
			b, err := json.Marshal(next.rawConfig)
			if err != nil {
				return nil, fmt.Errorf("%w: destination.config is not valid JSON", ErrInvalidInput)
			}
			cfgJSON = string(b)
		}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET name = $3,
       list_id = NULLIF($4,'')::uuid,
       segment_id = NULLIF($5,'')::uuid,
       destination_type = $6,
       destination_url = $7,
       destination_secret = $8,
       destination_config = $11::jsonb,
       schedule = $9,
       enabled = $10,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND ($12::timestamptz IS NULL OR updated_at = $12::timestamptz)
   AND NOT COALESCE(run_lease_expires_at > now(), false)`,
		tenantID, id, next.Name,
		strOrEmpty(next.Source.ListID), strOrEmpty(next.Source.SegmentID),
		destType, destURL, destSecret, next.Schedule, next.Enabled, cfgJSON, expectedUpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a sync named %q already exists", ErrInvalidInput, next.Name)
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, classifySyncMutationMiss(ctx, tx, tenantID, id, expectedUpdatedAt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetSync(ctx, tenantID, id)
}

// DeleteSync removes a sync (runs cascade via FK).
func (r *Repo) DeleteSync(ctx context.Context, tenantID, id string) error {
	return r.DeleteSyncIfCurrent(ctx, tenantID, id, "")
}

func (r *Repo) DeleteSyncIfCurrent(ctx context.Context, tenantID, id, ifMatchToken string) error {
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
SELECT updated_at, COALESCE(run_lease_expires_at > now(), false)
  FROM audience_syncs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, id).Scan(&updatedAt, &leaseActive); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if ifMatchToken != httpcache.ConcurrencyToken("audience-sync", id, updatedAt) {
			return ErrPreconditionFailed
		}
		if leaseActive {
			return ErrOperationInProgress
		}
		expectedUpdatedAt = &updatedAt
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM audience_syncs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND ($3::timestamptz IS NULL OR updated_at = $3::timestamptz)
   AND NOT COALESCE(run_lease_expires_at > now(), false)`, tenantID, id, expectedUpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return classifySyncMutationMiss(ctx, tx, tenantID, id, expectedUpdatedAt)
	}
	return tx.Commit(ctx)
}

func classifySyncMutationMiss(ctx context.Context, tx pgx.Tx, tenantID, id string, expectedUpdatedAt *time.Time) error {
	var updatedAt time.Time
	var leaseActive bool
	err := tx.QueryRow(ctx, `
SELECT updated_at, COALESCE(run_lease_expires_at > now(), false)
  FROM audience_syncs
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
	// A row that matched neither predicate changed between validation and the
	// write. Fail closed even for a legacy caller that omitted If-Match.
	return ErrPreconditionFailed
}

// ListSyncRuns returns the recent runs for a sync, newest-first.
func (r *Repo) ListSyncRuns(ctx context.Context, tenantID, syncID string, limit int) ([]SyncRun, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, sync_id::text, status, rows_exported, batches_sent,
       started_at, finished_at, COALESCE(error,''),
       COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
       COALESCE(provider_message,''),
       COALESCE(provider_status,''), provider_checked_at, provider_next_check_at,
       COALESCE(provider_poll_attempts,0),
       COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
       COALESCE(cap_exceeded,false),
       COALESCE(excluded_count, 0)
  FROM audience_sync_runs
 WHERE tenant_id = $1::uuid AND sync_id = $2::uuid
 ORDER BY started_at DESC
 LIMIT $3`, tenantID, syncID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SyncRun{}
	for rows.Next() {
		var run SyncRun
		if err := rows.Scan(
			&run.ID, &run.SyncID, &run.Status, &run.RowsExported, &run.BatchesSent,
			&run.StartedAt, &run.FinishedAt, &run.Error,
			&run.ExternalJobID, &run.ExternalAudienceID, &run.ProviderMessage,
			&run.ProviderStatus, &run.ProviderCheckedAt, &run.ProviderNextCheckAt,
			&run.ProviderPollAttempts,
			&run.TriggerKind, &run.SourceMembersObserved, &run.CapExceeded,
			&run.ExcludedCount,
		); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// setRunExcludedCount records how many members the activation firewall
// withheld for a run (feature #2, migration 0407). Best-effort; the run
// itself is authoritative via the per-row exclusion receipts.
func (r *Repo) setRunExcludedCount(ctx context.Context, tenantID, runID string, n int) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE audience_sync_runs SET excluded_count = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, runID, n); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// beginRun inserts the 'running' ledger row and returns its id.
func (r *Repo) beginRun(ctx context.Context, tenantID, syncID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO audience_sync_runs (tenant_id, sync_id, status)
VALUES ($1::uuid, $2::uuid, 'running')
RETURNING id::text`, tenantID, syncID).Scan(&id); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// finishRun closes the ledger row and denormalizes last_run_* onto the
// sync. errMsg is truncated so a giant receiver body can't bloat the
// ledger.
func (r *Repo) finishRun(ctx context.Context, tenantID, syncID, runID, status string, rowsExported, batchesSent int, errMsg string, evidence ProviderRunEvidence, schedule providerDiagnosticsScheduleContext) error {
	const maxErrLen = 2000
	if len(errMsg) > maxErrLen {
		errMsg = errMsg[:maxErrLen] + "…"
	}
	evidence = evidence.truncated()
	providerStatus, providerNextCheck := initialProviderDiagnosticsSchedule(evidence, schedule)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audience_sync_runs
   SET status = $3, rows_exported = $4, batches_sent = $5,
       error = NULLIF($6,''), finished_at = now(),
       external_job_id = NULLIF($7,''),
       external_audience_id = NULLIF($8,''),
       provider_message = NULLIF($9,''),
       provider_status = NULLIF($10,''),
       provider_next_check_at = $11
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID, status, rowsExported, batchesSent, errMsg, evidence.ExternalJobID, evidence.ExternalAudienceID, evidence.ProviderMessage,
		providerStatus, providerNextCheck); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET last_run_at = now(), last_run_status = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, syncID, status); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// isUniqueViolation reports a Postgres 23505 without importing pgconn
// directly (string match keeps the dependency surface flat — same
// approach as several sibling packages).
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}

// MemberRow is one serialized audience member as delivered to the
// destination: email, status, tags, consent.
type MemberRow struct {
	Email            string   `json:"email"`
	Status           string   `json:"status"`
	Tags             []string `json:"tags"`
	ConsentSource    string   `json:"consent_source"`
	ConsentTimestamp *string  `json:"consent_timestamp,omitempty"`
}
