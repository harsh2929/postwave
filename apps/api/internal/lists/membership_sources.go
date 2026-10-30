package lists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// ErrErasureBlocked means the address carries an erasure tombstone: its
// contact was deleted, or erased by a privacy request. List membership would
// have to create a subscriber for it, which only a compliance workflow may do.
var ErrErasureBlocked = errors.New("lists: address was permanently erased and can't be added")

type ListMembershipOwner struct {
	Source              string
	OwnerKey            string
	Provider            string
	IntegrationID       string
	ProviderSegmentType string
	ProviderSegmentID   string
	ProviderMemberID    string
	SourceRef           string
	Metadata            map[string]any
}

type CRMListMembershipScan struct {
	IntegrationID       string
	Provider            string
	ProviderSegmentType string
	ProviderSegmentID   string
	NativeListID        string
	Start               bool
	Complete            bool
}

// AddEmailToListOwned adds the address to the list under owner. A writer that
// collected the address itself (a CSV import, a CRM sync) may name one the
// tenant has no contact for yet: a fail-closed identity shell is created.
func (r *Repo) AddEmailToListOwned(ctx context.Context, tenantID, listUUID, email string, owner ListMembershipOwner) (string, error) {
	return r.addOwnedMembership(ctx, tenantID, listUUID, email, owner, mintIdentityShell)
}

func (r *Repo) addOwnedMembership(ctx context.Context, tenantID, listRef, email string, owner ListMembershipOwner, identity memberIdentityPolicy) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("lists: repo not configured")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "", fmt.Errorf("email is required")
	}
	owner = normalizeListMembershipOwner(owner)
	if owner.OwnerKey == "" {
		return "", fmt.Errorf("owner_key is required")
	}
	metadata, _ := json.Marshal(owner.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The list is verified in the writing transaction, not only by the
	// caller's earlier resolution. A list deleted since is no longer mapped,
	// and a deletion that starts now waits on this FOR KEY SHARE lock and then
	// removes what this write adds with the rest of the list (retire.go).
	list, err := ResolveListIdentityTx(ctx, tx, tenantID, listRef)
	if err != nil {
		return "", err
	}

	// Checked in this transaction, before the identity shell below can
	// resurrect a deleted or privacy-erased contact.
	erased, err := suppressions.ErasedAddresses(ctx, tx, tenantID, []string{email})
	if err != nil {
		return "", fmt.Errorf("check list-member erasure: %w", err)
	}
	if _, blocked := erased[email]; blocked {
		return "", ErrErasureBlocked
	}

	subscriberID, subscriberEmail, err := identity.resolve(ctx, tx, tenantID, email)
	if err != nil {
		return "", err
	}

	var (
		addedEvent SubscriberAddedMembership
		wasAdded   bool
	)
	err = tx.QueryRow(ctx, `
WITH prior_membership AS MATERIALIZED (
    SELECT removed_at
      FROM list_subscribers
     WHERE tenant_id = $1::uuid
       AND list_id = $2::uuid
       AND subscriber_id = $14::uuid
     FOR UPDATE
),
prior_state AS MATERIALIZED (
    SELECT count(*) > 0 AS existed,
           COALESCE(bool_or(removed_at IS NOT NULL), false) AS was_removed
      FROM prior_membership
),
sub AS (
    SELECT $14::uuid AS id, $3::citext AS email
      FROM prior_state
),
membership AS (
    INSERT INTO list_subscribers (
        tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, removed_at
    )
    SELECT $1::uuid, $2::uuid, sub.id, $4, sub.email, $5, NULL
      FROM sub
    ON CONFLICT (tenant_id, list_id, subscriber_id) DO UPDATE SET
        removed_at = NULL,
        added_at = CASE
            WHEN list_subscribers.removed_at IS NOT NULL THEN now()
            ELSE list_subscribers.added_at
        END,
        email = EXCLUDED.email,
        source = CASE
            WHEN list_subscribers.removed_at IS NOT NULL THEN EXCLUDED.source
            ELSE list_subscribers.source
        END,
        listmonk_list_id = COALESCE(EXCLUDED.listmonk_list_id, list_subscribers.listmonk_list_id)
    RETURNING subscriber_id::text, email::text, list_id::text, source, added_at
),
running_scan AS (
    SELECT id
      FROM crm_list_membership_scans
     WHERE tenant_id = $1::uuid
       AND integration_id = NULLIF($7, '')::uuid
       AND provider = $8
       AND provider_segment_type = $9
       AND provider_segment_id = $10
       AND native_list_id = $2::uuid
       AND status = 'running'
     LIMIT 1
),
owner_row AS (
    INSERT INTO list_subscriber_sources (
        tenant_id, list_id, subscriber_id, email, source, owner_key,
        provider, integration_id, provider_segment_type, provider_segment_id,
        provider_member_id, source_ref, first_seen_at, last_seen_at,
        removed_at, metadata
    )
    SELECT $1::uuid, $2::uuid, sub.id, sub.email, $5, $6, $8,
           NULLIF($7, '')::uuid, $9, $10, $11, $12, now(), now(),
           NULL, $13::jsonb
      FROM sub
    ON CONFLICT (tenant_id, list_id, subscriber_id, owner_key) DO UPDATE SET
        email = EXCLUDED.email,
        provider = EXCLUDED.provider,
        integration_id = EXCLUDED.integration_id,
        provider_segment_type = EXCLUDED.provider_segment_type,
        provider_segment_id = EXCLUDED.provider_segment_id,
        provider_member_id = CASE
            WHEN EXCLUDED.provider_member_id <> '' THEN EXCLUDED.provider_member_id
            ELSE list_subscriber_sources.provider_member_id
        END,
        source_ref = CASE
            WHEN EXCLUDED.source_ref <> '' THEN EXCLUDED.source_ref
            ELSE list_subscriber_sources.source_ref
        END,
        last_seen_at = now(),
        removed_at = NULL,
        metadata = CASE
            WHEN EXCLUDED.metadata <> '{}'::jsonb THEN EXCLUDED.metadata
            ELSE list_subscriber_sources.metadata
        END
    RETURNING subscriber_id::text
),
touch_scan AS (
    UPDATE crm_list_membership_scans
       SET members_seen = members_seen + 1,
           updated_at = now()
     WHERE id = (SELECT id FROM running_scan)
    RETURNING id
)
SELECT membership.subscriber_id,
       membership.email,
       membership.list_id,
       membership.source,
       membership.added_at,
       (NOT prior_state.existed OR prior_state.was_removed) AS was_added
  FROM owner_row
  JOIN membership ON membership.subscriber_id = owner_row.subscriber_id
  CROSS JOIN prior_state
  LEFT JOIN touch_scan ON true`,
		tenantID, list.UUID, subscriberEmail, list.EngineID, owner.Source, owner.OwnerKey,
		owner.IntegrationID, owner.Provider, owner.ProviderSegmentType,
		owner.ProviderSegmentID, owner.ProviderMemberID, owner.SourceRef,
		string(metadata), subscriberID).Scan(
		&addedEvent.SubscriberID,
		&addedEvent.Email,
		&addedEvent.ListID,
		&addedEvent.Source,
		&addedEvent.AddedAt,
		&wasAdded,
	)
	if err != nil {
		return "", fmt.Errorf("add owned email to list: %w", err)
	}
	subscriberID = addedEvent.SubscriberID
	if wasAdded {
		if err := r.fireListSubscriberAddedBatch(
			ctx, tx, tenantID, []SubscriberAddedMembership{addedEvent},
		); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return subscriberID, nil
}

func (r *Repo) RemoveEmailFromListOwned(ctx context.Context, tenantID, listUUID, email, ownerKey string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, fmt.Errorf("lists: repo not configured")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	ownerKey = strings.TrimSpace(ownerKey)
	if email == "" {
		return false, fmt.Errorf("email is required")
	}
	if ownerKey == "" {
		return false, fmt.Errorf("owner_key is required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ownerRemoved bool
	if err := tx.QueryRow(ctx, `
WITH target AS (
    SELECT lss.list_id, lss.subscriber_id
      FROM list_subscriber_sources lss
     WHERE lss.tenant_id = $1::uuid
       AND lss.list_id = $2::uuid
       AND lower(lss.email::text) = $3
       AND (
           lss.owner_key = $4
           OR ($4 LIKE 'source:%' AND lss.owner_key = 'legacy:' || substring($4 from 8))
       )
       AND lss.removed_at IS NULL
     FOR UPDATE
),
owner_update AS (
    UPDATE list_subscriber_sources lss
       SET removed_at = now()
      FROM target
     WHERE lss.tenant_id = $1::uuid
       AND lss.list_id = target.list_id
       AND lss.subscriber_id = target.subscriber_id
       AND (
           lss.owner_key = $4
           OR ($4 LIKE 'source:%' AND lss.owner_key = 'legacy:' || substring($4 from 8))
       )
     RETURNING target.list_id, target.subscriber_id
),
native_update AS (
    UPDATE list_subscribers ls
       SET removed_at = now()
      FROM owner_update ou
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = ou.list_id
       AND ls.subscriber_id = ou.subscriber_id
       AND ls.removed_at IS NULL
       AND NOT EXISTS (
           SELECT 1
             FROM list_subscriber_sources active
            WHERE active.tenant_id = ls.tenant_id
              AND active.list_id = ls.list_id
              AND active.subscriber_id = ls.subscriber_id
              AND active.removed_at IS NULL
              AND NOT (
                  active.owner_key = $4
                  OR (
                      $4 LIKE 'source:%'
                      AND active.owner_key = 'legacy:' || substring($4 from 8)
                  )
              )
       )
     RETURNING 1
)
SELECT EXISTS(SELECT 1 FROM owner_update)`, tenantID, listUUID, email, ownerKey).Scan(&ownerRemoved); err != nil {
		return false, fmt.Errorf("remove owned email from list: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return ownerRemoved, nil
}

// RemoveCRMContactMemberships detaches every list-membership owner attributable
// to one CRM integration/contact profile. It removes the visible membership
// only when no other active owner remains, so a HubSpot deletion or missing
// email cannot erase an operator-, form-, API-, migration-, or other
// integration-owned membership.
func (r *Repo) RemoveCRMContactMemberships(
	ctx context.Context,
	tenantID, integrationID, provider, subscriberID string,
) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, fmt.Errorf("lists: repo not configured")
	}
	integrationID = strings.TrimSpace(integrationID)
	provider = strings.ToLower(strings.TrimSpace(provider))
	subscriberID = strings.TrimSpace(subscriberID)
	if integrationID == "" || provider == "" || subscriberID == "" {
		return 0, fmt.Errorf("lists: CRM contact membership scope is incomplete")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ownersRemoved int
	err = tx.QueryRow(ctx, `
WITH stale AS (
    UPDATE list_subscriber_sources lss
       SET removed_at = COALESCE(removed_at, now())
     WHERE lss.tenant_id = $1::uuid
       AND lss.integration_id = $2::uuid
       AND lss.provider = $3
       AND lss.subscriber_id = $4::uuid
       AND lss.source = 'integration'
       AND lss.removed_at IS NULL
     RETURNING lss.list_id, lss.subscriber_id
),
targets AS (
    SELECT DISTINCT list_id, subscriber_id
      FROM stale
),
native_update AS (
    UPDATE list_subscribers ls
       SET removed_at = now()
      FROM targets
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = targets.list_id
       AND ls.subscriber_id = targets.subscriber_id
       AND ls.removed_at IS NULL
       AND NOT EXISTS (
           SELECT 1
             FROM list_subscriber_sources active
            WHERE active.tenant_id = ls.tenant_id
              AND active.list_id = ls.list_id
              AND active.subscriber_id = ls.subscriber_id
              AND active.removed_at IS NULL
       )
     RETURNING 1
)
SELECT COUNT(*) FROM stale`,
		tenantID, integrationID, provider, subscriberID).Scan(&ownersRemoved)
	if err != nil {
		return 0, fmt.Errorf("remove CRM contact memberships: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return ownersRemoved, nil
}

func (r *Repo) BeginCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMListMembershipScan) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	scan = normalizeCRMListMembershipScan(scan)
	if scan.IntegrationID == "" || scan.Provider == "" || scan.ProviderSegmentType == "" || scan.ProviderSegmentID == "" || scan.NativeListID == "" {
		return fmt.Errorf("lists: CRM list membership scan scope is incomplete")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO crm_list_membership_scans (
    tenant_id, integration_id, provider, provider_segment_type,
    provider_segment_id, native_list_id, status, started_at,
    completed_at, members_seen, members_repaired, updated_at
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'running', now(), NULL, 0, 0, now())
ON CONFLICT (
    tenant_id, integration_id, provider, provider_segment_type,
    provider_segment_id, native_list_id
)
DO UPDATE SET
    status = 'running',
    started_at = CASE
        WHEN $7 THEN now()
        WHEN crm_list_membership_scans.status IN ('completed', 'failed', 'abandoned') THEN now()
        ELSE crm_list_membership_scans.started_at
    END,
    completed_at = NULL,
    members_seen = CASE
        WHEN $7 OR crm_list_membership_scans.status IN ('completed', 'failed', 'abandoned') THEN 0
        ELSE crm_list_membership_scans.members_seen
    END,
    members_repaired = CASE
        WHEN $7 OR crm_list_membership_scans.status IN ('completed', 'failed', 'abandoned') THEN 0
        ELSE crm_list_membership_scans.members_repaired
    END,
    updated_at = now()`,
		tenantID, scan.IntegrationID, scan.Provider, scan.ProviderSegmentType,
		scan.ProviderSegmentID, scan.NativeListID, scan.Start)
	if err != nil {
		return fmt.Errorf("begin CRM list membership scan: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repo) CompleteCRMListMembershipScan(ctx context.Context, tenantID string, scan CRMListMembershipScan) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, fmt.Errorf("lists: repo not configured")
	}
	scan = normalizeCRMListMembershipScan(scan)
	if scan.IntegrationID == "" || scan.Provider == "" || scan.ProviderSegmentType == "" || scan.ProviderSegmentID == "" || scan.NativeListID == "" {
		return 0, fmt.Errorf("lists: CRM list membership scan scope is incomplete")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ownersRemoved, nativeRemoved int
	err = tx.QueryRow(ctx, `
WITH scan AS (
    SELECT id, started_at
      FROM crm_list_membership_scans
     WHERE tenant_id = $1::uuid
       AND integration_id = $2::uuid
       AND provider = $3
       AND provider_segment_type = $4
       AND provider_segment_id = $5
       AND native_list_id = $6::uuid
       AND status = 'running'
     FOR UPDATE
),
stale AS (
    UPDATE list_subscriber_sources lss
       SET removed_at = now()
      FROM scan
     WHERE lss.tenant_id = $1::uuid
       AND lss.integration_id = $2::uuid
       AND lss.provider = $3
       AND lss.provider_segment_type = $4
       AND lss.provider_segment_id = $5
       AND lss.source = 'integration'
       AND lss.removed_at IS NULL
       AND lss.last_seen_at < scan.started_at
     RETURNING lss.list_id, lss.subscriber_id
),
native_update AS (
    UPDATE list_subscribers ls
       SET removed_at = now()
      FROM stale
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = stale.list_id
       AND ls.subscriber_id = stale.subscriber_id
       AND ls.removed_at IS NULL
       AND NOT EXISTS (
           SELECT 1
             FROM list_subscriber_sources active
            WHERE active.tenant_id = ls.tenant_id
              AND active.list_id = ls.list_id
              AND active.subscriber_id = ls.subscriber_id
              AND active.removed_at IS NULL
       )
     RETURNING 1
),
complete AS (
    UPDATE crm_list_membership_scans
       SET status = 'completed',
           completed_at = now(),
           members_repaired = (SELECT COUNT(*) FROM stale),
           updated_at = now()
      FROM scan
     WHERE crm_list_membership_scans.id = scan.id
     RETURNING 1
)
SELECT (SELECT COUNT(*) FROM stale), (SELECT COUNT(*) FROM native_update)`,
		tenantID, scan.IntegrationID, scan.Provider, scan.ProviderSegmentType,
		scan.ProviderSegmentID, scan.NativeListID).Scan(&ownersRemoved, &nativeRemoved)
	if err != nil {
		return 0, fmt.Errorf("complete CRM list membership scan: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return nativeRemoved, nil
}

func normalizeListMembershipOwner(owner ListMembershipOwner) ListMembershipOwner {
	owner.Source = strings.ToLower(strings.TrimSpace(owner.Source))
	if owner.Source == "" {
		owner.Source = "integration"
	}
	owner.Source = normalizeListImportSource(owner.Source)
	owner.OwnerKey = strings.TrimSpace(owner.OwnerKey)
	owner.Provider = strings.TrimSpace(owner.Provider)
	owner.IntegrationID = strings.TrimSpace(owner.IntegrationID)
	owner.ProviderSegmentType = strings.TrimSpace(owner.ProviderSegmentType)
	owner.ProviderSegmentID = strings.TrimSpace(owner.ProviderSegmentID)
	owner.ProviderMemberID = strings.TrimSpace(owner.ProviderMemberID)
	owner.SourceRef = strings.TrimSpace(owner.SourceRef)
	if owner.Metadata == nil {
		owner.Metadata = map[string]any{}
	}
	return owner
}

func normalizeCRMListMembershipScan(scan CRMListMembershipScan) CRMListMembershipScan {
	scan.IntegrationID = strings.TrimSpace(scan.IntegrationID)
	scan.Provider = strings.TrimSpace(scan.Provider)
	scan.ProviderSegmentType = strings.TrimSpace(scan.ProviderSegmentType)
	scan.ProviderSegmentID = strings.TrimSpace(scan.ProviderSegmentID)
	scan.NativeListID = strings.TrimSpace(scan.NativeListID)
	return scan
}
