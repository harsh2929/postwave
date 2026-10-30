package campaigns

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	// ErrAudienceMixedSources is returned before any population query when a
	// campaign names both a list and a segment. There is no documented union or
	// intersection contract, so choosing either source would make the preview
	// and the live send disagree about operator intent.
	ErrAudienceMixedSources = errors.New("campaign audience cannot contain both list_id and segment_id")
	// ErrAudienceListNotFound deliberately covers both an absent list mapping
	// and a mapping owned by another tenant. Callers must not distinguish the
	// two cases because doing so would leak cross-tenant list identity.
	ErrAudienceListNotFound = errors.New("campaign audience list not found for tenant")
	// ErrFrozenAudienceNotFound is returned for a static campaign whose frozen
	// snapshot is missing or belongs to another tenant. An empty, valid freeze
	// is not an error; it resolves to an empty recipient set.
	ErrFrozenAudienceNotFound = errors.New("campaign frozen audience not found for tenant")
)

type CampaignAudienceKind string

const (
	CampaignAudienceWorkspace CampaignAudienceKind = "workspace"
	CampaignAudienceList      CampaignAudienceKind = "list"
	CampaignAudienceSegment   CampaignAudienceKind = "segment"
)

// ResolvedCampaignAudience is the canonical activation-time audience used by
// queue-fill and send-preview. Emails have already passed the subscriber
// status and exact-address email-consent gates. They are still candidates:
// queue-level suppression/holdout/frequency policy applies next, and the send
// loop re-checks suppression plus purpose consent immediately before transport
// to close the queue-to-send race.
type ResolvedCampaignAudience struct {
	Kind   CampaignAudienceKind
	Emails []string
	Frozen bool
}

// ResolveCampaignAudience selects exactly one campaign audience source. A
// static freeze remains authoritative, while list and segment references are
// otherwise evaluated live. The no-list/no-segment branch intentionally keeps
// the legacy workspace-wide behavior; callers must not reach it merely because
// resolution of a named list failed.
func (r *Repo) ResolveCampaignAudience(
	ctx context.Context,
	tenantID string,
	c *Campaign,
) (ResolvedCampaignAudience, error) {
	if strings.TrimSpace(tenantID) == "" {
		return ResolvedCampaignAudience{}, errors.New("campaign audience tenant id required")
	}
	if c == nil {
		return ResolvedCampaignAudience{}, errors.New("campaign audience campaign required")
	}

	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)
	if listID != "" && segmentID != "" {
		return ResolvedCampaignAudience{}, ErrAudienceMixedSources
	}
	if r == nil || r.Pool == nil {
		return ResolvedCampaignAudience{}, errors.New("campaign audience repository unavailable")
	}

	kind := CampaignAudienceWorkspace
	if listID != "" {
		kind = CampaignAudienceList
	} else if segmentID != "" {
		kind = CampaignAudienceSegment
	}

	if strings.EqualFold(strings.TrimSpace(c.AudienceMode), "static") {
		freezeID := strings.TrimSpace(c.FrozenFreezeID)
		if freezeID == "" {
			return ResolvedCampaignAudience{}, ErrFrozenAudienceNotFound
		}
		emails, err := r.FrozenAudienceEmails(ctx, tenantID, freezeID)
		if err != nil {
			return ResolvedCampaignAudience{}, err
		}
		// Today static freezes are created from segment audiences. Preserve the
		// truthful preview label for older rows whose segment_id was later
		// cleared while retaining the frozen membership itself as authority.
		if kind == CampaignAudienceWorkspace {
			kind = CampaignAudienceSegment
		}
		return ResolvedCampaignAudience{Kind: kind, Emails: emails, Frozen: true}, nil
	}

	switch kind {
	case CampaignAudienceList:
		emails, err := r.ListAudienceEmails(ctx, tenantID, listID)
		return ResolvedCampaignAudience{Kind: kind, Emails: emails}, err
	case CampaignAudienceSegment:
		emails, err := r.AudienceEmails(ctx, tenantID, segmentID)
		return ResolvedCampaignAudience{Kind: kind, Emails: emails}, err
	default:
		emails, err := r.AudienceEmails(ctx, tenantID, "")
		return ResolvedCampaignAudience{Kind: kind, Emails: emails}, err
	}
}

// ListAudienceEmails resolves a campaign's persisted Listmonk bigint through
// the tenant-owned list_id_map, then intersects active membership with the
// exact activation predicate used by segment/workspace sends. A valid empty
// list returns an empty slice; a missing or foreign list returns the typed
// ErrAudienceListNotFound and can never degrade to workspace-wide delivery.
func (r *Repo) ListAudienceEmails(ctx context.Context, tenantID, listID string) ([]string, error) {
	tenantID = strings.TrimSpace(tenantID)
	listID = strings.TrimSpace(listID)
	if tenantID == "" {
		return nil, errors.New("list audience: tenant id required")
	}
	if listID == "" {
		return nil, ErrAudienceListNotFound
	}
	if r == nil || r.Pool == nil {
		return nil, errors.New("list audience: repository unavailable")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	whereSQL, args, err := listAudienceWhere(ctx, tx, tenantID, listID)
	if err != nil {
		return nil, err
	}
	query := `SELECT subscribers.email::text
  FROM subscribers
 WHERE ` + whereSQL + `
 ORDER BY subscribers.id`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list audience: enumerate members: %w", err)
	}
	defer rows.Close()

	out := make([]string, 0, 64)
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		out = append(out, email)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CountEligibleListAudience counts the members of a tenant-owned list who
// would receive a campaign sent to it now — the same population
// ListAudienceEmails enumerates, so the count the editor shows while the list
// is being picked is the count the send review and queue-fill arrive at. A
// missing or foreign list is ErrAudienceListNotFound, never a zero.
func (r *Repo) CountEligibleListAudience(ctx context.Context, tenantID, listID string) (int64, error) {
	tenantID = strings.TrimSpace(tenantID)
	listID = strings.TrimSpace(listID)
	if tenantID == "" {
		return 0, errors.New("list audience: tenant id required")
	}
	if listID == "" {
		return 0, ErrAudienceListNotFound
	}
	if r == nil || r.Pool == nil {
		return 0, errors.New("list audience: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	whereSQL, args, err := listAudienceWhere(ctx, tx, tenantID, listID)
	if err != nil {
		return 0, err
	}
	var n int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::bigint FROM subscribers WHERE `+whereSQL, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("list audience: count members: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// listAudienceWhere is the subscribers predicate for a list audience: the
// activation predicate every campaign send applies, narrowed to the list's
// active members. The list is resolved through the tenant's list_id_map first,
// so an unknown or foreign list fails before anything is counted.
func listAudienceWhere(ctx context.Context, tx pgx.Tx, tenantID, listID string) (string, []any, error) {
	listUUID, err := resolveOwnedCampaignListUUID(ctx, tx, tenantID, listID)
	if err != nil {
		return "", nil, err
	}
	whereSQL, args, err := buildAudienceWhere(ctx, tx, tenantID, "")
	if err != nil {
		return "", nil, err
	}
	args = append(args, listUUID)
	listPlaceholder := "$" + strconv.Itoa(len(args))
	return whereSQL + `
   AND EXISTS (
       SELECT 1
         FROM list_subscribers ls
        WHERE ls.tenant_id = $1::uuid
          AND ls.list_id = ` + listPlaceholder + `::uuid
          AND ls.subscriber_id = subscribers.id
          AND ls.removed_at IS NULL
   )`, args, nil
}

// resolveOwnedCampaignListUUID accepts the bigint shape persisted on
// campaigns.audience_list_id. A canonical UUID is also accepted for focused
// internal callers/tests, but both paths must resolve through list_id_map for
// the active tenant before membership is read.
func resolveOwnedCampaignListUUID(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, listID string,
) (string, error) {
	identity, err := resolveOwnedCampaignList(ctx, tx, tenantID, listID)
	if err != nil {
		return "", err
	}
	return identity.UUID, nil
}

// campaignListIdentity is one list as both stores know it: the Moosewave uuid
// that list_subscribers is keyed on, and the engine (Listmonk) id that
// campaigns.audience_list_id persists.
type campaignListIdentity struct {
	UUID     string
	EngineID int64
}

// StoredListID is the value campaigns.audience_list_id holds: the engine id,
// in its canonical base-10 spelling.
func (l campaignListIdentity) StoredListID() string {
	return strconv.FormatInt(l.EngineID, 10)
}

// resolveOwnedCampaignList maps either list identity a caller may hold — the
// engine id every first-party client carries, or the Moosewave uuid an API
// caller may have from the members endpoints — onto the pair, through the
// active tenant's list_id_map. A list absent from the map, or mapped for
// another tenant, is ErrAudienceListNotFound either way.
//
// Writers must store StoredListID(), never the raw input: audience_list_id is
// a bigint column, so persisting a uuid spelling is a cast failure, and
// persisting an unvalidated engine id would name a list this tenant does not
// own.
func resolveOwnedCampaignList(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, listID string,
) (campaignListIdentity, error) {
	var identity campaignListIdentity
	if bigintID, err := strconv.ParseInt(listID, 10, 64); err == nil && bigintID > 0 && strconv.FormatInt(bigintID, 10) == listID {
		err = tx.QueryRow(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND listmonk_bigint_id = $2`, tenantID, bigintID).Scan(&identity.UUID, &identity.EngineID)
		if errors.Is(err, pgx.ErrNoRows) {
			return campaignListIdentity{}, ErrAudienceListNotFound
		}
		if err != nil {
			return campaignListIdentity{}, fmt.Errorf("list audience: resolve bigint identity: %w", err)
		}
		return identity, nil
	}

	err := tx.QueryRow(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND postwave_uuid::text = lower($2)`, tenantID, listID).Scan(&identity.UUID, &identity.EngineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return campaignListIdentity{}, ErrAudienceListNotFound
	}
	if err != nil {
		return campaignListIdentity{}, fmt.Errorf("list audience: resolve uuid identity: %w", err)
	}
	return identity, nil
}
