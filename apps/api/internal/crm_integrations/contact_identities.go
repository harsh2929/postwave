// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrCRMContactIdentityAmbiguous   = errors.New("crm contact identity is ambiguous")
	ErrCRMContactIdentityConflict    = errors.New("crm contact identity is already bound to another profile")
	ErrCRMContactSourceRevisionStale = errors.New("crm contact source revision is stale")
	ErrCRMContactPrivacyDeleted      = errors.New("crm contact has a privacy-deletion tombstone")
)

// CRMContactProfileBinding is the integration-scoped bridge between a
// provider object and Moosewave's stable profile identity. It deliberately does
// not use subscribers.external_id: that tenant-wide identifier may belong to
// another source system.
type CRMContactProfileBinding struct {
	ID                  string
	TenantID            string
	IntegrationID       string
	Provider            string
	ProviderContactID   string
	SubscriberID        string
	SubscriberProfileID string
	State               string
	BindingOrigin       string
	LastEmail           string
	SourceRevisionAt    *time.Time
	StateMetadata       map[string]any
	FirstSeenAt         time.Time
	LastSeenAt          time.Time
	InactiveAt          *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

const crmContactProfileBindingColumns = `
id::text, tenant_id::text, integration_id::text, provider,
provider_contact_id, subscriber_id::text, state, binding_origin,
COALESCE(last_email::text, ''), source_revision_at, state_metadata,
first_seen_at, last_seen_at, inactive_at, created_at, updated_at`

type crmContactBindingScanner interface {
	Scan(...any) error
}

// WithCRMContactProfileBindingLock serializes the resolve -> subscriber
// identify -> bind sequence for one integration-scoped provider object. The
// subscriber identity transaction and CRM binding transaction live in
// different repositories, so this session-level advisory lock is the shared
// cross-process critical section that prevents two first-seen email variants
// from creating profiles before either binding becomes visible.
func (r *Repo) WithCRMContactProfileBindingLock(
	ctx context.Context,
	tenantID, integrationID, provider, providerContactID string,
	fn func() error,
) error {
	tenantID, integrationID, provider, providerContactID, err := normalizeCRMContactBindingKey(
		tenantID, integrationID, provider, providerContactID,
	)
	if err != nil {
		return err
	}
	if fn == nil {
		return fmt.Errorf("crm contact identity: locked operation is required")
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("crm contact identity: acquire binding lock connection: %w", err)
	}
	defer conn.Release()
	var lockKey strings.Builder
	for _, part := range []string{tenantID, integrationID, provider, providerContactID} {
		_, _ = fmt.Fprintf(&lockKey, "%d:", len(part))
		lockKey.WriteString(part)
	}
	if _, err := conn.Exec(ctx, `
SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey.String()); err != nil {
		return fmt.Errorf("crm contact identity: acquire binding lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(
			context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
			lockKey.String(),
		)
	}()
	return fn()
}

func scanCRMContactProfileBinding(row crmContactBindingScanner) (*CRMContactProfileBinding, error) {
	var (
		out CRMContactProfileBinding
		raw []byte
	)
	if err := row.Scan(
		&out.ID,
		&out.TenantID,
		&out.IntegrationID,
		&out.Provider,
		&out.ProviderContactID,
		&out.SubscriberID,
		&out.State,
		&out.BindingOrigin,
		&out.LastEmail,
		&out.SourceRevisionAt,
		&raw,
		&out.FirstSeenAt,
		&out.LastSeenAt,
		&out.InactiveAt,
		&out.CreatedAt,
		&out.UpdatedAt,
	); err != nil {
		return nil, err
	}
	out.StateMetadata = map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.StateMetadata)
	}
	return &out, nil
}

func normalizeCRMContactBindingKey(tenantID, integrationID, provider, providerContactID string) (string, string, string, string, error) {
	tenantID = strings.TrimSpace(tenantID)
	integrationID = strings.TrimSpace(integrationID)
	provider = strings.ToLower(strings.TrimSpace(provider))
	providerContactID = strings.TrimSpace(providerContactID)
	switch {
	case tenantID == "":
		return "", "", "", "", fmt.Errorf("crm contact identity: tenant is required")
	case integrationID == "":
		return "", "", "", "", fmt.Errorf("crm contact identity: integration is required")
	case provider == "":
		return "", "", "", "", fmt.Errorf("crm contact identity: provider is required")
	case providerContactID == "":
		return "", "", "", "", fmt.Errorf("crm contact identity: provider contact id is required")
	default:
		return tenantID, integrationID, provider, providerContactID, nil
	}
}

func ensureCRMContactBindingIntegration(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, integrationID, provider string,
) error {
	var matches bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM crm_integrations
     WHERE tenant_id = $1::uuid
       AND id = $2::uuid
       AND provider = $3
)`, tenantID, integrationID, provider).Scan(&matches); err != nil {
		return fmt.Errorf("crm contact identity: verify integration: %w", err)
	}
	if !matches {
		return fmt.Errorf("crm contact identity: integration/provider mismatch")
	}
	return nil
}

func loadCRMContactProfileBinding(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, integrationID, provider, providerContactID string,
) (*CRMContactProfileBinding, error) {
	out, err := scanCRMContactProfileBinding(tx.QueryRow(ctx, `
SELECT `+crmContactProfileBindingColumns+`
  FROM crm_contact_profile_bindings
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND provider_contact_id = $4`,
		tenantID, integrationID, provider, providerContactID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: load binding: %w", err)
	}
	return out, nil
}

func refreshCRMContactProfileBinding(
	ctx context.Context,
	tx pgx.Tx,
	binding *CRMContactProfileBinding,
) (*CRMContactProfileBinding, error) {
	if binding == nil {
		return nil, nil
	}
	var subscriberID, profileID, email string
	var unresolvedLineage bool
	err := tx.QueryRow(ctx, `
WITH RECURSIVE resolved(id, profile_id, email, merged_into_subscriber_id, depth, path) AS (
    SELECT id, profile_id, email, merged_into_subscriber_id, 0, ARRAY[id]::uuid[]
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND id = $2::uuid
    UNION ALL
    SELECT parent.id, parent.profile_id, parent.email,
           parent.merged_into_subscriber_id, resolved.depth + 1,
           resolved.path || parent.id
      FROM resolved
      JOIN subscribers parent
        ON parent.tenant_id = $1::uuid
       AND parent.id = resolved.merged_into_subscriber_id
     WHERE resolved.merged_into_subscriber_id IS NOT NULL
       AND resolved.depth < 32
       AND NOT parent.id = ANY(resolved.path)
)
SELECT id::text, profile_id::text, email::text,
       merged_into_subscriber_id IS NOT NULL
  FROM resolved
 ORDER BY depth DESC
 LIMIT 1`, binding.TenantID, binding.SubscriberID).Scan(
		&subscriberID,
		&profileID,
		&email,
		&unresolvedLineage,
	)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: resolve subscriber merge lineage: %w", err)
	}
	if unresolvedLineage {
		return nil, fmt.Errorf(
			"%w: subscriber merge lineage is cyclic, broken, or exceeds 32 hops",
			ErrCRMContactIdentityAmbiguous,
		)
	}
	binding.SubscriberProfileID = profileID
	if subscriberID == binding.SubscriberID {
		return binding, nil
	}
	out, err := scanCRMContactProfileBinding(tx.QueryRow(ctx, `
UPDATE crm_contact_profile_bindings
   SET subscriber_id = $3::uuid,
       last_email = CASE
           WHEN state = 'privacy_deleted' THEN NULL
           ELSE COALESCE(NULLIF(last_email::text, '')::citext, NULLIF($4, '')::citext)
       END,
       state_metadata = state_metadata || jsonb_build_object(
           'merge_lineage_reconciled_at', now(),
           'previous_subscriber_id', subscriber_id::text
       ),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING `+crmContactProfileBindingColumns,
		binding.TenantID, binding.ID, subscriberID, email))
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: refresh merged binding: %w", err)
	}
	out.SubscriberProfileID = profileID
	return out, nil
}

// ResolveCRMContactProfileBinding resolves a previously bound provider object.
// When no native binding exists, it performs a one-time, fail-closed bridge to
// an exact migration row using source_platform + source_id. Email is
// intentionally not consulted here; the profile sink may use email only after
// this stronger source identity has been exhausted.
func (r *Repo) ResolveCRMContactProfileBinding(
	ctx context.Context,
	tenantID, integrationID, provider, providerContactID string,
) (*CRMContactProfileBinding, error) {
	tenantID, integrationID, provider, providerContactID, err := normalizeCRMContactBindingKey(
		tenantID, integrationID, provider, providerContactID,
	)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCRMContactBindingIntegration(ctx, tx, tenantID, integrationID, provider); err != nil {
		return nil, err
	}
	if existing, err := loadCRMContactProfileBinding(ctx, tx, tenantID, integrationID, provider, providerContactID); err != nil {
		return nil, err
	} else if existing != nil {
		existing, err = refreshCRMContactProfileBinding(ctx, tx, existing)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return existing, nil
	}

	type migrationCandidate struct {
		subscriberID string
		email        string
		unresolved   bool
	}
	const maxMigrationLedgerCandidates = 64
	sourceIDs := []string{providerContactID}
	if provider == ProviderHubSpot {
		if objectID := hubSpotContactObjectID(providerContactID); objectID != "" {
			sourceIDs = uniqueCRMStrings(append(
				sourceIDs,
				objectID,
				"hubspot:contact:"+objectID,
			))
		}
	}
	projectionKeys := make([]string, 0, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		projectionKeys = append(projectionKeys, provider+":"+sourceID)
	}

	// A subscriber merge PII-minimizes the duplicate and deliberately clears
	// its source_platform/source_id columns. The migration ledger is the
	// authoritative source-to-destination projection that survives that
	// operation. Lock matching active ledger rows, validate their exact
	// Moosewave subscriber UUID, and feed those seed rows through the same merge
	// lineage resolver as direct subscriber provenance.
	ledgerRows, err := tx.Query(ctx, `
SELECT imported.id::text,
       COALESCE(imported.destination_metadata ->> 'postwave_subscriber_id', '')
  FROM migration_imported_resources imported
  JOIN migration_jobs job
    ON job.tenant_id = imported.tenant_id
   AND job.id = imported.job_id
 WHERE imported.tenant_id = $1::uuid
   AND imported.resource_type = 'subscriber'
   AND imported.rolled_back_at IS NULL
   AND job.source = $2
   AND job.status <> 'rolled_back'
   AND (
       (
           lower(imported.source_platform) = $2
           AND (
               imported.source_id = ANY($3::text[])
               OR (
                   jsonb_typeof(imported.destination_metadata -> 'source_ids') = 'array'
                   AND (imported.destination_metadata -> 'source_ids') ?| $3::text[]
               )
           )
       )
       OR EXISTS (
           SELECT 1
             FROM jsonb_each(
                 CASE
                     WHEN jsonb_typeof(imported.destination_metadata -> 'postwave_source_projections') = 'object'
                         THEN imported.destination_metadata -> 'postwave_source_projections'
                     ELSE '{}'::jsonb
                 END
             ) projection(identity_key, body)
            WHERE projection.identity_key = ANY($4::text[])
              AND lower(COALESCE(projection.body #>> '{subscriber,source_platform}', '')) = $2
              AND projection.body #>> '{subscriber,source_id}' = ANY($3::text[])
       )
   )
 ORDER BY imported.created_at, imported.id
 LIMIT $5
 FOR UPDATE OF imported`,
		tenantID,
		provider,
		sourceIDs,
		uniqueCRMStrings(projectionKeys),
		maxMigrationLedgerCandidates+1,
	)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: locate durable migration source: %w", err)
	}
	ledgerSubscriberIDs := make([]string, 0)
	for ledgerRows.Next() {
		if len(ledgerSubscriberIDs) >= maxMigrationLedgerCandidates {
			ledgerRows.Close()
			return nil, fmt.Errorf(
				"%w: provider=%s contact=%s exceeds bounded migration lineage",
				ErrCRMContactIdentityAmbiguous,
				provider,
				providerContactID,
			)
		}
		var ledgerID, subscriberID string
		if err := ledgerRows.Scan(&ledgerID, &subscriberID); err != nil {
			ledgerRows.Close()
			return nil, fmt.Errorf("crm contact identity: scan durable migration source: %w", err)
		}
		subscriberID = strings.TrimSpace(subscriberID)
		if _, err := uuid.Parse(subscriberID); err != nil {
			ledgerRows.Close()
			return nil, fmt.Errorf(
				"%w: migration ledger %s has no valid Moosewave subscriber projection",
				ErrCRMContactIdentityAmbiguous,
				ledgerID,
			)
		}
		ledgerSubscriberIDs = append(ledgerSubscriberIDs, subscriberID)
	}
	if err := ledgerRows.Err(); err != nil {
		ledgerRows.Close()
		return nil, fmt.Errorf("crm contact identity: read durable migration source: %w", err)
	}
	ledgerRows.Close()
	ledgerSubscriberIDs = uniqueCRMStrings(ledgerSubscriberIDs)
	if len(ledgerSubscriberIDs) > 0 {
		var existingLedgerSubscribers int
		if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])`,
			tenantID,
			ledgerSubscriberIDs,
		).Scan(&existingLedgerSubscribers); err != nil {
			return nil, fmt.Errorf("crm contact identity: validate durable migration destination: %w", err)
		}
		if existingLedgerSubscribers != len(ledgerSubscriberIDs) {
			return nil, fmt.Errorf(
				"%w: provider=%s contact=%s durable migration destination is incomplete",
				ErrCRMContactIdentityAmbiguous,
				provider,
				providerContactID,
			)
		}
	}

	rows, err := tx.Query(ctx, `
WITH RECURSIVE matched(id, merged_into_subscriber_id) AS (
    SELECT id, merged_into_subscriber_id
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND lower(COALESCE(source_platform, '')) = $2
       AND source_id = ANY($3::text[])
    UNION
    SELECT id, merged_into_subscriber_id
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND id = ANY($4::uuid[])
),
lineage(seed_id, id, merged_into_subscriber_id, depth, path) AS (
    SELECT id, id, merged_into_subscriber_id, 0, ARRAY[id]::uuid[]
      FROM matched
    UNION ALL
    SELECT lineage.seed_id,
           parent.id,
           parent.merged_into_subscriber_id,
           lineage.depth + 1,
           lineage.path || parent.id
      FROM lineage
      JOIN subscribers parent
        ON parent.tenant_id = $1::uuid
       AND parent.id = lineage.merged_into_subscriber_id
     WHERE lineage.merged_into_subscriber_id IS NOT NULL
       AND lineage.depth < 32
       AND NOT parent.id = ANY(lineage.path)
),
resolved_roots AS (
    SELECT DISTINCT ON (seed_id)
           seed_id, id, merged_into_subscriber_id
      FROM lineage
     ORDER BY seed_id, depth DESC
),
distinct_roots AS (
    SELECT DISTINCT id, merged_into_subscriber_id
      FROM resolved_roots
     ORDER BY id, merged_into_subscriber_id
     LIMIT 2
)
SELECT subscriber.id::text,
       subscriber.email::text,
       distinct_roots.merged_into_subscriber_id IS NOT NULL
  FROM distinct_roots
  JOIN subscribers subscriber
    ON subscriber.tenant_id = $1::uuid
   AND subscriber.id = distinct_roots.id
 ORDER BY subscriber.id
 FOR UPDATE OF subscriber`, tenantID, provider, sourceIDs, ledgerSubscriberIDs)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: locate migration source: %w", err)
	}
	var candidates []migrationCandidate
	for rows.Next() {
		var candidate migrationCandidate
		if err := rows.Scan(&candidate.subscriberID, &candidate.email, &candidate.unresolved); err != nil {
			rows.Close()
			return nil, fmt.Errorf("crm contact identity: scan migration source: %w", err)
		}
		if candidate.unresolved {
			rows.Close()
			return nil, fmt.Errorf(
				"%w: provider=%s contact=%s subscriber merge lineage is cyclic, broken, or exceeds 32 hops",
				ErrCRMContactIdentityAmbiguous,
				provider,
				providerContactID,
			)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("crm contact identity: read migration source: %w", err)
	}
	rows.Close()
	if len(ledgerSubscriberIDs) > 0 && len(candidates) == 0 {
		return nil, fmt.Errorf(
			"%w: provider=%s contact=%s migration projection no longer resolves to a tenant subscriber",
			ErrCRMContactIdentityAmbiguous,
			provider,
			providerContactID,
		)
	}
	if len(candidates) > 1 {
		return nil, fmt.Errorf("%w: provider=%s contact=%s", ErrCRMContactIdentityAmbiguous, provider, providerContactID)
	}
	if len(candidates) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	// Historical migration provenance has no HubSpot portal/account dimension.
	// It is safe to adopt only when this tenant has one non-disconnected
	// HubSpot integration. With multiple candidate installs, the same numeric
	// contact ID can exist in different portals, so fail closed instead of
	// pretending the provider namespace disambiguates the account.
	var integrationCandidates int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM crm_integrations
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND status <> 'disconnected'`,
		tenantID, provider).Scan(&integrationCandidates); err != nil {
		return nil, fmt.Errorf("crm contact identity: count provider integrations: %w", err)
	}
	if integrationCandidates != 1 {
		return nil, fmt.Errorf(
			"%w: provider=%s contact=%s has no account-scoped migration provenance across %d integrations",
			ErrCRMContactIdentityAmbiguous,
			provider,
			providerContactID,
			integrationCandidates,
		)
	}

	candidate := candidates[0]
	_, err = tx.Exec(ctx, `
INSERT INTO crm_contact_profile_bindings (
    tenant_id, integration_id, provider, provider_contact_id,
    subscriber_id, state, binding_origin,
    last_email, state_metadata
)
VALUES (
    $1::uuid, $2::uuid, $3, $4,
    $5::uuid, 'active', 'migration_source',
    NULLIF($6, ''), '{"migration_source_bridge":true}'::jsonb
)
ON CONFLICT (tenant_id, integration_id, provider, provider_contact_id)
DO NOTHING`,
		tenantID, integrationID, provider, providerContactID,
		candidate.subscriberID, candidate.email)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: bind migration source: %w", err)
	}
	out, err := loadCRMContactProfileBinding(ctx, tx, tenantID, integrationID, provider, providerContactID)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("crm contact identity: migration binding disappeared")
	}
	out, err = refreshCRMContactProfileBinding(ctx, tx, out)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// BindCRMContactProfileBinding persists the profile selected by the subscriber
// identity graph. expectedProfileID makes re-binding compare-and-swap safe:
// callers may advance a known historical profile through merge lineage, but a
// first-time email lookup cannot steal a contact already claimed elsewhere.
func (r *Repo) BindCRMContactProfileBinding(
	ctx context.Context,
	tenantID, integrationID, provider, providerContactID,
	subscriberID, subscriberProfileID, email string,
	sourceRevisionAt time.Time,
	expectedProfileID string,
) (*CRMContactProfileBinding, error) {
	tenantID, integrationID, provider, providerContactID, err := normalizeCRMContactBindingKey(
		tenantID, integrationID, provider, providerContactID,
	)
	if err != nil {
		return nil, err
	}
	subscriberID = strings.TrimSpace(subscriberID)
	subscriberProfileID = strings.TrimSpace(subscriberProfileID)
	email = strings.ToLower(strings.TrimSpace(email))
	expectedProfileID = strings.TrimSpace(expectedProfileID)
	if sourceRevisionAt.IsZero() {
		sourceRevisionAt = time.Now().UTC()
	} else {
		sourceRevisionAt = sourceRevisionAt.UTC()
	}
	if subscriberID == "" || subscriberProfileID == "" {
		return nil, fmt.Errorf("crm contact identity: subscriber and profile ids are required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCRMContactBindingIntegration(ctx, tx, tenantID, integrationID, provider); err != nil {
		return nil, err
	}
	var subscriberMatches bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND id = $2::uuid
       AND profile_id = $3::uuid
)`, tenantID, subscriberID, subscriberProfileID).Scan(&subscriberMatches); err != nil {
		return nil, fmt.Errorf("crm contact identity: verify subscriber: %w", err)
	}
	if !subscriberMatches {
		return nil, fmt.Errorf("crm contact identity: subscriber/profile mismatch")
	}

	tag, err := tx.Exec(ctx, `
INSERT INTO crm_contact_profile_bindings (
    tenant_id, integration_id, provider, provider_contact_id,
    subscriber_id, state, binding_origin,
    last_email, source_revision_at, state_metadata, last_seen_at, inactive_at
)
VALUES (
    $1::uuid, $2::uuid, $3, $4,
    $5::uuid, 'active', 'native_email',
    NULLIF($6, ''), $7::timestamptz, '{}'::jsonb, now(), NULL
)
ON CONFLICT (tenant_id, integration_id, provider, provider_contact_id)
DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    state = 'active',
    binding_origin = CASE
        WHEN crm_contact_profile_bindings.binding_origin = 'migration_source'
            THEN crm_contact_profile_bindings.binding_origin
        ELSE EXCLUDED.binding_origin
    END,
    last_email = EXCLUDED.last_email,
    source_revision_at = CASE
        WHEN crm_contact_profile_bindings.source_revision_at IS NULL
            THEN EXCLUDED.source_revision_at
        ELSE GREATEST(
            crm_contact_profile_bindings.source_revision_at,
            EXCLUDED.source_revision_at
        )
    END,
    state_metadata = crm_contact_profile_bindings.state_metadata ||
        jsonb_build_object('reactivated_at', now()),
    last_seen_at = now(),
    inactive_at = NULL,
    updated_at = now()
WHERE (
    crm_contact_profile_bindings.subscriber_id = EXCLUDED.subscriber_id
    OR (
        NULLIF($8, '')::uuid IS NOT NULL
        AND EXISTS (
            SELECT 1
              FROM subscribers bound
             WHERE bound.tenant_id = $1::uuid
               AND bound.id = crm_contact_profile_bindings.subscriber_id
               AND bound.profile_id = NULLIF($8, '')::uuid
        )
    )
  )
  AND crm_contact_profile_bindings.state <> 'privacy_deleted'
  AND (
      crm_contact_profile_bindings.source_revision_at IS NULL
      OR EXCLUDED.source_revision_at >= crm_contact_profile_bindings.source_revision_at
  )
`,
		tenantID, integrationID, provider, providerContactID,
		subscriberID, email, sourceRevisionAt, expectedProfileID)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: bind profile: %w", err)
	}
	if tag.RowsAffected() == 0 {
		existing, loadErr := loadCRMContactProfileBinding(
			ctx,
			tx,
			tenantID,
			integrationID,
			provider,
			providerContactID,
		)
		if loadErr != nil {
			return nil, loadErr
		}
		if existing != nil && existing.State == "privacy_deleted" {
			return nil, ErrCRMContactPrivacyDeleted
		}
		if existing != nil &&
			existing.SourceRevisionAt != nil &&
			sourceRevisionAt.Before(*existing.SourceRevisionAt) {
			return nil, ErrCRMContactSourceRevisionStale
		}
		return nil, ErrCRMContactIdentityConflict
	}
	out, err := loadCRMContactProfileBinding(ctx, tx, tenantID, integrationID, provider, providerContactID)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("crm contact identity: bound profile disappeared")
	}
	out, err = refreshCRMContactProfileBinding(ctx, tx, out)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// TransitionCRMContactProfileBinding records source-side disappearance without
// mutating subscriber consent or lifecycle state. The durable binding is
// retained so a later recreation/property event can safely reactivate the same
// profile and so deletion processing remains auditable and idempotent.
func (r *Repo) TransitionCRMContactProfileBinding(
	ctx context.Context,
	tenantID, integrationID, provider, providerContactID, state string,
	metadata map[string]any,
) (*CRMContactProfileBinding, error) {
	state = strings.ToLower(strings.TrimSpace(state))
	switch state {
	case "no_email", "deleted", "privacy_deleted":
	default:
		return nil, fmt.Errorf("crm contact identity: invalid inactive state %q", state)
	}
	existing, err := r.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, provider, providerContactID,
	)
	if err != nil || existing == nil {
		return existing, err
	}
	eventOccurredAt := crmContactEventOccurredAt(metadata)
	if state == "privacy_deleted" {
		metadata = crmContactPrivacyTombstoneMetadata(metadata)
	}
	raw, _ := json.Marshal(metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE crm_contact_profile_bindings
   SET state = CASE
           WHEN state = 'privacy_deleted' OR $5 = 'privacy_deleted'
               THEN 'privacy_deleted'
           WHEN state = 'deleted' OR $5 = 'deleted'
               THEN 'deleted'
           ELSE 'no_email'
       END,
       state_metadata = CASE
           WHEN $5 = 'privacy_deleted' THEN jsonb_build_object(
               'privacy_deletion',
               COALESCE(state_metadata -> 'privacy_deletion', '{}'::jsonb) || $6::jsonb
           )
           WHEN state = 'privacy_deleted' THEN state_metadata
           WHEN $5 = 'deleted' THEN state_metadata || $6::jsonb ||
               jsonb_build_object('deletion', $6::jsonb)
           ELSE state_metadata || $6::jsonb ||
               jsonb_build_object('no_email', $6::jsonb)
       END,
       last_email = CASE
           WHEN state = 'privacy_deleted' OR $5 = 'privacy_deleted' THEN NULL
           ELSE last_email
       END,
       source_revision_at = CASE
           WHEN $7::timestamptz IS NULL THEN source_revision_at
           WHEN source_revision_at IS NULL THEN $7::timestamptz
           ELSE GREATEST(source_revision_at, $7::timestamptz)
       END,
       last_seen_at = now(),
       inactive_at = COALESCE(inactive_at, now()),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND provider_contact_id = $4
   AND (
       $5 = 'privacy_deleted'
       OR state <> 'active'
       OR source_revision_at IS NULL
       OR (
           $7::timestamptz IS NOT NULL
           AND $7::timestamptz >= source_revision_at
       )
   )
`,
		tenantID, integrationID, provider, providerContactID, state, string(raw), eventOccurredAt)
	if err != nil {
		return nil, fmt.Errorf("crm contact identity: transition binding: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}
	out, err := loadCRMContactProfileBinding(ctx, tx, tenantID, integrationID, provider, providerContactID)
	if err != nil {
		return nil, err
	}
	out, err = refreshCRMContactProfileBinding(ctx, tx, out)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func crmContactEventOccurredAt(metadata map[string]any) *time.Time {
	if len(metadata) == 0 {
		return nil
	}
	var milliseconds int64
	switch raw := metadata["hubspot_occurred_at"].(type) {
	case int64:
		milliseconds = raw
	case int:
		milliseconds = int64(raw)
	case float64:
		milliseconds = int64(raw)
	case json.Number:
		milliseconds, _ = raw.Int64()
	case string:
		if parsed, err := json.Number(strings.TrimSpace(raw)).Int64(); err == nil {
			milliseconds = parsed
		}
	}
	if milliseconds <= 0 {
		return nil
	}
	at := time.UnixMilli(milliseconds).UTC()
	return &at
}

func crmContactPrivacyTombstoneMetadata(metadata map[string]any) map[string]any {
	tombstone := make(map[string]any, 4)
	for _, key := range []string{
		"hubspot_event_id",
		"hubspot_subscription_type",
		"hubspot_property_name",
		"hubspot_occurred_at",
	} {
		if value, ok := metadata[key]; ok {
			tombstone[key] = value
		}
	}
	return tombstone
}
