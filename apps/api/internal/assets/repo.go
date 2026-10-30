// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

// ErrNotFound is returned when an asset row lookup misses.
var (
	ErrNotFound = errors.New("assets: not found")
	// ErrStale is returned when a live row exists but its positive version no
	// longer matches the representation the caller inspected.
	ErrStale          = errors.New("assets: stale version")
	ErrInvalidVersion = errors.New("assets: expected version must be positive")
	// ErrHasReferences is returned by checked deletion with the authoritative
	// usage list from the same transaction.
	ErrHasReferences = errors.New("assets: has references")
	// ErrInvalidAssetID prevents a caller-provided identifier from reaching an
	// id::uuid cast or being persisted as a different generated identifier.
	ErrInvalidAssetID = errors.New("assets: invalid asset id")
	// ErrInvalidCursor is returned before database access when a list cursor is
	// not the canonical lowercase UUID emitted by the API.
	ErrInvalidCursor = errors.New("assets: invalid cursor")
	// ErrNotConfigured is returned by UploadBytes when the storage backend
	// or repository pool is not wired (a deployment/config issue → HTTP 503).
	ErrNotConfigured = errors.New("assets: storage or repository not configured")
	errEmpty         = errors.New("assets: empty body")
	errTooBig        = errors.New("assets: exceeds max size")
	errBadType       = errors.New("assets: not a recognised image")
)

// StorageLimitError reports the exact standing-byte decision made while the
// tenant advisory lock was held.
type StorageLimitError struct {
	Tier      string
	Limit     int64
	Current   int64
	Requested int64
}

func (e *StorageLimitError) Error() string {
	return fmt.Sprintf("assets: storage allowance exceeded for %s tier: current=%d requested=%d limit=%d", e.Tier, e.Current, e.Requested, e.Limit)
}

// Asset is the public projection.
//
// Refined Library (PR 1) added AltText, ReferencesCount, LastUsedAt — all
// additive and default-safe. Existing rows have AltText="" and
// ReferencesCount=0 from the migration defaults; LastUsedAt is NULL until
// the periodic refresher first observes the asset in a live draft.
type Asset struct {
	ID              string     `json:"id"`
	TenantID        string     `json:"tenantId"`
	Filename        string     `json:"filename"`
	Mime            string     `json:"mime"`
	Bytes           int64      `json:"bytes"`
	Width           int        `json:"width"`
	Height          int        `json:"height"`
	URL             string     `json:"url"`
	StorageKey      string     `json:"-"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	Version         int64      `json:"version"`
	AltText         string     `json:"altText"`
	ReferencesCount int        `json:"referencesCount"`
	LastUsedAt      *time.Time `json:"lastUsedAt,omitempty"`
	// FolderID is nil when the asset sits in the Uncategorised bucket.
	// Surfaces as a JSON null on the wire so the desktop client can
	// distinguish "no folder set" from "field omitted".
	FolderID *string `json:"folderId"`
}

// Referrer is a single live draft / template / form that embeds the asset URL.
type Referrer struct {
	Kind string `json:"kind"` // "campaign" | "template" | "form"
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListParams configures the new filter / sort / search options for List.
// Zero-values are valid (no filter, sort by newest, no search).
type ListParams struct {
	Limit  int
	Before string
	Query  string // free-text on filename
	Sort   string // "newest"|"oldest"|"largest"|"name"|"most-used"
	Filter string // ""|"all"|"recent"|"in-use"|"unused"|"large"
	// Tag, when non-empty, restricts the result to assets that carry the
	// given tag (case-insensitive; normalized via the same rules the tag
	// handler applies). Added by Workstream 4 (Mailchimp parity polish).
	Tag string
	// FolderID drives the folder chip-row filter (Mailchimp-parity
	// follow-up). nil → no filter (every folder + uncategorised);
	// pointer to "" → assets in the Uncategorised bucket (folder_id IS
	// NULL); pointer to a uuid → assets scoped to that folder. The HTTP
	// handler converts the sentinel ?folder_id=root into the empty
	// string form.
	FolderID *string
}

// Counts returns smart-filter chip counts for a tenant. Computed off the
// FULL asset set (ignoring Limit/Before) so chip totals don't shift while
// the user paginates.
type Counts struct {
	All    int `json:"all"`
	Recent int `json:"recent"`
	InUse  int `json:"inUse"`
	Unused int `json:"unused"`
	Large  int `json:"large"`
}

// Repo wraps pgx with asset CRUD.
type Repo struct{ Pool *db.Pool }

const assetCols = `id::text, tenant_id::text, filename, mime, bytes, width, height,
                   storage_key, url, created_at, updated_at, version, alt_text,
                   references_count, last_used_at, folder_id::text`

func scanAsset(row pgx.Row, a *Asset) error {
	return row.Scan(&a.ID, &a.TenantID, &a.Filename, &a.Mime, &a.Bytes,
		&a.Width, &a.Height, &a.StorageKey, &a.URL, &a.CreatedAt,
		&a.UpdatedAt, &a.Version, &a.AltText, &a.ReferencesCount,
		&a.LastUsedAt, &a.FolderID)
}

// Insert writes a new row and returns the populated Asset.
func (r *Repo) Insert(ctx context.Context, tenantID string, a Asset) (*Asset, error) {
	parsedID, err := uuid.Parse(a.ID)
	if err != nil || parsedID.String() != strings.ToLower(a.ID) {
		return nil, ErrInvalidAssetID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize standing-storage decisions for this tenant. Without one common
	// lock, two concurrent uploads could both observe room for one final object
	// and commit above the advertised hard cap.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1::int, hashtext($2))`, int32(0x41535354), tenantID); err != nil {
		return nil, fmt.Errorf("assets: lock storage allowance: %w", err)
	}
	var tier string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&tier); err != nil {
		return nil, fmt.Errorf("assets: resolve storage tier: %w", err)
	}
	canonical, allowance := limits.AssetStorageAllowanceBytes(tier)
	var current int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sum(bytes), 0)::bigint
  FROM assets
 WHERE tenant_id = $1::uuid AND deleted_at IS NULL`, tenantID).Scan(&current); err != nil {
		return nil, fmt.Errorf("assets: read storage usage: %w", err)
	}
	if a.Bytes < 0 || a.Bytes > allowance-current {
		return nil, &StorageLimitError{Tier: canonical, Limit: allowance, Current: current, Requested: a.Bytes}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO assets (id, tenant_id, filename, mime, bytes, width, height, storage_key, url)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
	RETURNING id::text, created_at, updated_at, version, alt_text, references_count, last_used_at`,
		a.ID, tenantID, a.Filename, a.Mime, a.Bytes, a.Width, a.Height, a.StorageKey, a.URL)
	if err := row.Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt, &a.Version, &a.AltText, &a.ReferencesCount, &a.LastUsedAt); err != nil {
		return nil, err
	}
	a.TenantID = tenantID
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &a, nil
}

// List returns at most limit rows for the tenant, optionally before the
// supplied id (cursor pagination). Preserved for any caller that still
// uses the legacy signature; new code should use ListWithCounts.
func (r *Repo) List(ctx context.Context, tenantID string, limit int, before string) ([]Asset, error) {
	items, _, err := r.ListWithCounts(ctx, tenantID, ListParams{Limit: limit, Before: before})
	return items, err
}

// ListWithCounts returns rows matching p plus the smart-filter chip counts.
// Both queries run in the same transaction so the totals match the rows.
func (r *Repo) ListWithCounts(ctx context.Context, tenantID string, p ListParams) ([]Asset, Counts, error) {
	items, counts, _, err := r.ListPageWithCounts(ctx, tenantID, p)
	return items, counts, err
}

// ListPageWithCounts also probes one row beyond the requested page. When more
// rows exist, nextCursor is the final returned asset ID; otherwise it is empty.
// ListWithCounts remains as a compatibility wrapper for internal callers.
func (r *Repo) ListPageWithCounts(ctx context.Context, tenantID string, p ListParams) ([]Asset, Counts, string, error) {
	if p.Limit <= 0 || p.Limit > 500 {
		p.Limit = 50
	}
	if p.Before != "" && !isCanonicalAssetUUID(p.Before) {
		return nil, Counts{}, "", ErrInvalidCursor
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, Counts{}, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if p.Before != "" {
		var cursorExists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM assets WHERE id = $1::uuid AND deleted_at IS NULL)`, p.Before,
		).Scan(&cursorExists); err != nil {
			return nil, Counts{}, "", err
		}
		if !cursorExists {
			return nil, Counts{}, "", ErrInvalidCursor
		}
	}

	// Counts ignore Limit / Before / Query / Filter — they describe the
	// whole tenant asset set so chip totals stay stable across paginations.
	var c Counts
	// Note: `all` is a reserved SQL keyword so the alias must be quoted
	// (or omitted — Scan is positional). We quote it to keep the SELECT
	// readable for anyone tailing logs.
	if err := tx.QueryRow(ctx, `
SELECT
  COUNT(*)                                                                                                  AS "all",
  COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' OR last_used_at > now() - interval '30 days') AS recent,
  COUNT(*) FILTER (WHERE references_count > 0)                                                              AS in_use,
  COUNT(*) FILTER (WHERE references_count = 0 AND created_at < now() - interval '14 days')                  AS unused,
  COUNT(*) FILTER (WHERE bytes > 1048576)                                                                   AS large
FROM assets WHERE deleted_at IS NULL`).Scan(&c.All, &c.Recent, &c.InUse, &c.Unused, &c.Large); err != nil {
		return nil, Counts{}, "", err
	}

	// Build the rows query with parameterised filters. We keep params
	// strictly positional to avoid SQL injection — the only string
	// concatenation here is the WHERE-fragment / ORDER-BY whitelist.
	var (
		where = []string{"deleted_at IS NULL"}
		args  = []any{}
	)
	if p.Query != "" {
		args = append(args, "%"+escapeLikePattern(strings.ToLower(p.Query))+"%")
		where = append(where, "lower(filename) LIKE $"+itoa(len(args))+" ESCAPE E'\\\\'")
	}
	switch p.Filter {
	case "recent":
		where = append(where, "(created_at > now() - interval '30 days' OR last_used_at > now() - interval '30 days')")
	case "in-use":
		where = append(where, "references_count > 0")
	case "unused":
		where = append(where, "references_count = 0 AND created_at < now() - interval '14 days'")
	case "large":
		where = append(where, "bytes > 1048576")
	}
	if tag := normalizeTag(p.Tag); tag != "" {
		args = append(args, tag)
		where = append(where, "id IN (SELECT asset_id FROM asset_tags WHERE tag = $"+itoa(len(args))+")")
	}
	if p.FolderID != nil {
		// Empty string is the "root / uncategorised" sentinel; any other
		// value is treated as a folder uuid. RLS scopes asset_folders
		// to the tenant, so a uuid from another tenant resolves to "no
		// matching rows" rather than a security leak.
		if *p.FolderID == "" {
			where = append(where, "folder_id IS NULL")
		} else {
			args = append(args, *p.FolderID)
			where = append(where, "folder_id::text = $"+itoa(len(args)))
		}
	}

	orderBy, cursorTuple, cursorColumns, cursorDirection := assetListSortSQL(p.Sort)
	if p.Before != "" {
		args = append(args, p.Before)
		placeholder := "$" + itoa(len(args))
		// The cursor tuple is resolved under the same tenant RLS transaction.
		// A deleted, foreign-tenant, or unknown UUID therefore produces no rows
		// without revealing whether that identifier exists elsewhere.
		where = append(where, cursorTuple+" "+cursorDirection+" (SELECT "+cursorColumns+" FROM assets WHERE id = "+placeholder+"::uuid AND deleted_at IS NULL)")
	}

	q := "SELECT " + assetCols + " FROM assets WHERE " + strings.Join(where, " AND ") +
		" " + orderBy + " LIMIT " + itoa(p.Limit+1)

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, Counts{}, "", err
	}
	defer rows.Close()
	out := []Asset{}
	for rows.Next() {
		var a Asset
		if err := scanAsset(rows, &a); err != nil {
			return nil, Counts{}, "", err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, Counts{}, "", err
	}
	nextCursor := ""
	if len(out) > p.Limit {
		out = out[:p.Limit]
		nextCursor = out[len(out)-1].ID
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, Counts{}, "", err
	}
	return out, c, nextCursor, nil
}

func isCanonicalAssetUUID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && raw == id.String()
}

// assetListSortSQL defines both the visible order and its lexicographic cursor
// tuple. The final UUID component is mandatory: timestamps, sizes, filenames,
// and usage counts can all tie, and omitting it causes duplicate/omitted rows.
func assetListSortSQL(sortName string) (orderBy, cursorTuple, cursorColumns, cursorDirection string) {
	switch sortName {
	case "oldest":
		return "ORDER BY created_at ASC, id ASC", "(created_at, id)", "created_at, id", ">"
	case "largest":
		return "ORDER BY bytes DESC, id DESC", "(bytes, id)", "bytes, id", "<"
	case "name":
		return "ORDER BY lower(filename) ASC, id ASC", "(lower(filename), id)", "lower(filename), id", ">"
	case "most-used":
		return "ORDER BY references_count DESC, created_at DESC, id DESC", "(references_count, created_at, id)", "references_count, created_at, id", "<"
	default:
		return "ORDER BY created_at DESC, id DESC", "(created_at, id)", "created_at, id", "<"
	}
}

// Get returns the asset row by id.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Asset, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var a Asset
	row := tx.QueryRow(ctx, "SELECT "+assetCols+" FROM assets WHERE id::text = $1 AND deleted_at IS NULL", id)
	if err := scanAsset(row, &a); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &a, nil
}

// SoftDelete sets deleted_at = now() only for the exact version inspected by
// the caller and returns the tombstone version.
func (r *Repo) SoftDelete(ctx context.Context, tenantID, id string, expectedVersion int64) (int64, error) {
	if expectedVersion <= 0 {
		return 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version int64
	err = tx.QueryRow(ctx, `
UPDATE assets
   SET deleted_at = now(), updated_at = now(), version = version + 1
 WHERE id::text = $1 AND deleted_at IS NULL AND version = $2
 RETURNING version`, id, expectedVersion).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, classifyAssetMutationMiss(ctx, tx, id)
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return version, nil
}

// DeleteChecked recomputes current usage and soft-deletes in one tenant
// transaction. A non-force delete fails closed on every usage lookup error;
// ErrHasReferences carries the count and referrers without a second fetch.
// Content tables can still change in a separate transaction immediately after
// this check, so this narrows but cannot eliminate the cross-table TOCTOU.
func (r *Repo) DeleteChecked(ctx context.Context, tenantID, id string, expectedVersion int64, force bool) (int64, int, []Referrer, error) {
	if expectedVersion <= 0 {
		return 0, 0, nil, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, 0, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		url            string
		currentVersion int64
	)
	if err := tx.QueryRow(ctx,
		`SELECT url, version FROM assets WHERE id::text = $1 AND deleted_at IS NULL FOR UPDATE`, id,
	).Scan(&url, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, nil, ErrNotFound
		}
		return 0, 0, nil, err
	}
	if currentVersion != expectedVersion {
		return 0, 0, nil, ErrStale
	}

	refs := []Referrer{}
	if !force && url != "" {
		refs, err = collectReferrers(ctx, tx, "%"+escapeLikePattern(url)+"%")
		if err != nil {
			return 0, 0, nil, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE assets SET references_count = $2,
			 last_used_at = CASE WHEN $2 > 0 THEN now() ELSE last_used_at END
				 WHERE id::text = $1`, id, len(refs)); err != nil {
			return 0, 0, nil, err
		}
		if len(refs) > 0 {
			if err := tx.Commit(ctx); err != nil {
				return 0, 0, nil, err
			}
			return currentVersion, len(refs), refs, ErrHasReferences
		}
	}

	var version int64
	if err := tx.QueryRow(ctx, `
UPDATE assets
   SET deleted_at = now(), updated_at = now(), version = version + 1
 WHERE id::text = $1 AND deleted_at IS NULL AND version = $2
 RETURNING version`, id, expectedVersion).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, nil, classifyAssetMutationMiss(ctx, tx, id)
		}
		return 0, 0, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, nil, err
	}
	return version, 0, refs, nil
}

// UpdateAltText sets alt_text on a single asset and returns the refreshed row.
func (r *Repo) UpdateAltText(ctx context.Context, tenantID, id, altText string, expectedVersion int64) (*Asset, error) {
	if expectedVersion <= 0 {
		return nil, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var a Asset
	row := tx.QueryRow(ctx, `UPDATE assets
SET alt_text = $2, updated_at = now(), version = version + 1
WHERE id::text = $1 AND deleted_at IS NULL AND version = $3
RETURNING `+assetCols, id, altText, expectedVersion)
	if err := scanAsset(row, &a); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, classifyAssetMutationMiss(ctx, tx, id)
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &a, nil
}

func classifyAssetMutationMiss(ctx context.Context, tx pgx.Tx, id string) error {
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM assets WHERE id::text = $1 AND deleted_at IS NULL)`, id,
	).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return ErrStale
}

// RecomputeReferenceCount scans the tenant's live drafts (campaigns in
// status draft|scheduled, all tenant-owned templates, forms in status
// draft|published) for the asset's URL, updates references_count +
// last_used_at, and returns the new count plus the referrer list.
//
// "Sent campaigns are not counted" per the spec — they're already delivered
// so warning the user does no good.
func (r *Repo) RecomputeReferenceCount(ctx context.Context, tenantID, id string) (int, []Referrer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var url string
	if err := tx.QueryRow(ctx,
		`SELECT url FROM assets WHERE id::text = $1 AND deleted_at IS NULL`, id,
	).Scan(&url); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil, ErrNotFound
		}
		return 0, nil, err
	}
	if url == "" {
		return 0, nil, nil
	}

	needle := "%" + escapeLikePattern(url) + "%"
	refs, err := collectReferrers(ctx, tx, needle)
	if err != nil {
		return 0, nil, err
	}

	now := time.Now().UTC()
	if _, err := tx.Exec(ctx,
		`UPDATE assets SET references_count = $2, last_used_at = CASE WHEN $2 > 0 THEN $3 ELSE last_used_at END
		 WHERE id::text = $1`,
		id, len(refs), now,
	); err != nil {
		return 0, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, err
	}
	return len(refs), refs, nil
}

// RecomputeAllReferenceCounts rebuilds references_count + last_used_at for
// every asset of the tenant. Single batch UPDATE per kind; cheap on small
// tenants and bounded on large ones.
func (r *Repo) RecomputeAllReferenceCounts(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Snapshot all of the tenant's asset URLs. For each url, count
	// matches across the three consumer tables, then batch-UPDATE.
	rows, err := tx.Query(ctx, `SELECT id::text, url FROM assets WHERE deleted_at IS NULL`)
	if err != nil {
		return err
	}
	type pair struct{ id, url string }
	all := []pair{}
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.id, &p.url); err != nil {
			rows.Close()
			return err
		}
		all = append(all, p)
	}
	rows.Close()

	now := time.Now().UTC()
	for _, p := range all {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if p.url == "" {
			continue
		}
		refs, err := collectReferrers(ctx, tx, "%"+escapeLikePattern(p.url)+"%")
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE assets SET references_count = $2, last_used_at = CASE WHEN $2 > 0 THEN $3 ELSE last_used_at END
			 WHERE id::text = $1`,
			p.id, len(refs), now,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func collectReferrers(ctx context.Context, tx pgx.Tx, needle string) ([]Referrer, error) {
	out := []Referrer{}

	// campaigns — live drafts only ("sent" is not actionable for users)
	rows, err := tx.Query(ctx, `
SELECT id::text, name FROM campaigns
WHERE status IN ('draft','scheduled')
  AND (COALESCE(body_html,'') ILIKE $1 ESCAPE E'\\' OR COALESCE(body_mjml,'') ILIKE $1 ESCAPE E'\\')`, needle)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r Referrer
		r.Kind = "campaign"
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, r)
	}
	rows.Close()

	// tenant-owned templates (platform templates have tenant_id IS NULL and
	// are out-of-scope for tenant deletion warnings)
	rows, err = tx.Query(ctx, `
SELECT id::text, name FROM campaign_templates
WHERE tenant_id IS NOT NULL
  AND (COALESCE(body_html,'') ILIKE $1 ESCAPE E'\\' OR COALESCE(body_mjml,'') ILIKE $1 ESCAPE E'\\')`, needle)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r Referrer
		r.Kind = "template"
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, r)
	}
	rows.Close()

	// forms — JSONB serialized to text for substring match; cheap because
	// the per-tenant form set is small.
	rows, err = tx.Query(ctx, `
SELECT id::text, name FROM forms
WHERE status IN ('draft','published')
  AND (structure::text ILIKE $1 ESCAPE E'\\' OR settings::text ILIKE $1 ESCAPE E'\\')`, needle)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r Referrer
		r.Kind = "form"
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, r)
	}
	rows.Close()

	return out, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func escapeLikePattern(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
