// SPDX-License-Identifier: AGPL-3.0-only
//
// profile_links_store.go — Postgres-backed CRUD over profile_object_links
// (SUB-011). The table + RLS already exist (migration 0201); this is its
// first Store surface. Every read/write opens a tenant-scoped tx via
// db.WithTenant so the RLS policy enforces the boundary.

package customobjects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ListProfileLinks returns every custom-object link bound to a single
// subscriber, joined to its type (key + label) and record (external_id +
// properties) so the profile UI can render each linked record without a
// second round-trip. Newest-first.
func (s *pgStore) ListProfileLinks(ctx context.Context, tenantID, subscriberID string) ([]ProfileObjectLink, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT l.id::text, l.tenant_id::text, l.object_type_id::text, l.object_record_id::text,
		       COALESCE(l.subscriber_id::text, ''), COALESCE(l.subscriber_email, ''),
		       l.relationship, COALESCE(l.metadata::text, '{}'), l.created_at,
		       COALESCE(t.key, ''), COALESCE(t.label, ''),
		       COALESCE(r.external_id, ''), COALESCE(r.properties::text, '{}')
		  FROM profile_object_links l
		  LEFT JOIN custom_object_types   t ON t.id = l.object_type_id
		  LEFT JOIN custom_object_records r ON r.id = l.object_record_id
		 WHERE l.subscriber_id = $1::uuid
		 ORDER BY l.created_at DESC`, subscriberID)
	if err != nil {
		return nil, fmt.Errorf("list profile_object_links: %w", err)
	}
	defer rows.Close()
	out := []ProfileObjectLink{}
	for rows.Next() {
		link, err := scanProfileLinkJoined(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, link)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateProfileLink binds the given record to the subscriber. The type id
// is derived from the record server-side (callers only pass the record
// id). relationship defaults to "related". A duplicate
// (tenant, record, subscriber, email, relationship) is a 23505 surfaced
// as ErrConflict.
func (s *pgStore) CreateProfileLink(ctx context.Context, tenantID, subscriberID string, p CreateProfileLinkParams) (ProfileObjectLink, error) {
	rel := p.Relationship
	if rel == "" {
		rel = "related"
	}
	meta := p.Metadata
	if len(meta) == 0 {
		meta = json.RawMessage("{}")
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ProfileObjectLink{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the record's type so the link's object_type_id is correct
	// and the record id is validated (tenant-scoped via RLS).
	var typeID string
	if err := tx.QueryRow(ctx, `
		SELECT object_type_id::text FROM custom_object_records WHERE id = $1::uuid`,
		p.ObjectRecordID).Scan(&typeID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ProfileObjectLink{}, ErrNotFound
		}
		return ProfileObjectLink{}, fmt.Errorf("resolve record type: %w", err)
	}

	row := tx.QueryRow(ctx, `
		INSERT INTO profile_object_links
		       (tenant_id, object_type_id, object_record_id, subscriber_id, relationship, metadata)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb)
		RETURNING id::text, tenant_id::text, object_type_id::text, object_record_id::text,
		          COALESCE(subscriber_id::text, ''), COALESCE(subscriber_email, ''),
		          relationship, COALESCE(metadata::text, '{}'), created_at`,
		tenantID, typeID, p.ObjectRecordID, subscriberID, rel, string(meta))
	link, err := scanProfileLink(row)
	if err != nil {
		if isUniqueViolation(err) {
			return ProfileObjectLink{}, ErrConflict
		}
		return ProfileObjectLink{}, err
	}
	return link, tx.Commit(ctx)
}

// UpdateProfileLink patches a link's relationship and/or metadata. Both
// are optional (nil/absent → unchanged). ErrNotFound when the link id is
// unknown for the tenant.
func (s *pgStore) UpdateProfileLink(ctx context.Context, tenantID, linkID string, p UpdateProfileLinkParams) (ProfileObjectLink, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ProfileObjectLink{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// COALESCE-based partial update: pass NULL for an untouched field so
	// the existing column value is kept.
	var relArg any
	if p.Relationship != nil {
		relArg = *p.Relationship
	}
	var metaArg any
	if len(p.Metadata) > 0 {
		metaArg = string(p.Metadata)
	}
	row := tx.QueryRow(ctx, `
		UPDATE profile_object_links
		   SET relationship = COALESCE($2, relationship),
		       metadata     = COALESCE($3::jsonb, metadata)
		 WHERE id = $1::uuid
		 RETURNING id::text, tenant_id::text, object_type_id::text, object_record_id::text,
		           COALESCE(subscriber_id::text, ''), COALESCE(subscriber_email, ''),
		           relationship, COALESCE(metadata::text, '{}'), created_at`,
		linkID, relArg, metaArg)
	link, err := scanProfileLink(row)
	if err != nil {
		return ProfileObjectLink{}, err
	}
	return link, tx.Commit(ctx)
}

// DeleteProfileLink unlinks a record from a profile. ErrNotFound when the
// link id is unknown for the tenant.
func (s *pgStore) DeleteProfileLink(ctx context.Context, tenantID, linkID string) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ct, err := tx.Exec(ctx, `DELETE FROM profile_object_links WHERE id = $1::uuid`, linkID)
	if err != nil {
		return fmt.Errorf("delete profile_object_links: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// scanProfileLink scans the 9-column base projection (no join columns).
func scanProfileLink(r row) (ProfileObjectLink, error) {
	var l ProfileObjectLink
	var meta string
	if err := r.Scan(&l.ID, &l.TenantID, &l.ObjectTypeID, &l.ObjectRecordID,
		&l.SubscriberID, &l.SubscriberEmail, &l.Relationship, &meta, &l.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ProfileObjectLink{}, ErrNotFound
		}
		return ProfileObjectLink{}, fmt.Errorf("scan profile_object_link: %w", err)
	}
	if meta != "" {
		l.Metadata = json.RawMessage(meta)
	}
	return l, nil
}

// scanProfileLinkJoined scans the 13-column listing projection (base +
// type key/label + record external_id/properties).
func scanProfileLinkJoined(r row) (ProfileObjectLink, error) {
	var l ProfileObjectLink
	var meta, props string
	if err := r.Scan(&l.ID, &l.TenantID, &l.ObjectTypeID, &l.ObjectRecordID,
		&l.SubscriberID, &l.SubscriberEmail, &l.Relationship, &meta, &l.CreatedAt,
		&l.ObjectTypeKey, &l.ObjectTypeLabel, &l.ExternalID, &props); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ProfileObjectLink{}, ErrNotFound
		}
		return ProfileObjectLink{}, fmt.Errorf("scan profile_object_link (joined): %w", err)
	}
	if meta != "" {
		l.Metadata = json.RawMessage(meta)
	}
	if props != "" {
		l.Properties = json.RawMessage(props)
	}
	return l, nil
}
