// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	ProjectionStatusPending = "pending"
	ProjectionStatusReady   = "ready"
	ProjectionStatusFailed  = "failed"

	ProjectionErrorSecretUnavailable = "secret_unavailable"
	ProjectionErrorFailed            = "projection_failed"

	projectionTaskFull       = "full"
	projectionTaskSubscriber = "subscriber"

	DefaultProjectionPageSize    = 500
	DefaultProjectionClaimLimit  = 16
	DefaultProjectionMaxAttempts = 10
)

var (
	ErrEmailIdentityProjectionNotReady = errors.New("conversions: email identity projection is not ready")
	ErrProjectionLeaseLost             = errors.New("conversions: email identity projection lease lost")
	ErrProjectionSecretUnavailable     = errors.New("conversions: email identity projection secret unavailable")
	ErrProjectionConfiguration         = errors.New("conversions: email identity projection configuration invalid")
)

// ProjectionMetadata is safe to expose beside a key summary. It contains no
// subscriber cardinality, digest, address, or secret material.
type ProjectionMetadata struct {
	Status    string    `json:"identity_projection_status"`
	ErrorCode string    `json:"identity_projection_error_code,omitempty"`
	UpdatedAt time.Time `json:"identity_projection_updated_at"`
}

func validProjectionMetadata(metadata ProjectionMetadata) bool {
	if metadata.UpdatedAt.IsZero() {
		return false
	}
	switch metadata.Status {
	case ProjectionStatusPending, ProjectionStatusReady:
		return metadata.ErrorCode == ""
	case ProjectionStatusFailed:
		return metadata.ErrorCode == ProjectionErrorSecretUnavailable ||
			metadata.ErrorCode == ProjectionErrorFailed
	default:
		return false
	}
}

// EmailHMACProjectionClaim is the exact durable lease identity. Attempt,
// revision, and lease token are all checked by every mutating statement; a
// crashed worker or a subscriber mutation that supersedes the task cannot
// commit stale bindings.
type EmailHMACProjectionClaim struct {
	TenantID           string
	TaskID             string
	KeyID              string
	TaskKind           string
	SubscriberID       string
	CursorSubscriberID string
	TargetRevision     int64
	Attempt            int
	LeaseToken         string
	LeaseExpiresAt     time.Time
}

func (claim EmailHMACProjectionClaim) valid() bool {
	if strings.TrimSpace(claim.TenantID) == "" || strings.TrimSpace(claim.TaskID) == "" ||
		strings.TrimSpace(claim.KeyID) == "" || strings.TrimSpace(claim.LeaseToken) == "" ||
		claim.TargetRevision < 1 || claim.Attempt < 1 || claim.LeaseExpiresAt.IsZero() {
		return false
	}
	switch claim.TaskKind {
	case projectionTaskFull:
		return claim.SubscriberID == ""
	case projectionTaskSubscriber:
		return claim.SubscriberID != "" && claim.CursorSubscriberID == ""
	default:
		return false
	}
}

type ProjectionApplyResult struct {
	Processed int
	Complete  bool
}

type EmailHMACProjectionHealth struct {
	HasFailed bool
	HasStale  bool
}

// EmailHMACProjectionRepository owns the durable indexed projection. The API
// hot path only reads state/bindings; this repository is used by the dedicated
// worker process.
type EmailHMACProjectionRepository struct {
	Pool *db.Pool
}

func NewEmailHMACProjectionRepository(pool *db.Pool) (*EmailHMACProjectionRepository, error) {
	if pool == nil {
		return nil, ErrProjectionConfiguration
	}
	return &EmailHMACProjectionRepository{Pool: pool}, nil
}

// Ready proves migration 2017, forced RLS, the exact hot-path index, and the
// restricted cross-tenant claim function. A superuser/BYPASSRLS worker is
// rejected: tenant predicates must remain enforcement, not convention.
func (r *EmailHMACProjectionRepository) Ready(ctx context.Context) error {
	if r == nil || r.Pool == nil {
		return ErrProjectionConfiguration
	}
	var tablesReady, indexesReady, lifecycleIndexesReady, triggersReady bool
	var policiesReady, grantsReady, privileged, functionsReady, catalogReady bool
	err := r.Pool.QueryRow(ctx, `
SELECT
    (
        SELECT count(*) = 3 AND bool_and(c.relrowsecurity) AND bool_and(c.relforcerowsecurity)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = ANY($1::text[])
    ),
    (
		SELECT count(*) = 11
		       AND bool_and(index_catalog.indisvalid)
		       AND bool_and(index_catalog.indisready)
		       AND count(*) FILTER (
		           WHERE index_relation.relname = 'conversion_email_hmac_bindings_pkey'
		             AND index_catalog.indisunique
		             AND pg_catalog.pg_get_indexdef(index_relation.oid)
		                 LIKE '%(tenant_id, key_id, digest)%'
		       ) = 1
		       AND count(*) FILTER (
		           WHERE index_relation.relname = 'conversion_email_hmac_bindings_digest_lookup_idx'
		             AND index_catalog.indnkeyatts = 3 AND index_catalog.indnatts = 4
		             AND pg_catalog.pg_get_indexdef(index_relation.oid)
		                 LIKE '%(tenant_id, key_id, digest) INCLUDE (subscriber_id)%'
		       ) = 1
		       AND count(*) FILTER (
		           WHERE index_relation.relname IN (
		               'conversion_email_hmac_projection_subscriber_claim_due_idx',
		               'conversion_email_hmac_projection_full_claim_due_idx'
		           ) AND index_catalog.indexprs IS NOT NULL
		             AND index_catalog.indpred IS NOT NULL
		       ) = 2
		       AND count(*) FILTER (
		           WHERE index_relation.relname =
		                 'conversion_email_hmac_projection_tasks_tenant_key_idx'
		             AND index_catalog.indnkeyatts = 2 AND index_catalog.indnatts = 5
		             AND pg_catalog.pg_get_indexdef(index_relation.oid)
		                 LIKE '%(tenant_id, key_id) INCLUDE (state, last_failure_code, attempt_count)%'
		       ) = 1
		  FROM pg_catalog.pg_class index_relation
		  JOIN pg_catalog.pg_namespace namespace
		    ON namespace.oid = index_relation.relnamespace
		  JOIN pg_catalog.pg_index index_catalog
		    ON index_catalog.indexrelid = index_relation.oid
		 WHERE namespace.nspname = 'public'
		   AND index_relation.relname = ANY($2::text[])
    ),
    (
		SELECT count(*) = 3 AND bool_and(index_catalog.indisvalid)
		       AND bool_and(index_catalog.indisready)
		       AND bool_and(index_catalog.indpred IS NOT NULL)
		  FROM pg_catalog.pg_class index_relation
		  JOIN pg_catalog.pg_namespace namespace
		    ON namespace.oid = index_relation.relnamespace
		  JOIN pg_catalog.pg_index index_catalog
		    ON index_catalog.indexrelid = index_relation.oid
		 WHERE namespace.nspname = 'public'
		   AND index_relation.relname IN (
		       'conversion_ingest_secrets_live_tenant_idx',
		       'conversion_attribution_touches_email_hmac_key_idx',
		       'conversions_email_hmac_identity_idx'
		   )
	),
	(
		SELECT count(*) = 6 AND bool_and(trigger.tgenabled = 'O')
		  FROM pg_catalog.pg_trigger trigger
		  JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
		  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
		 WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
		   AND trigger.tgname = ANY($3::text[])
	),
	(
		SELECT count(*) = 8 AND bool_and(
		    CASE policyname
		    WHEN 'conversion_email_hmac_projection_states_tenant_select'
		        THEN tablename = 'conversion_email_hmac_projection_states'
		             AND cmd = 'SELECT' AND roles::text = '{postwave_app}'
		    WHEN 'conversion_email_hmac_projection_states_tenant_insert'
		        THEN tablename = 'conversion_email_hmac_projection_states'
		             AND cmd = 'INSERT' AND roles::text = '{postwave_app}'
		    WHEN 'conversion_email_hmac_projection_states_tenant_update'
		        THEN tablename = 'conversion_email_hmac_projection_states'
		             AND cmd = 'UPDATE' AND roles::text = '{postwave_app}'
		    WHEN 'conversion_email_hmac_projection_states_projector'
		        THEN tablename = 'conversion_email_hmac_projection_states'
		             AND cmd = 'SELECT'
		             AND roles::text = '{postwave_conversion_identity_projector}'
		    WHEN 'conversion_email_hmac_bindings_tenant'
		        THEN tablename = 'conversion_email_hmac_bindings'
		             AND cmd = 'ALL' AND roles::text = '{postwave_app}'
		    WHEN 'conversion_email_hmac_projection_tasks_tenant'
		        THEN tablename = 'conversion_email_hmac_projection_tasks'
		             AND cmd = 'ALL' AND roles::text = '{postwave_app}'
		    WHEN 'conversion_email_hmac_projection_tasks_projector'
		        THEN tablename = 'conversion_email_hmac_projection_tasks'
		             AND cmd = 'ALL'
		             AND roles::text = '{postwave_conversion_identity_projector}'
		    WHEN 'conversion_ingest_secrets_projection_catalog_projector'
		        THEN tablename = 'conversion_ingest_secrets'
		             AND cmd = 'SELECT'
		             AND roles::text = '{postwave_conversion_identity_projector}'
		    ELSE false END
		)
		  FROM pg_catalog.pg_policies
		 WHERE schemaname = 'public' AND policyname = ANY($4::text[])
	),
	(
		SELECT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_states', 'SELECT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_states', 'INSERT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_states', 'UPDATE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_states', 'DELETE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_states', 'TRUNCATE'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_bindings', 'SELECT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_bindings', 'INSERT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_bindings', 'UPDATE'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_bindings', 'DELETE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_bindings', 'TRUNCATE'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_tasks', 'SELECT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_tasks', 'INSERT'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_tasks', 'UPDATE'
		       ) AND pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_tasks', 'DELETE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_email_hmac_projection_tasks', 'TRUNCATE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'DELETE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'TRUNCATE'
		       ) AND pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'revoked_at', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'legacy_v1_until', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'secret', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'secret_envelope', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'secret_kms_key_arn', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'secret_destroyed_at', 'UPDATE'
		       ) AND NOT pg_catalog.has_column_privilege(
		           current_user, 'public.conversion_ingest_secrets', 'label', 'UPDATE'
		       ) AND pg_catalog.has_table_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_tasks', 'SELECT'
		       ) AND pg_catalog.has_table_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_tasks', 'UPDATE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_tasks', 'INSERT'
		       ) AND NOT pg_catalog.has_table_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_tasks', 'DELETE'
		       ) AND NOT pg_catalog.has_table_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_tasks', 'TRUNCATE'
		       ) AND pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'tenant_id', 'SELECT'
		       ) AND pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'key_id', 'SELECT'
		       ) AND pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'revoked_at', 'SELECT'
		       ) AND NOT pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'secret', 'SELECT'
		       ) AND NOT pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'secret_envelope', 'SELECT'
		       ) AND NOT pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'secret_kms_key_arn', 'SELECT'
		       ) AND NOT pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_ingest_secrets', 'secret_destroyed_at', 'SELECT'
		       ) AND pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_states', 'tenant_id', 'SELECT'
		       ) AND pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_states', 'key_id', 'SELECT'
		       ) AND NOT pg_catalog.has_column_privilege(
		           'postwave_conversion_identity_projector',
		           'public.conversion_email_hmac_projection_states', 'status', 'SELECT'
		       )
	),
	(
        SELECT current_setting('is_superuser') = 'on' OR role.rolbypassrls
          FROM pg_catalog.pg_roles role
         WHERE role.rolname = current_user
    ),
	(
		SELECT count(*) = 3 AND bool_and(procedure.prosecdef)
		       AND bool_and(owner.rolname = 'postwave_conversion_identity_projector')
		       AND bool_and(NOT owner.rolcanlogin AND NOT owner.rolsuper
		           AND NOT owner.rolcreatedb AND NOT owner.rolcreaterole
		           AND NOT owner.rolinherit AND NOT owner.rolreplication
		           AND NOT owner.rolbypassrls)
		       AND bool_and(procedure.proconfig @>
		           ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
		  FROM pg_catalog.pg_proc procedure
		  JOIN pg_catalog.pg_roles owner ON owner.oid = procedure.proowner
		 WHERE procedure.oid = ANY($5::regprocedure[])
	) AND NOT EXISTS (
		SELECT 1
		  FROM pg_catalog.pg_auth_members membership
		  JOIN pg_catalog.pg_roles projector
		    ON projector.rolname = 'postwave_conversion_identity_projector'
		 WHERE membership.member = projector.oid
		    OR membership.roleid = projector.oid
	) AND NOT pg_catalog.has_schema_privilege(
		'postwave_conversion_identity_projector', 'public', 'CREATE'
	) AND pg_catalog.has_function_privilege(
		current_user,
		'public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)',
		'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		current_user,
		'public.conversion_email_hmac_projection_catalog_consistent()',
		'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		current_user,
		'public.conversion_email_hmac_projection_health()',
		'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'postwave_public',
		'public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)',
		'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'postwave_public',
		'public.conversion_email_hmac_projection_catalog_consistent()',
		'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'postwave_public',
		'public.conversion_email_hmac_projection_health()',
		'EXECUTE'
	),
	public.conversion_email_hmac_projection_catalog_consistent()`, []string{
		"conversion_email_hmac_projection_states",
		"conversion_email_hmac_bindings",
		"conversion_email_hmac_projection_tasks",
	}, []string{
		"conversion_email_hmac_bindings_pkey",
		"conversion_email_hmac_bindings_subscriber_uniq",
		"conversion_email_hmac_bindings_digest_lookup_idx",
		"conversion_email_hmac_projection_tasks_pkey",
		"conversion_email_hmac_projection_full_task_uniq",
		"conversion_email_hmac_projection_subscriber_task_uniq",
		"conversion_email_hmac_projection_subscriber_claim_due_idx",
		"conversion_email_hmac_projection_full_claim_due_idx",
		"conversion_email_hmac_projection_tasks_tenant_key_idx",
		"conversion_email_hmac_projection_failed_health_idx",
		"conversion_email_hmac_projection_backlog_health_idx",
	}, []string{
		"conversion_ingest_secret_live_tenant_limit",
		"conversion_ingest_secret_require_envelope",
		"conversion_email_hmac_key_lifecycle",
		"conversion_email_hmac_subscriber_insert",
		"conversion_email_hmac_subscriber_email_update",
		"conversion_email_hmac_subscriber_delete",
	}, []string{
		"conversion_email_hmac_projection_states_tenant_select",
		"conversion_email_hmac_projection_states_tenant_insert",
		"conversion_email_hmac_projection_states_tenant_update",
		"conversion_email_hmac_projection_states_projector",
		"conversion_email_hmac_bindings_tenant",
		"conversion_email_hmac_projection_tasks_tenant",
		"conversion_email_hmac_projection_tasks_projector",
		"conversion_ingest_secrets_projection_catalog_projector",
	}, []string{
		"public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)",
		"public.conversion_email_hmac_projection_catalog_consistent()",
		"public.conversion_email_hmac_projection_health()",
	}).Scan(&tablesReady, &indexesReady, &lifecycleIndexesReady, &triggersReady,
		&policiesReady, &grantsReady, &privileged, &functionsReady, &catalogReady)
	if err != nil {
		return fmt.Errorf("%w: inspect migration 2017 catalog: %v",
			ErrProjectionConfiguration, err)
	}
	if !tablesReady || !indexesReady || !lifecycleIndexesReady ||
		!triggersReady || !policiesReady || !grantsReady || privileged ||
		!functionsReady || !catalogReady {
		return fmt.Errorf("%w: migration 2017 forced-RLS/index/claim contract is unavailable (tables=%t indexes=%t lifecycle_indexes=%t triggers=%t policies=%t grants=%t privileged=%t functions=%t catalog=%t)",
			ErrProjectionConfiguration, tablesReady, indexesReady, lifecycleIndexesReady,
			triggersReady, policiesReady, grantsReady, privileged, functionsReady,
			catalogReady)
	}
	return nil
}

func (r *EmailHMACProjectionRepository) Claim(
	ctx context.Context,
	workerID string,
	limit int,
	leaseTTL time.Duration,
) ([]EmailHMACProjectionClaim, error) {
	workerID = strings.TrimSpace(workerID)
	if r == nil || r.Pool == nil || workerID == "" || len(workerID) > 200 ||
		limit < 1 || limit > 100 || leaseTTL < 10*time.Second || leaseTTL > 30*time.Minute {
		return nil, ErrProjectionConfiguration
	}
	rows, err := r.Pool.Query(ctx, `
SELECT tenant_id::text, task_id::text, key_id, task_kind,
       COALESCE(subscriber_id::text, ''), COALESCE(cursor_subscriber_id::text, ''),
       target_revision, attempt_count, lease_token::text, lease_expires_at
  FROM public.claim_conversion_email_hmac_projection_tasks($1, $2, $3)`,
		workerID, limit, int(leaseTTL/time.Second))
	if err != nil {
		return nil, fmt.Errorf("conversions: claim email identity projection: %w", err)
	}
	defer rows.Close()
	claims := make([]EmailHMACProjectionClaim, 0, limit)
	for rows.Next() {
		var claim EmailHMACProjectionClaim
		if err := rows.Scan(&claim.TenantID, &claim.TaskID, &claim.KeyID,
			&claim.TaskKind, &claim.SubscriberID, &claim.CursorSubscriberID,
			&claim.TargetRevision, &claim.Attempt, &claim.LeaseToken,
			&claim.LeaseExpiresAt); err != nil {
			return nil, err
		}
		if !claim.valid() {
			return nil, fmt.Errorf("%w: claimed task has invalid provenance", ErrProjectionConfiguration)
		}
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return claims, nil
}

func (r *EmailHMACProjectionRepository) Health(
	ctx context.Context,
) (EmailHMACProjectionHealth, error) {
	if r == nil || r.Pool == nil {
		return EmailHMACProjectionHealth{}, ErrProjectionConfiguration
	}
	var health EmailHMACProjectionHealth
	if err := r.Pool.QueryRow(ctx, `
SELECT has_failed, has_stale
  FROM public.conversion_email_hmac_projection_health()`).Scan(
		&health.HasFailed, &health.HasStale,
	); err != nil {
		return EmailHMACProjectionHealth{}, fmt.Errorf(
			"conversions: inspect email identity projection health: %w", err,
		)
	}
	return health, nil
}

// ResolveSecret reads the exact live key named by the claim and decrypts its
// v2 envelope in memory. Plaintext is never written to a projection table or
// log. Historical plaintext and legacy-static envelopes deliberately fail
// closed because they cannot prove exact immutable KMS-key provenance.
func (r *EmailHMACProjectionRepository) ResolveSecret(
	ctx context.Context,
	claim EmailHMACProjectionClaim,
	cipher EnvelopeCipher,
) ([]byte, error) {
	if r == nil || r.Pool == nil || !claim.valid() {
		return nil, ErrProjectionConfiguration
	}
	tx, err := db.WithTenant(ctx, r.Pool, claim.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	var storedKMSKeyARN *string
	err = tx.QueryRow(ctx, `
SELECT secret.secret_envelope, secret.secret_kms_key_arn
  FROM conversion_email_hmac_projection_tasks task
  JOIN conversion_ingest_secrets secret
    ON secret.tenant_id = task.tenant_id AND secret.key_id = task.key_id
 WHERE task.tenant_id = $1::uuid AND task.id = $2::uuid
   AND task.key_id = $3 AND task.state = 'leased'
   AND task.target_revision = $4 AND task.attempt_count = $5
   AND task.lease_token = $6::uuid
   AND task.lease_expires_at > statement_timestamp()
	   AND secret.revoked_at IS NULL`, claim.TenantID, claim.TaskID, claim.KeyID,
		claim.TargetRevision, claim.Attempt, claim.LeaseToken).Scan(
		&envelope, &storedKMSKeyARN,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrProjectionLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Historical plaintext credentials may continue authenticating click- or
	// external-id-only requests during overlap, but they have no immutable KMS
	// provenance and can never seed the email-identity projection. Likewise, a
	// legacy-static envelope cannot be relabeled as exact-KMS material. The
	// projection query never reads the compatibility plaintext column.
	if len(envelope) == 0 || envelope[0] != pwcrypto.VersionEnvelope {
		return nil, ErrProjectionSecretUnavailable
	}
	provider, ok := cipher.(kmsKeyARNProvider)
	if cipher == nil || !ok || storedKMSKeyARN == nil ||
		strings.TrimSpace(*storedKMSKeyARN) == "" ||
		strings.TrimSpace(provider.KMSKeyARN()) != strings.TrimSpace(*storedKMSKeyARN) {
		return nil, ErrProjectionSecretUnavailable
	}
	secret, err := cipher.Decrypt(ctx, envelope, nil)
	if err != nil || len(secret) == 0 {
		zeroSecret(secret)
		return nil, ErrProjectionSecretUnavailable
	}
	return secret, nil
}

// Apply performs one bounded page. All binding writes, cursor advancement (or
// task completion), and public readiness refresh commit atomically.
func (r *EmailHMACProjectionRepository) Apply(
	ctx context.Context,
	claim EmailHMACProjectionClaim,
	secret []byte,
	pageSize int,
) (ProjectionApplyResult, error) {
	if r == nil || r.Pool == nil || !claim.valid() || len(secret) == 0 ||
		pageSize < 1 || pageSize > 1000 {
		return ProjectionApplyResult{}, ErrProjectionConfiguration
	}
	tx, err := db.WithTenant(ctx, r.Pool, claim.TenantID)
	if err != nil {
		return ProjectionApplyResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := lockProjectionClaim(ctx, tx, claim); err != nil {
		return ProjectionApplyResult{}, err
	}

	var subscriberIDs, emails []string
	switch claim.TaskKind {
	case projectionTaskFull:
		rows, err := tx.Query(ctx, `
SELECT id::text, lower(btrim(email::text))
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR id > $2::uuid)
 ORDER BY id
 LIMIT $3`, claim.TenantID, claim.CursorSubscriberID, pageSize)
		if err != nil {
			return ProjectionApplyResult{}, err
		}
		for rows.Next() {
			var subscriberID, email string
			if err := rows.Scan(&subscriberID, &email); err != nil {
				rows.Close()
				return ProjectionApplyResult{}, err
			}
			subscriberIDs = append(subscriberIDs, subscriberID)
			emails = append(emails, email)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return ProjectionApplyResult{}, err
		}
		rows.Close()
	case projectionTaskSubscriber:
		var email string
		err := tx.QueryRow(ctx, `
SELECT lower(btrim(email::text))
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			claim.TenantID, claim.SubscriberID).Scan(&email)
		if err == nil {
			subscriberIDs = append(subscriberIDs, claim.SubscriberID)
			emails = append(emails, email)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return ProjectionApplyResult{}, err
		}
	default:
		return ProjectionApplyResult{}, ErrProjectionConfiguration
	}

	if claim.TaskKind == projectionTaskSubscriber || len(subscriberIDs) > 0 {
		deleteIDs := subscriberIDs
		if claim.TaskKind == projectionTaskSubscriber && len(deleteIDs) == 0 {
			deleteIDs = []string{claim.SubscriberID}
		}
		if _, err := tx.Exec(ctx, `
DELETE FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2
   AND subscriber_id = ANY($3::uuid[])`, claim.TenantID, claim.KeyID, deleteIDs); err != nil {
			return ProjectionApplyResult{}, err
		}
	}
	if len(subscriberIDs) > 0 {
		digests := make([]string, len(emails))
		for index, email := range emails {
			digests[index] = emailIdentityHMACBytes(secret, email)
			if digests[index] == "" {
				return ProjectionApplyResult{}, errors.New("conversions: normalized subscriber address is empty")
			}
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO conversion_email_hmac_bindings (
    tenant_id, key_id, digest, subscriber_id
)
SELECT $1::uuid, $2, projected.digest, projected.subscriber_id::uuid
  FROM unnest($3::text[], $4::text[]) AS projected(digest, subscriber_id)
ON CONFLICT (tenant_id, key_id, digest) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    updated_at = statement_timestamp()`, claim.TenantID, claim.KeyID,
			digests, subscriberIDs); err != nil {
			return ProjectionApplyResult{}, err
		}
	}

	complete := claim.TaskKind == projectionTaskSubscriber || len(subscriberIDs) < pageSize
	if complete {
		if err := completeProjectionTask(ctx, tx, claim); err != nil {
			return ProjectionApplyResult{}, err
		}
	} else {
		lastSubscriberID := subscriberIDs[len(subscriberIDs)-1]
		tag, err := tx.Exec(ctx, `
UPDATE conversion_email_hmac_projection_tasks
   SET cursor_subscriber_id = $7::uuid, state = 'pending',
       lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       retry_not_before = NULL, last_failure_code = NULL,
       updated_at = statement_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND key_id = $3
   AND target_revision = $4 AND attempt_count = $5
   AND lease_token = $6::uuid AND state = 'leased'
   AND lease_expires_at > statement_timestamp()`, claim.TenantID, claim.TaskID,
			claim.KeyID, claim.TargetRevision, claim.Attempt, claim.LeaseToken,
			lastSubscriberID)
		if err != nil {
			return ProjectionApplyResult{}, err
		}
		if tag.RowsAffected() != 1 {
			return ProjectionApplyResult{}, ErrProjectionLeaseLost
		}
	}
	if err := refreshProjectionState(ctx, tx, claim.TenantID, claim.KeyID); err != nil {
		return ProjectionApplyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectionApplyResult{}, err
	}
	return ProjectionApplyResult{Processed: len(subscriberIDs), Complete: complete}, nil
}

func lockProjectionClaim(ctx context.Context, tx pgx.Tx, claim EmailHMACProjectionClaim) error {
	var present bool
	err := tx.QueryRow(ctx, `
SELECT true
  FROM conversion_email_hmac_projection_tasks task
  JOIN conversion_ingest_secrets secret
    ON secret.tenant_id = task.tenant_id AND secret.key_id = task.key_id
 WHERE task.tenant_id = $1::uuid AND task.id = $2::uuid AND task.key_id = $3
   AND task.task_kind = $4
   AND COALESCE(task.subscriber_id::text, '') = $5
   AND COALESCE(task.cursor_subscriber_id::text, '') = $6
   AND task.target_revision = $7 AND task.attempt_count = $8
   AND task.lease_token = $9::uuid AND task.state = 'leased'
   AND task.lease_expires_at > statement_timestamp()
   AND secret.revoked_at IS NULL
 FOR UPDATE OF task`, claim.TenantID, claim.TaskID, claim.KeyID, claim.TaskKind,
		claim.SubscriberID, claim.CursorSubscriberID, claim.TargetRevision,
		claim.Attempt, claim.LeaseToken).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrProjectionLeaseLost
	}
	if err != nil {
		return err
	}
	if !present {
		return ErrProjectionLeaseLost
	}
	return nil
}

func completeProjectionTask(
	ctx context.Context,
	tx pgx.Tx,
	claim EmailHMACProjectionClaim,
) error {
	tag, err := tx.Exec(ctx, `
DELETE FROM conversion_email_hmac_projection_tasks
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND key_id = $3
   AND target_revision = $4 AND attempt_count = $5
   AND lease_token = $6::uuid AND state = 'leased'
   AND lease_expires_at > statement_timestamp()`, claim.TenantID, claim.TaskID,
		claim.KeyID, claim.TargetRevision, claim.Attempt, claim.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrProjectionLeaseLost
	}
	return nil
}

func refreshProjectionState(ctx context.Context, tx pgx.Tx, tenantID, keyID string) error {
	// Acquire the state row in its own statement. Under READ COMMITTED, the
	// following UPDATE then receives a fresh snapshot after any enqueue that
	// made us wait; a single UPDATE could otherwise evaluate EXISTS against its
	// pre-wait snapshot and overwrite a newly committed pending state with ready.
	var locked bool
	err := tx.QueryRow(ctx, `
SELECT true
  FROM conversion_email_hmac_projection_states
 WHERE tenant_id = $1::uuid AND key_id = $2
 FOR UPDATE`, tenantID, keyID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrProjectionLeaseLost
	}
	if err != nil {
		return err
	}
	if !locked {
		return ErrProjectionLeaseLost
	}
	tag, err := tx.Exec(ctx, `
UPDATE conversion_email_hmac_projection_states projection
   SET status = CASE
           WHEN EXISTS (
               SELECT 1 FROM conversion_email_hmac_projection_tasks task
                WHERE task.tenant_id = projection.tenant_id
                  AND task.key_id = projection.key_id
                  AND task.last_failure_code IS NOT NULL
                  AND task.attempt_count >= $3
           ) THEN 'failed'
           WHEN EXISTS (
               SELECT 1 FROM conversion_email_hmac_projection_tasks task
                WHERE task.tenant_id = projection.tenant_id
                  AND task.key_id = projection.key_id
           ) THEN 'pending'
           ELSE 'ready'
       END,
       last_error_code = CASE
           WHEN EXISTS (
               SELECT 1 FROM conversion_email_hmac_projection_tasks task
                WHERE task.tenant_id = projection.tenant_id
                  AND task.key_id = projection.key_id
                  AND task.last_failure_code = 'secret_unavailable'
                  AND task.attempt_count >= $3
           ) THEN 'secret_unavailable'
           WHEN EXISTS (
               SELECT 1 FROM conversion_email_hmac_projection_tasks task
                WHERE task.tenant_id = projection.tenant_id
                  AND task.key_id = projection.key_id
                  AND task.last_failure_code IS NOT NULL
                  AND task.attempt_count >= $3
           ) THEN 'projection_failed'
           ELSE NULL
       END,
       last_ready_at = CASE
           WHEN NOT EXISTS (
               SELECT 1 FROM conversion_email_hmac_projection_tasks task
                WHERE task.tenant_id = projection.tenant_id
                  AND task.key_id = projection.key_id
           ) THEN statement_timestamp()
           ELSE projection.last_ready_at
       END,
       updated_at = statement_timestamp()
 WHERE projection.tenant_id = $1::uuid AND projection.key_id = $2`,
		tenantID, keyID, DefaultProjectionMaxAttempts)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrProjectionLeaseLost
	}
	return nil
}

func (r *EmailHMACProjectionRepository) RecordFailure(
	ctx context.Context,
	claim EmailHMACProjectionClaim,
	code string,
	retryAfter time.Duration,
) error {
	if r == nil || r.Pool == nil || !claim.valid() ||
		(code != ProjectionErrorSecretUnavailable && code != ProjectionErrorFailed) ||
		retryAfter < time.Second || retryAfter > 24*time.Hour {
		return ErrProjectionConfiguration
	}
	tx, err := db.WithTenant(ctx, r.Pool, claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE conversion_email_hmac_projection_tasks
   SET state = 'retry', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL,
       retry_not_before = statement_timestamp() + $7::interval,
       last_failure_code = $8, updated_at = statement_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND key_id = $3
   AND target_revision = $4 AND attempt_count = $5
   AND lease_token = $6::uuid AND state = 'leased'`, claim.TenantID,
		claim.TaskID, claim.KeyID, claim.TargetRevision, claim.Attempt,
		claim.LeaseToken, retryAfter.String(), code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrProjectionLeaseLost
	}
	if err := refreshProjectionState(ctx, tx, claim.TenantID, claim.KeyID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func zeroSecret(secret []byte) {
	for index := range secret {
		secret[index] = 0
	}
}
