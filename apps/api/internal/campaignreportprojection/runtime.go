// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const RuntimeFeatureEnvironmentKey = "POSTWAVE_ENABLE_CAMPAIGN_REPORT_PROJECTION"

var (
	ErrRuntimeDisabled = errors.New("campaign report projection: runtime disabled")
	ErrRuntimeNotReady = errors.New("campaign report projection: runtime not ready")
)

// RuntimeConfiguration is deliberately one default-closed switch. Migration
// 1959/1964 are additive, but merely applying them must never begin mutating the
// legacy report read model. Enabling the writer is an explicit, separately
// deployable dual-run decision.
type RuntimeConfiguration struct {
	Enabled bool
}

func RuntimeConfigurationFromEnvironment(getenv func(string) string) (RuntimeConfiguration, error) {
	if getenv == nil {
		return RuntimeConfiguration{}, fmt.Errorf("%w: environment reader is required", ErrInvalidInput)
	}
	enabled, err := parseRuntimeFlag(getenv(RuntimeFeatureEnvironmentKey))
	if err != nil {
		return RuntimeConfiguration{}, err
	}
	return RuntimeConfiguration{Enabled: enabled}, nil
}

func parseRuntimeFlag(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "0", "false", "off", "no":
		return false, nil
	case "1", "true", "on", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("%w: %s must be true or false", ErrInvalidInput, RuntimeFeatureEnvironmentKey)
	}
}

// CanonicalEvent is the writer-owned handoff. EventType and CampaignID let the
// runtime independently enforce the intentionally narrow projection vocabulary
// before the SECURITY DEFINER database function re-reads and proves the row.
// They are routing facts, never trusted report data.
type CanonicalEvent struct {
	EventRef
	EventType  string
	CampaignID string
}

// Runtime is the transactional writer adapter. It has no background worker and
// owns no read-model queries; reconciliation remains an explicit Repo workflow.
type Runtime struct {
	enabled bool
	repo    *Repo
}

// BuildRuntime fails startup closed when an operator enables composition
// without the 1959 projection protocol, the 1964 governed privacy/identity
// mutation protocol, or their restricted app-role grants. The disabled path
// deliberately touches neither Postgres nor feature prerequisites.
func BuildRuntime(
	ctx context.Context,
	configuration RuntimeConfiguration,
	pool *db.Pool,
) (*Runtime, error) {
	if !configuration.Enabled {
		return &Runtime{}, nil
	}
	if pool == nil {
		return nil, fmt.Errorf("%w: database pool is required", ErrRuntimeNotReady)
	}
	var coreReady, mutationReady, executeGranted, evidenceReadable bool
	var directMutationRevoked, mutationDMLRevoked, internalExecuteRevoked bool
	var rlsReady bool
	err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL
       AND to_regclass('public.campaign_report_event_projection_identities') IS NOT NULL
       AND to_regclass('public.campaign_report_projection_runs') IS NOT NULL
       AND to_regprocedure(
           'public.append_campaign_report_event_projection(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)'
       ) IS NOT NULL,
       to_regclass('public.campaign_report_projection_mutation_requests') IS NOT NULL
       AND to_regclass('public.campaign_report_projection_mutation_receipts') IS NOT NULL
       AND to_regclass('public.campaign_report_event_projection_heads') IS NOT NULL
       AND to_regclass('public.campaign_report_projection_mutation_authorizations') IS NOT NULL
       AND to_regprocedure(
           'public.campaign_report_projection_repoint_subscriber_events(uuid,citext[],citext,text,uuid)'
       ) IS NOT NULL
       AND to_regprocedure(
           'public.campaign_report_projection_privacy_erase_subscriber_events(uuid,citext[],citext,uuid)'
       ) IS NOT NULL
       AND to_regprocedure(
           'public.campaign_report_projection_rollback_delete(uuid,bigint,uuid,uuid)'
       ) IS NOT NULL,
       COALESCE(has_function_privilege(
           current_user,
           to_regprocedure(
               'public.append_campaign_report_event_projection(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)'
           ),
           'EXECUTE'
       ), false)
       AND COALESCE(has_function_privilege(
           current_user,
           to_regprocedure(
               'public.campaign_report_projection_repoint_subscriber_events(uuid,citext[],citext,text,uuid)'
           ),
           'EXECUTE'
       ), false)
       AND COALESCE(has_function_privilege(
           current_user,
           to_regprocedure(
               'public.campaign_report_projection_privacy_erase_subscriber_events(uuid,citext[],citext,uuid)'
           ),
           'EXECUTE'
       ), false)
       AND COALESCE(has_function_privilege(
           current_user,
           to_regprocedure(
               'public.campaign_report_projection_rollback_delete(uuid,bigint,uuid,uuid)'
           ),
           'EXECUTE'
       ), false),
       COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_event_projections'), 'SELECT'
       ), false)
       AND COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_event_projection_identities'), 'SELECT'
       ), false)
       AND COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_projection_runs'), 'SELECT'
       ), false)
       AND COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_projection_mutation_requests'), 'SELECT'
       ), false)
       AND COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_projection_mutation_receipts'), 'SELECT'
       ), false)
       AND COALESCE(has_table_privilege(
           current_user, to_regclass('public.campaign_report_event_projection_heads'), 'SELECT'
       ), false),
       NOT has_column_privilege(current_user, 'public.subscriber_events', 'subscriber_email', 'UPDATE')
       AND NOT has_column_privilege(current_user, 'public.subscriber_events', 'user_agent', 'UPDATE')
       AND NOT has_column_privilege(current_user, 'public.subscriber_events', 'ip', 'UPDATE'),
       NOT EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                 'campaign_report_projection_mutation_requests',
                 'campaign_report_projection_mutation_receipts',
                 'campaign_report_event_projection_heads',
                 'campaign_report_projection_mutation_authorizations'
             ]::text[]) AS required(relname)
            WHERE to_regclass('public.' || required.relname) IS NULL
               OR COALESCE(has_table_privilege(
                   current_user,
                   to_regclass('public.' || required.relname),
                   'INSERT,UPDATE,DELETE,TRUNCATE'
               ), false)
               OR (
                   required.relname = 'campaign_report_projection_mutation_authorizations'
                   AND COALESCE(has_table_privilege(
                       current_user,
                       to_regclass('public.' || required.relname),
                       'SELECT'
                   ), false)
               )
       ),
       NOT EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                 'public.campaign_report_projection_source_fingerprint(subscriber_events)',
                 'public.campaign_report_projection_report_fingerprint(campaign_report_events)',
                 'public.campaign_report_projection_state_fingerprint(text,text,text)',
                 'public.campaign_report_projection_mutation_evidence_guard()',
                 'public.campaign_report_projection_head_guard()',
                 'public.campaign_report_projected_row_immutable_guard()',
                 'public.campaign_report_projection_ensure_head(uuid,bigint,timestamp with time zone)',
                 'public.campaign_report_projection_create_head()',
                 'public.campaign_report_projection_apply_identity_mutation(uuid,bigint,timestamp with time zone,citext,boolean,text,uuid)',
                 'public.campaign_report_projection_mutate_subscriber_events(uuid,citext[],citext,boolean,text,text,uuid)',
                 'public.campaign_report_projection_append_only_guard()',
                 'public.campaign_report_projection_run_guard()',
                 'public.append_campaign_report_event_projection_immutable_v1(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)'
             ]::text[]) AS required(signature)
            WHERE to_regprocedure(required.signature) IS NULL
               OR COALESCE(has_function_privilege(
                   current_user, to_regprocedure(required.signature), 'EXECUTE'
               ), false)
       ),
       NOT EXISTS (
           SELECT 1
             FROM unnest(ARRAY[
                 'campaign_report_event_projection_identities',
                 'campaign_report_event_projections',
                 'campaign_report_projection_runs',
                 'campaign_report_projection_mutation_requests',
                 'campaign_report_projection_mutation_receipts',
                 'campaign_report_event_projection_heads',
                 'campaign_report_projection_mutation_authorizations'
             ]::text[]) AS required(relname)
             LEFT JOIN pg_class AS relation
               ON relation.oid = to_regclass('public.' || required.relname)
            WHERE relation.oid IS NULL
               OR NOT relation.relrowsecurity
               OR NOT relation.relforcerowsecurity
       )`).
		Scan(&coreReady, &mutationReady, &executeGranted, &evidenceReadable,
			&directMutationRevoked, &mutationDMLRevoked,
			&internalExecuteRevoked, &rlsReady)
	if err != nil {
		return nil, fmt.Errorf("%w: inspect projection and mutation readiness: %v", ErrRuntimeNotReady, err)
	}
	if !coreReady || !mutationReady || !executeGranted || !evidenceReadable ||
		!directMutationRevoked || !mutationDMLRevoked ||
		!internalExecuteRevoked || !rlsReady {
		return nil, fmt.Errorf(
			"%w: migrations 1959/1964 or postwave_app projection boundaries are incomplete "+
				"(core=%t mutation=%t execute=%t evidence_read=%t direct_mutation_revoked=%t "+
				"mutation_dml_revoked=%t internal_execute_revoked=%t rls=%t)",
			ErrRuntimeNotReady, coreReady, mutationReady, executeGranted,
			evidenceReadable, directMutationRevoked, mutationDMLRevoked,
			internalExecuteRevoked, rlsReady,
		)
	}
	return &Runtime{enabled: true, repo: &Repo{Pool: pool}}, nil
}

func (runtime *Runtime) Enabled() bool {
	return runtime != nil && runtime.enabled
}

// ProjectCanonicalEvent attaches the legacy report row and immutable lineage
// to a canonical event inside the caller's transaction. Ineligible domain,
// synthetic, and campaign-less events are explicit no-ops; malformed eligible
// input and every database disagreement fail the whole caller transaction.
func (runtime *Runtime) ProjectCanonicalEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	event CanonicalEvent,
) error {
	if runtime == nil || !runtime.enabled {
		return ErrRuntimeDisabled
	}
	if runtime.repo == nil {
		return ErrRuntimeNotReady
	}
	if !EligibleCanonicalEventType(event.EventType) || strings.TrimSpace(event.CampaignID) == "" {
		return nil
	}
	if _, err := uuid.Parse(strings.TrimSpace(event.CampaignID)); err != nil {
		return fmt.Errorf("%w: invalid campaign id", ErrInvalidInput)
	}
	_, err := runtime.repo.AppendInTx(
		ctx, tx, tenantID, event.EventRef, ProjectionVersionV1, "", "", 0,
	)
	if err != nil {
		return fmt.Errorf("project canonical campaign report event: %w", err)
	}
	return nil
}

// EligibleCanonicalEventType is the one production-writer vocabulary. sent
// and conversion remain report-only until the canonical ledger gains them;
// custom, lifecycle, identified, and sandbox events are never coerced.
func EligibleCanonicalEventType(eventType string) bool {
	switch strings.ToLower(strings.TrimSpace(eventType)) {
	case "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "replied":
		return true
	default:
		return false
	}
}
