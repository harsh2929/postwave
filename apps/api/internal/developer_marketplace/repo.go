package developer_marketplace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type rowScanner interface {
	Scan(dest ...any) error
}

// ListApps returns apps newest-first with keyset pagination on
// (updated_at, id). updated_at is mutable, so a row edited between page
// fetches can shift pages; acceptable for this admin list. limit is the
// page size; a non-empty next cursor is returned when more rows remain.
// publicDistributionsSQL is the set of distribution values that are publicly
// readable cross-tenant when approved/active. It MUST stay in sync with the
// developer_apps public index + both public-read RLS predicates (migration
// 1624) and the distribution CHECK constraint. Hoisted into one place because
// the query layer once drifted behind the row-security layer: migration 1624
// widened the index/RLS/CHECK to admit native_postwave + catalog_only, but the
// browse/detail WHERE clauses still hardcoded the narrow set, so those
// listings inserted cleanly yet never appeared in public browse (RLS can only
// further-restrict, never re-admit rows the query's own WHERE excluded).
const publicDistributionsSQL = `('marketplace','partner_catalog','native_postwave','catalog_only')`

func (r *Repo) ListApps(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]App, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at
FROM developer_apps
WHERE ($2 = '' OR status = $2)
  AND (
    tenant_id = $1::uuid
    OR (distribution IN `+publicDistributionsSQL+` AND status IN ('approved','active'))
  )
  `+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []App{}
	for rows.Next() {
		item, err := scanApp(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateApp(ctx context.Context, tenantID string, in App) (*App, error) {
	normalizePartnerEditableApp(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO developer_apps
    (tenant_id, name, slug, app_type, distribution, status, owner_email,
     support_email, homepage_url, privacy_url, terms_url, description, scopes,
     redirect_uris, api_revisions, webhook_topics, test_mode, metadata, review_notes)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6, NULLIF($7,'')::citext,
     NULLIF($8,'')::citext, $9, $10, $11, $12, $13::text[],
     $14::text[], $15::text[], $16::text[], $17, $18::jsonb, $19)
RETURNING id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at`,
		tenantID, in.Name, in.Slug, in.AppType, in.Distribution, in.Status,
		in.OwnerEmail, in.SupportEmail, in.HomepageURL, in.PrivacyURL,
		in.TermsURL, in.Description, in.Scopes, in.RedirectURIs,
		in.APIRevisions, in.WebhookTopics, in.TestMode, string(meta), in.ReviewNotes)
	out, err := scanApp(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, out.ID, "developer_app.created", map[string]any{"slug": out.Slug})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetApp(ctx context.Context, tenantID, id string) (*App, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getAppTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetAppMonitoring(ctx context.Context, tenantID, appID string) (*AppMonitoringReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	app, err := getOwnedAppTx(ctx, tx, tenantID, appID)
	if err != nil {
		return nil, err
	}
	listing, err := getListingForAppTx(ctx, tx, tenantID, app.ID)
	if err != nil {
		return nil, err
	}
	counts, err := getAppMonitoringCountsTx(ctx, tx, tenantID, app.ID)
	if err != nil {
		return nil, err
	}
	out := BuildAppMonitoringReport(*app, listing, *counts, time.Now().UTC())
	return &out, tx.Commit(ctx)
}

func (r *Repo) UpdateApp(ctx context.Context, tenantID, id string, in App) (*App, error) {
	normalizePartnerEditableApp(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE developer_apps
SET name = $3, slug = $4, app_type = $5, distribution = $6,
    status = $7, owner_email = NULLIF($8,'')::citext,
    support_email = NULLIF($9,'')::citext, homepage_url = $10,
    privacy_url = $11, terms_url = $12, description = $13, scopes = $14::text[],
    redirect_uris = $15::text[], api_revisions = $16::text[],
    webhook_topics = $17::text[], test_mode = $18, metadata = $19::jsonb,
    review_notes = $20, submitted_at = NULL, approved_at = NULL, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at`,
		tenantID, id, in.Name, in.Slug, in.AppType, in.Distribution, in.Status,
		in.OwnerEmail, in.SupportEmail, in.HomepageURL, in.PrivacyURL,
		in.TermsURL, in.Description, in.Scopes, in.RedirectURIs,
		in.APIRevisions, in.WebhookTopics, in.TestMode, string(meta), in.ReviewNotes)
	out, err := scanApp(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, out.ID, "developer_app.updated", map[string]any{"status": out.Status})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) SubmitAppReview(ctx context.Context, tenantID, id string) (*App, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE developer_apps
SET status = 'submitted', submitted_at = COALESCE(submitted_at, now()), updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at`, tenantID, id)
	out, err := scanApp(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, out.ID, "developer_app.submitted", nil)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ReviewAppDecision(ctx context.Context, tenantID, id string, in ReviewDecisionInput) (*App, error) {
	in = normalizeReviewDecision(in)
	status := "approved"
	action := "developer_app.review_approved"
	if in.Decision == "reject" {
		status = "rejected"
		action = "developer_app.review_rejected"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE developer_apps
SET status = $3,
    review_notes = $4,
    approved_at = CASE WHEN $3 = 'approved' THEN COALESCE(approved_at, now()) ELSE NULL END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at`, tenantID, id, status, in.Notes)
	out, err := scanApp(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, out.ID, action, map[string]any{
		"decision": in.Decision,
		"notes":    in.Notes,
		"status":   out.Status,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListReviewQueue(ctx context.Context, filter ReviewQueueFilter) (*ReviewQueueResponse, error) {
	normalized, err := normalizeReviewQueueFilter(filter)
	if err != nil {
		return nil, err
	}
	tx, err := withReviewQueueScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH review_queue AS (
  SELECT
      'app'::text AS kind,
      a.tenant_id::text AS tenant_id,
      a.id::text AS app_id,
      ''::text AS listing_id,
      ''::text AS profile_id,
      a.slug::text AS slug,
      a.name AS name,
      a.app_type AS app_type,
      a.distribution AS distribution,
      a.status AS app_status,
      ''::text AS listing_status,
      ''::text AS review_state,
      ''::text AS category,
      ''::text AS profile_type,
      ''::text AS profile_status,
      COALESCE(a.support_email::text, '') AS support_email,
      a.privacy_url AS privacy_url,
      ''::text AS docs_url,
      ''::text AS support_url,
      ''::text AS partner_level,
      ''::text AS listing_url,
      ''::text AS contact_email,
      a.submitted_at AS submitted_at,
      a.created_at AS created_at,
      a.updated_at AS updated_at
    FROM developer_apps a
   WHERE a.distribution IN ('marketplace','partner_catalog')
     AND (
       ($2 = 'pending' AND a.status IN ('submitted','in_review'))
       OR ($2 = 'resolved' AND a.status IN ('approved','active','rejected','suspended'))
       OR ($2 = 'all' AND a.status IN ('submitted','in_review','approved','active','rejected','suspended'))
     )
  UNION ALL
  SELECT
      'listing'::text AS kind,
      l.tenant_id::text AS tenant_id,
      l.app_id::text AS app_id,
      l.id::text AS listing_id,
      ''::text AS profile_id,
      l.slug::text AS slug,
      l.name AS name,
      a.app_type AS app_type,
      a.distribution AS distribution,
      a.status AS app_status,
      l.status AS listing_status,
      l.review_state AS review_state,
      l.category AS category,
      ''::text AS profile_type,
      ''::text AS profile_status,
      COALESCE(a.support_email::text, '') AS support_email,
      a.privacy_url AS privacy_url,
      l.docs_url AS docs_url,
      l.support_url AS support_url,
      l.partner_level AS partner_level,
      ''::text AS listing_url,
      ''::text AS contact_email,
      NULL::timestamptz AS submitted_at,
      l.created_at AS created_at,
      l.updated_at AS updated_at
    FROM app_listings l
    JOIN developer_apps a ON a.id = l.app_id
   WHERE a.distribution IN ('marketplace','partner_catalog')
     AND (
       ($2 = 'pending' AND l.review_state = 'submitted')
       OR ($2 = 'resolved' AND l.review_state IN ('approved','rejected'))
       OR ($2 = 'all' AND l.review_state IN ('submitted','approved','rejected'))
     )
  UNION ALL
  SELECT
      'partner_profile'::text AS kind,
      p.tenant_id::text AS tenant_id,
      ''::text AS app_id,
      ''::text AS listing_id,
      p.id::text AS profile_id,
      p.id::text AS slug,
      p.organization_name AS name,
      ''::text AS app_type,
      'partner_program'::text AS distribution,
      ''::text AS app_status,
      ''::text AS listing_status,
      ''::text AS review_state,
      ''::text AS category,
      p.profile_type AS profile_type,
      p.status AS profile_status,
      ''::text AS support_email,
      ''::text AS privacy_url,
      ''::text AS docs_url,
      ''::text AS support_url,
      p.certification_level AS partner_level,
      p.listing_url AS listing_url,
      COALESCE(p.contact_email::text, '') AS contact_email,
      NULL::timestamptz AS submitted_at,
      p.created_at AS created_at,
      p.updated_at AS updated_at
    FROM partner_program_profiles p
   WHERE (
       ($2 = 'pending' AND p.status = 'submitted')
       OR ($2 = 'resolved' AND p.status IN ('certified','archived','suspended'))
       OR ($2 = 'all' AND p.status IN ('submitted','certified','archived','suspended'))
     )
)
SELECT kind, tenant_id, app_id, listing_id, profile_id, slug, name, app_type, distribution,
       app_status, listing_status, review_state, category, profile_type,
       profile_status, support_email, privacy_url, docs_url, support_url,
       partner_level, listing_url, contact_email, submitted_at,
       created_at, updated_at
  FROM review_queue
 WHERE ($1 = 'all' OR kind = $1)
 ORDER BY COALESCE(submitted_at, updated_at) DESC, updated_at DESC
 LIMIT $3`, normalized.Kind, normalized.State, normalized.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := &ReviewQueueResponse{
		SchemaVersion: "developer_marketplace.review_queue.v1",
		GeneratedAt:   time.Now().UTC(),
		Filter:        normalized,
		Items:         []ReviewQueueItem{},
	}
	for rows.Next() {
		var item ReviewQueueItem
		if err := rows.Scan(
			&item.Kind,
			&item.TenantID,
			&item.AppID,
			&item.ListingID,
			&item.ProfileID,
			&item.Slug,
			&item.Name,
			&item.AppType,
			&item.Distribution,
			&item.AppStatus,
			&item.ListingStatus,
			&item.ReviewState,
			&item.Category,
			&item.ProfileType,
			&item.ProfileStatus,
			&item.SupportEmail,
			&item.PrivacyURL,
			&item.DocsURL,
			&item.SupportURL,
			&item.PartnerLevel,
			&item.ListingURL,
			&item.ContactEmail,
			&item.SubmittedAt,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out.Items = append(out.Items, item)
		out.Counts.Total++
		if item.Kind == "app" {
			out.Counts.Apps++
		} else if item.Kind == "listing" {
			out.Counts.Listings++
		} else if item.Kind == "partner_profile" {
			out.Counts.Profiles++
		}
		if reviewQueueItemPending(item) {
			out.Counts.Pending++
		} else {
			out.Counts.Resolved++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListOAuthClients(ctx context.Context, tenantID, appID string) ([]OAuthClient, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, app_id::text, client_id, status,
       redirect_uris, scopes, created_at, updated_at, revoked_at
FROM oauth_clients
WHERE tenant_id = $1::uuid AND app_id = $2::uuid
ORDER BY created_at DESC`, tenantID, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OAuthClient{}
	for rows.Next() {
		item, err := scanOAuthClient(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateOAuthClient(ctx context.Context, tenantID, appID string, in OAuthClient) (*OAuthClient, string, error) {
	in.RedirectURI = cleanStrings(in.RedirectURI)
	in.Scopes = cleanStrings(in.Scopes)
	clientID, secret, secretHash, err := NewOAuthCredentials()
	if err != nil {
		return nil, "", err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, "", err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO oauth_clients
    (tenant_id, app_id, client_id, client_secret_hash, status, redirect_uris, scopes)
VALUES ($1::uuid, $2::uuid, $3, $4, 'active', $5::text[], $6::text[])
RETURNING id::text, tenant_id::text, app_id::text, client_id, status,
       redirect_uris, scopes, created_at, updated_at, revoked_at`,
		tenantID, appID, clientID, secretHash, in.RedirectURI, in.Scopes)
	out, err := scanOAuthClient(row)
	if err != nil {
		return nil, "", err
	}
	if err := upsertOAuthClientDirectoryTx(ctx, tx, *out, secretHash); err != nil {
		return nil, "", err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "oauth_client.created", map[string]any{"client_id": clientID})
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return out, secret, nil
}

// RevokeOAuthClient marks an OAuth client revoked: clears its hash-bearing
// status so future token exchanges fail closed, stamps revoked_at, and
// preserves the row for audit. Already-revoked clients are returned
// unchanged so the operation is idempotent — partners that retry
// revocation after a network blip don't get confusing 404s. Returns
// ErrNotFound if the client doesn't belong to the tenant's app.
func (r *Repo) RevokeOAuthClient(ctx context.Context, tenantID, appID, clientID string) (*OAuthClient, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	// Clear the secret material on revoke (column is NOT NULL, so '' is the
	// cleared sentinel). Auth already rejects revoked clients via status, but
	// scrubbing the hash means a revoked client's secret can never be verified
	// again even if a future code path forgot the status filter — and it makes
	// the documented "secrets are cleared on revocation" contract literally true.
	row := tx.QueryRow(ctx, `
UPDATE oauth_clients
   SET status = 'revoked',
       client_secret_hash = '',
       revoked_at = COALESCE(revoked_at, now()),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND id = $3::uuid
RETURNING id::text, tenant_id::text, app_id::text, client_id, status,
       redirect_uris, scopes, created_at, updated_at, revoked_at`,
		tenantID, appID, clientID)
	out, err := scanOAuthClient(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	if err := upsertOAuthClientDirectoryTx(ctx, tx, *out, ""); err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "oauth_client.revoked", map[string]any{
		"client_id": out.ClientID,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeInstallation uninstalls an app for a tenant. Sets status=revoked,
// stamps revoked_at, and clears granted_scopes so any audit later asking
// "what was this install authorized for?" sees the answer is `nothing now`
// without losing the timeline. Webhook subscriptions tied to the
// installation are revoked so retries stop firing at partner endpoints that
// have lost the trust relationship.
func (r *Repo) RevokeInstallation(ctx context.Context, tenantID, installationID string) (*Installation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE app_installations
   SET status = 'revoked',
       granted_scopes = '{}'::text[],
       revoked_at = COALESCE(revoked_at, now()),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, app_id::text, installed_by, status,
       granted_scopes, config, installed_at, updated_at, revoked_at`,
		tenantID, installationID)
	out, err := scanInstallation(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE app_webhook_subscriptions
   SET status = 'revoked', updated_at = now()
 WHERE tenant_id = $1::uuid AND installation_id = $2::uuid AND status <> 'revoked'`,
		tenantID, installationID); err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, out.AppID, "app.installation_revoked", map[string]any{
		"installation_id": out.ID,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertListing(ctx context.Context, tenantID, appID string, in Listing) (*Listing, error) {
	normalizePartnerEditableListing(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO app_listings
    (tenant_id, app_id, slug, name, category, summary, docs_url, support_url,
     icon_url, status, review_state, partner_level, tags, metadata)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14::jsonb)
ON CONFLICT (tenant_id, app_id) DO UPDATE SET
    slug = EXCLUDED.slug, name = EXCLUDED.name, category = EXCLUDED.category,
    summary = EXCLUDED.summary, docs_url = EXCLUDED.docs_url,
    support_url = EXCLUDED.support_url, icon_url = EXCLUDED.icon_url,
    status = EXCLUDED.status, review_state = EXCLUDED.review_state,
    partner_level = EXCLUDED.partner_level, tags = EXCLUDED.tags,
    metadata = EXCLUDED.metadata, updated_at = now()
RETURNING id::text, tenant_id::text, app_id::text, slug::text, name, category,
       summary, docs_url, support_url, icon_url, status, review_state,
       partner_level, tags, metadata, created_at, updated_at`,
		tenantID, appID, in.Slug, in.Name, in.Category, in.Summary,
		in.DocsURL, in.SupportURL, in.IconURL, in.Status, in.ReviewState,
		in.PartnerLevel, in.Tags, string(meta))
	out, err := scanListing(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "app_listing.upserted", map[string]any{"status": out.Status})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) SubmitListingReview(ctx context.Context, tenantID, appID string) (*Listing, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE app_listings
SET status = 'draft', review_state = 'submitted', updated_at = now()
WHERE tenant_id = $1::uuid AND app_id = $2::uuid
RETURNING id::text, tenant_id::text, app_id::text, slug::text, name, category,
       summary, docs_url, support_url, icon_url, status, review_state,
       partner_level, tags, metadata, created_at, updated_at`, tenantID, appID)
	out, err := scanListing(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "app_listing.submitted", map[string]any{
		"status":       out.Status,
		"review_state": out.ReviewState,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ReviewListingDecision(ctx context.Context, tenantID, appID string, in ReviewDecisionInput) (*Listing, error) {
	in = normalizeReviewDecision(in)
	status := "published"
	reviewState := "approved"
	action := "app_listing.review_approved"
	if in.Decision == "reject" {
		status = "draft"
		reviewState = "rejected"
		action = "app_listing.review_rejected"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE app_listings
SET status = $3,
    review_state = $4,
    partner_level = CASE WHEN $5 = '' THEN partner_level ELSE $5 END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND app_id = $2::uuid
RETURNING id::text, tenant_id::text, app_id::text, slug::text, name, category,
       summary, docs_url, support_url, icon_url, status, review_state,
       partner_level, tags, metadata, created_at, updated_at`,
		tenantID, appID, status, reviewState, in.PartnerLevel)
	out, err := scanListing(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, action, map[string]any{
		"decision":      in.Decision,
		"notes":         in.Notes,
		"status":        out.Status,
		"review_state":  out.ReviewState,
		"partner_level": out.PartnerLevel,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListListings returns listings newest-first with keyset pagination on
// (updated_at, id). updated_at is mutable, so a row edited between page
// fetches can shift pages; acceptable for this admin list. limit is the
// page size; a non-empty next cursor is returned when more rows remain.
func (r *Repo) ListListings(ctx context.Context, tenantID, category string, limit int, cursor pagination.Cursor) ([]Listing, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 category filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(category), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, app_id::text, slug::text, name, category,
       summary, docs_url, support_url, icon_url, status, review_state,
       partner_level, tags, metadata, created_at, updated_at
FROM app_listings
WHERE ($2 = '' OR category = $2)
  AND (
    tenant_id = $1::uuid
    OR (status = 'published' AND review_state = 'approved')
  )
  `+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Listing{}
	for rows.Next() {
		item, err := scanListing(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) InstallApp(ctx context.Context, tenantID, appID string, in Installation) (*Installation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	app, err := getAppTx(ctx, tx, tenantID, appID)
	if err != nil {
		return nil, err
	}
	if len(in.GrantedScopes) == 0 {
		in.GrantedScopes = app.Scopes
	}
	in.Status = defaulted(in.Status, "installed")
	if in.Config == nil {
		in.Config = map[string]any{}
	}
	cfg, _ := json.Marshal(in.Config)
	row := tx.QueryRow(ctx, `
INSERT INTO app_installations
    (tenant_id, app_id, installed_by, status, granted_scopes, config)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6::jsonb)
ON CONFLICT (tenant_id, app_id) DO UPDATE SET
    installed_by = EXCLUDED.installed_by, status = EXCLUDED.status,
    granted_scopes = EXCLUDED.granted_scopes, config = EXCLUDED.config,
    revoked_at = NULL, updated_at = now()
RETURNING id::text, tenant_id::text, app_id::text, installed_by, status,
       granted_scopes, config, installed_at, updated_at, revoked_at`,
		tenantID, appID, in.InstalledBy, in.Status, cleanStrings(in.GrantedScopes), string(cfg))
	out, err := scanInstallation(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "app.installed", map[string]any{"installation_id": out.ID})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListInstallations returns installations newest-first with keyset
// pagination on (updated_at, id). updated_at is mutable, so a row edited
// between page fetches can shift pages; acceptable for this admin list.
// limit is the page size; a non-empty next cursor is returned when more
// rows remain.
func (r *Repo) ListInstallations(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]Installation, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, app_id::text, installed_by, status,
       granted_scopes, config, installed_at, updated_at, revoked_at
FROM app_installations
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
  `+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Installation{}
	for rows.Next() {
		item, err := scanInstallation(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateWebhookSubscription(ctx context.Context, tenantID, appID string, in WebhookSubscription) (*WebhookSubscription, error) {
	in.Status = defaulted(in.Status, "active")
	in.Topics = cleanStrings(in.Topics)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO app_webhook_subscriptions
    (tenant_id, app_id, installation_id, endpoint_url, topics, signing_secret_ref, status, metadata)
VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4, $5::text[], $6, $7, $8::jsonb)
RETURNING id::text, tenant_id::text, app_id::text, COALESCE(installation_id::text,''),
       endpoint_url, topics, signing_secret_ref, status, failure_count,
       last_delivery_at, metadata, created_at, updated_at`,
		tenantID, appID, in.InstallationID, in.EndpointURL, in.Topics,
		in.SigningSecretRef, in.Status, string(meta))
	out, err := scanWebhookSubscription(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "app_webhook.created", map[string]any{"endpoint_url": in.EndpointURL})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListWebhookSubscriptions(ctx context.Context, tenantID, appID string) ([]WebhookSubscription, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, app_id::text, COALESCE(installation_id::text,''),
       endpoint_url, topics, signing_secret_ref, status, failure_count,
       last_delivery_at, metadata, created_at, updated_at
FROM app_webhook_subscriptions
WHERE tenant_id = $1::uuid AND app_id = $2::uuid
ORDER BY updated_at DESC`, tenantID, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WebhookSubscription{}
	for rows.Next() {
		item, err := scanWebhookSubscription(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) UpsertPartnerProfile(ctx context.Context, tenantID string, in PartnerProfile) (*PartnerProfile, error) {
	normalizePartnerEditableProfile(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO partner_program_profiles
    (tenant_id, organization_name, profile_type, status, certification_level,
     regions, verticals, services, listing_url, contact_email, metadata, review_notes)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6::text[], $7::text[], $8::text[],
     $9, NULLIF($10,'')::citext, $11::jsonb, $12)
ON CONFLICT (tenant_id) DO UPDATE SET
    organization_name = EXCLUDED.organization_name,
    profile_type = EXCLUDED.profile_type,
    status = EXCLUDED.status,
    certification_level = EXCLUDED.certification_level,
    regions = EXCLUDED.regions,
    verticals = EXCLUDED.verticals,
    services = EXCLUDED.services,
    listing_url = EXCLUDED.listing_url,
    contact_email = EXCLUDED.contact_email,
    metadata = EXCLUDED.metadata,
    review_notes = EXCLUDED.review_notes,
    updated_at = now()
RETURNING id::text, tenant_id::text, organization_name, profile_type, status,
       certification_level, regions, verticals, services, listing_url,
       COALESCE(contact_email::text,''), metadata, review_notes, created_at, updated_at`,
		tenantID, in.OrganizationName, in.ProfileType, in.Status,
		in.CertificationLevel, in.Regions, in.Verticals, in.Services,
		in.ListingURL, in.ContactEmail, string(meta), in.ReviewNotes)
	out, err := scanPartnerProfile(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, "", "partner_profile.upserted", map[string]any{"status": out.Status})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) SubmitPartnerProfileReview(ctx context.Context, tenantID string) (*PartnerProfile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE partner_program_profiles
SET status = 'submitted', certification_level = 'registered', updated_at = now()
WHERE tenant_id = $1::uuid
RETURNING id::text, tenant_id::text, organization_name, profile_type, status,
       certification_level, regions, verticals, services, listing_url,
       COALESCE(contact_email::text,''), metadata, review_notes, created_at, updated_at`, tenantID)
	out, err := scanPartnerProfile(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, "", "partner_profile.submitted", map[string]any{
		"status":              out.Status,
		"certification_level": out.CertificationLevel,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ReviewPartnerProfileDecision(ctx context.Context, tenantID string, in ReviewDecisionInput) (*PartnerProfile, error) {
	in = normalizeReviewDecision(in)
	status := "certified"
	level := in.PartnerLevel
	if level == "" {
		level = "certified"
	}
	action := "partner_profile.review_approved"
	if in.Decision == "reject" {
		status = "draft"
		level = "registered"
		action = "partner_profile.review_rejected"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE partner_program_profiles
SET status = $2, certification_level = $3, review_notes = $4, updated_at = now()
WHERE tenant_id = $1::uuid
RETURNING id::text, tenant_id::text, organization_name, profile_type, status,
       certification_level, regions, verticals, services, listing_url,
       COALESCE(contact_email::text,''), metadata, review_notes, created_at, updated_at`,
		tenantID, status, level, in.Notes)
	out, err := scanPartnerProfile(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	_ = recordAuditTx(ctx, tx, tenantID, "", action, map[string]any{
		"decision":            in.Decision,
		"notes":               in.Notes,
		"status":              out.Status,
		"certification_level": out.CertificationLevel,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPartnerProfiles returns partner profiles newest-first with keyset
// pagination on (updated_at, id). updated_at is mutable, so a row edited
// between page fetches can shift pages; acceptable for this admin list.
// limit is the page size; a non-empty next cursor is returned when more
// rows remain.
func (r *Repo) ListPartnerProfiles(ctx context.Context, tenantID, profileType string, limit int, cursor pagination.Cursor) ([]PartnerProfile, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 profile_type filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(profileType), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, organization_name, profile_type, status,
       certification_level, regions, verticals, services, listing_url,
       COALESCE(contact_email::text,''), metadata, review_notes, created_at, updated_at
FROM partner_program_profiles
WHERE ($2 = '' OR profile_type = $2)
  AND (tenant_id = $1::uuid OR status = 'certified')
  `+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []PartnerProfile{}
	for rows.Next() {
		item, err := scanPartnerProfile(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateTestAccount(ctx context.Context, tenantID, appID string, in TestAccount) (*TestAccount, error) {
	in.Name = defaulted(strings.TrimSpace(in.Name), "Sandbox test account")
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	if in.SeededResources == nil {
		in.SeededResources = map[string]any{}
	}
	seeded, _ := json.Marshal(in.SeededResources)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO developer_test_accounts
    (tenant_id, app_id, name, status, sandbox_tenant_id, seeded_resources, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,'')::uuid, $6::jsonb, $7)
RETURNING id::text, tenant_id::text, app_id::text, name, status,
       COALESCE(sandbox_tenant_id::text,''), seeded_resources, expires_at,
       created_at, updated_at`,
		tenantID, appID, in.Name, in.Status, in.SandboxTenantID, string(seeded), in.ExpiresAt)
	out, err := scanTestAccount(row)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, appID, "developer_test_account.created", map[string]any{"test_account_id": out.ID})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListTestAccounts(ctx context.Context, tenantID, appID string) ([]TestAccount, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getOwnedAppTx(ctx, tx, tenantID, appID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, app_id::text, name, status,
       COALESCE(sandbox_tenant_id::text,''), seeded_resources, expires_at,
       created_at, updated_at
FROM developer_test_accounts
WHERE tenant_id = $1::uuid AND app_id = $2::uuid
ORDER BY created_at DESC`, tenantID, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TestAccount{}
	for rows.Next() {
		item, err := scanTestAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListAuditLogs returns audit log entries newest-first with keyset
// pagination on (created_at, id). id is a BIGSERIAL so the cursor's
// string id casts via ::bigint. limit is the page size; a non-empty next
// cursor is returned when more rows remain.
func (r *Repo) ListAuditLogs(ctx context.Context, tenantID, appID string, limit int, cursor pagination.Cursor) ([]AuditLog, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 app_id filter, $3 limit+1; the keyset bound (when paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(appID), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($4::timestamptz, $5::bigint)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, COALESCE(app_id::text,''), actor, action, metadata, created_at
FROM developer_app_audit_logs
WHERE tenant_id = $1::uuid AND ($2 = '' OR app_id::text = $2)
  `+keyset+`
ORDER BY created_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []AuditLog{}
	for rows.Next() {
		item, err := scanAuditLog(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: strconv.FormatInt(last.ID, 10)})
	}
	return out, next, nil
}

func getAppTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*App, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at
FROM developer_apps
WHERE id = $2::uuid
  AND (
    tenant_id = $1::uuid
    OR (distribution IN `+publicDistributionsSQL+` AND status IN ('approved','active'))
  )`, tenantID, id)
	out, err := scanApp(row)
	return out, mapNoRows(err)
}

func getOwnedAppTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*App, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, slug::text, app_type, distribution,
       status, COALESCE(owner_email::text,''), COALESCE(support_email::text,''),
       homepage_url, privacy_url, terms_url, description, scopes, redirect_uris,
       api_revisions, webhook_topics, test_mode, metadata, review_notes,
       submitted_at, approved_at, created_at, updated_at
FROM developer_apps
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanApp(row)
	return out, mapNoRows(err)
}

func getListingForAppTx(ctx context.Context, tx pgx.Tx, tenantID, appID string) (*Listing, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, app_id::text, slug::text, name, category,
       summary, docs_url, support_url, icon_url, status, review_state,
       partner_level, tags, metadata, created_at, updated_at
FROM app_listings
WHERE tenant_id = $1::uuid AND app_id = $2::uuid`, tenantID, appID)
	out, err := scanListing(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return out, err
}

func getAppMonitoringCountsTx(ctx context.Context, tx pgx.Tx, tenantID, appID string) (*AppMonitoringCounts, error) {
	var out AppMonitoringCounts
	row := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*)::int FROM oauth_clients WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT count(*)::int FROM oauth_clients WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'active' AND revoked_at IS NULL),
  (SELECT count(*)::int FROM oauth_clients WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'revoked'),
  (SELECT count(*)::int FROM app_installations WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT count(*)::int FROM app_installations WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'installed'),
  (SELECT count(*)::int FROM app_installations WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'suspended'),
  (SELECT count(*)::int FROM app_installations WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'revoked'),
  (SELECT count(*)::int FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT count(*)::int FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'active'),
  (SELECT count(*)::int FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'paused'),
  (SELECT count(*)::int FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'revoked'),
  (SELECT COALESCE(sum(failure_count), 0)::int FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT max(last_delivery_at) FROM app_webhook_subscriptions WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT count(*)::int FROM developer_test_accounts WHERE tenant_id = $1::uuid AND app_id = $2::uuid),
  (SELECT count(*)::int FROM developer_test_accounts WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'active'),
  (SELECT count(*)::int FROM developer_test_accounts WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'expired'),
  (SELECT count(*)::int FROM developer_test_accounts WHERE tenant_id = $1::uuid AND app_id = $2::uuid AND status = 'revoked'),
  (SELECT count(*)::int FROM app_oauth_access_tokens WHERE app_id = $2::uuid),
  (SELECT count(*)::int FROM app_oauth_access_tokens WHERE app_id = $2::uuid AND revoked_at IS NULL AND expires_at > now()),
  (SELECT count(*)::int FROM app_oauth_access_tokens WHERE app_id = $2::uuid AND revoked_at IS NOT NULL),
  (SELECT count(*)::int FROM app_oauth_access_tokens WHERE app_id = $2::uuid AND revoked_at IS NULL AND expires_at <= now()),
  (SELECT max(last_used_at) FROM app_oauth_access_tokens WHERE app_id = $2::uuid)
`, tenantID, appID)
	if err := row.Scan(
		&out.OAuthClients.Total,
		&out.OAuthClients.Active,
		&out.OAuthClients.Revoked,
		&out.Installations.Total,
		&out.Installations.Installed,
		&out.Installations.Suspended,
		&out.Installations.Revoked,
		&out.WebhookSubscriptions.Total,
		&out.WebhookSubscriptions.Active,
		&out.WebhookSubscriptions.Paused,
		&out.WebhookSubscriptions.Revoked,
		&out.WebhookFailures,
		&out.LastDeliveryAt,
		&out.TestAccounts.Total,
		&out.TestAccounts.Active,
		&out.TestAccounts.Expired,
		&out.TestAccounts.Revoked,
		&out.AccessTokens.Total,
		&out.AccessTokens.Active,
		&out.AccessTokens.Revoked,
		&out.AccessTokens.Expired,
		&out.LastTokenUsedAt,
	); err != nil {
		return nil, err
	}
	return &out, nil
}

func recordAuditTx(ctx context.Context, tx pgx.Tx, tenantID, appID, action string, metadata map[string]any) error {
	if metadata == nil {
		metadata = map[string]any{}
	}
	meta, _ := json.Marshal(metadata)
	_, err := tx.Exec(ctx, `
INSERT INTO developer_app_audit_logs (tenant_id, app_id, action, metadata)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4::jsonb)`,
		tenantID, appID, action, string(meta))
	return err
}

func withReviewQueueScope(ctx context.Context, pool *db.Pool) (pgx.Tx, error) {
	if pool == nil {
		return nil, fmt.Errorf("developer marketplace repo requires a database pool")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.developer_marketplace_reviewer', 'true', true)"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func reviewQueueItemPending(item ReviewQueueItem) bool {
	if item.Kind == "app" {
		return item.AppStatus == "submitted" || item.AppStatus == "in_review"
	}
	if item.Kind == "partner_profile" {
		return item.ProfileStatus == "submitted"
	}
	return item.ReviewState == "submitted"
}

func scanApp(row rowScanner) (*App, error) {
	var out App
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Slug, &out.AppType,
		&out.Distribution, &out.Status, &out.OwnerEmail, &out.SupportEmail,
		&out.HomepageURL, &out.PrivacyURL, &out.TermsURL, &out.Description,
		&out.Scopes, &out.RedirectURIs, &out.APIRevisions, &out.WebhookTopics,
		&out.TestMode, &meta, &out.ReviewNotes, &out.SubmittedAt, &out.ApprovedAt,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	out.Checklist = ReviewChecklist(out)
	return &out, nil
}

func scanOAuthClient(row rowScanner) (*OAuthClient, error) {
	var out OAuthClient
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.ClientID,
		&out.Status, &out.RedirectURI, &out.Scopes, &out.CreatedAt,
		&out.UpdatedAt, &out.RevokedAt); err != nil {
		return nil, err
	}
	return &out, nil
}

func scanListing(row rowScanner) (*Listing, error) {
	var out Listing
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.Slug,
		&out.Name, &out.Category, &out.Summary, &out.DocsURL, &out.SupportURL,
		&out.IconURL, &out.Status, &out.ReviewState, &out.PartnerLevel,
		&out.Tags, &meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanInstallation(row rowScanner) (*Installation, error) {
	var out Installation
	var cfg []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.InstalledBy,
		&out.Status, &out.GrantedScopes, &cfg, &out.InstalledAt,
		&out.UpdatedAt, &out.RevokedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(cfg, &out.Config)
	if out.Config == nil {
		out.Config = map[string]any{}
	}
	return &out, nil
}

func scanWebhookSubscription(row rowScanner) (*WebhookSubscription, error) {
	var out WebhookSubscription
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.InstallationID,
		&out.EndpointURL, &out.Topics, &out.SigningSecretRef, &out.Status,
		&out.FailureCount, &out.LastDeliveryAt, &meta, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanPartnerProfile(row rowScanner) (*PartnerProfile, error) {
	var out PartnerProfile
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.OrganizationName,
		&out.ProfileType, &out.Status, &out.CertificationLevel, &out.Regions,
		&out.Verticals, &out.Services, &out.ListingURL, &out.ContactEmail,
		&meta, &out.ReviewNotes, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanTestAccount(row rowScanner) (*TestAccount, error) {
	var out TestAccount
	var seeded []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.Name,
		&out.Status, &out.SandboxTenantID, &seeded, &out.ExpiresAt,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(seeded, &out.SeededResources)
	if out.SeededResources == nil {
		out.SeededResources = map[string]any{}
	}
	return &out, nil
}

func scanAuditLog(row rowScanner) (*AuditLog, error) {
	var out AuditLog
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.AppID, &out.Actor,
		&out.Action, &meta, &out.CreatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func normalizePartnerEditableApp(in *App) {
	normalizeApp(in)
	switch in.Status {
	case "suspended", "archived":
	default:
		in.Status = "draft"
	}
	in.SubmittedAt = nil
	in.ApprovedAt = nil
}

func normalizeListing(in *Listing) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	in.Slug = strings.Trim(strings.ToLower(strings.TrimSpace(in.Slug)), "-")
	in.Category = defaulted(strings.TrimSpace(in.Category), "marketing")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.ReviewState = defaulted(strings.TrimSpace(in.ReviewState), "draft")
	in.Tags = cleanStrings(in.Tags)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizePartnerEditableListing(in *Listing) {
	normalizeListing(in)
	switch in.Status {
	case "unlisted", "archived":
	default:
		in.Status = "draft"
	}
	in.ReviewState = "draft"
}

func normalizePartnerProfile(in *PartnerProfile) {
	in.OrganizationName = strings.TrimSpace(in.OrganizationName)
	in.ProfileType = defaulted(strings.TrimSpace(in.ProfileType), "technology")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.CertificationLevel = defaulted(strings.TrimSpace(in.CertificationLevel), "registered")
	in.Regions = cleanStrings(in.Regions)
	in.Verticals = cleanStrings(in.Verticals)
	in.Services = cleanStrings(in.Services)
	in.ContactEmail = strings.TrimSpace(strings.ToLower(in.ContactEmail))
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizePartnerEditableProfile(in *PartnerProfile) {
	normalizePartnerProfile(in)
	switch in.Status {
	case "archived":
	default:
		in.Status = "draft"
	}
	in.CertificationLevel = "registered"
}

func mapNoRows(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
