// SPDX-License-Identifier: AGPL-3.0-only
//
// store.go — Postgres-backed CRUD over custom_object_types and
// custom_object_records. Every read/write opens a tenant-scoped
// tx via db.WithTenant so the RLS policies on both tables enforce
// the boundary.

package customobjects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is the canonical "missing row" sentinel.
var ErrNotFound = errors.New("customobjects: not found")

// ErrConflict surfaces a (tenant, type, key) UNIQUE violation so the
// handler can return a 409 instead of a generic 500.
var ErrConflict = errors.New("customobjects: conflict")

// ErrStale is returned when a mutation's expectedVersion no longer matches.
// It deliberately covers both changed and create-only-already-exists cases so
// callers cannot use conflict details as a cross-tenant existence oracle.
var ErrStale = errors.New("customobjects: stale version")

// ErrConfirmationMismatch means the caller named the right row version but
// did not repeat the immutable human-visible identifier required for deletion.
var ErrConfirmationMismatch = errors.New("customobjects: confirmation mismatch")

// ErrTypeDisabled prevents writes through a type explicitly taken offline.
var ErrTypeDisabled = errors.New("customobjects: type disabled")

// Store is the interface both the Postgres impl and the in-memory
// test fake implement. Memory impl ships in store_memory.go.
type Store interface {
	ListTypes(ctx context.Context, tenantID string) ([]ObjectType, error)
	GetType(ctx context.Context, tenantID, id string) (ObjectType, error)
	GetTypeByKey(ctx context.Context, tenantID, key string) (ObjectType, error)
	CreateType(ctx context.Context, tenantID string, p CreateTypeParams) (ObjectType, error)
	UpdateType(ctx context.Context, tenantID, id string, p UpdateTypeParams) (ObjectType, error)
	DeleteType(ctx context.Context, tenantID, id string, p DeleteTypeParams) error

	ListRecords(ctx context.Context, tenantID, typeID string, f ListRecordsFilter) (RecordPage, error)
	GetRecord(ctx context.Context, tenantID, recordID string) (Record, error)
	UpsertRecord(ctx context.Context, tenantID, typeID string, p UpsertRecordParams) (Record, error)
	DeleteRecord(ctx context.Context, tenantID, recordID string, p DeleteRecordParams) error

	// Profile object links (SUB-011) — bind custom object records to a
	// subscriber profile via profile_object_links (migration 0201).
	ListProfileLinks(ctx context.Context, tenantID, subscriberID string) ([]ProfileObjectLink, error)
	CreateProfileLink(ctx context.Context, tenantID, subscriberID string, p CreateProfileLinkParams) (ProfileObjectLink, error)
	UpdateProfileLink(ctx context.Context, tenantID, linkID string, p UpdateProfileLinkParams) (ProfileObjectLink, error)
	DeleteProfileLink(ctx context.Context, tenantID, linkID string) error
}

type pgStore struct {
	pool *db.Pool
}

// NewPostgresStore wraps the pgx pool in a Store. Returns an error
// when pool is nil so boot fails fast.
func NewPostgresStore(pool *db.Pool) (Store, error) {
	if pool == nil {
		return nil, errors.New("customobjects: nil pool")
	}
	return &pgStore{pool: pool}, nil
}

func (s *pgStore) ListTypes(ctx context.Context, tenantID string) ([]ObjectType, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, key, label, primary_key, COALESCE(schema::text, '{}'),
		       status, version, created_at, updated_at
		  FROM custom_object_types
		 ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list custom_object_types: %w", err)
	}
	defer rows.Close()
	out := []ObjectType{}
	for rows.Next() {
		o, err := scanType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate custom_object_types: %w", err)
	}
	return out, tx.Commit(ctx)
}

func (s *pgStore) GetType(ctx context.Context, tenantID, id string) (ObjectType, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, key, label, primary_key, COALESCE(schema::text, '{}'),
		       status, version, created_at, updated_at
		  FROM custom_object_types
		 WHERE id = $1::uuid`, id)
	o, err := scanType(row)
	if err != nil {
		return ObjectType{}, err
	}
	return o, tx.Commit(ctx)
}

func (s *pgStore) GetTypeByKey(ctx context.Context, tenantID, key string) (ObjectType, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, key, label, primary_key, COALESCE(schema::text, '{}'),
		       status, version, created_at, updated_at
		  FROM custom_object_types
		 WHERE key = $1`, key)
	o, err := scanType(row)
	if err != nil {
		return ObjectType{}, err
	}
	return o, tx.Commit(ctx)
}

func (s *pgStore) CreateType(ctx context.Context, tenantID string, p CreateTypeParams) (ObjectType, error) {
	auditMeta, err := mutationAuditMeta(ctx, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	if err := validateCreateTypeParams(&p); err != nil {
		return ObjectType{}, err
	}
	pk := p.PrimaryKey
	if pk == "" {
		pk = "external_id"
	}
	schema := p.Schema
	if len(schema) == 0 {
		schema = json.RawMessage("{}")
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO custom_object_types (tenant_id, key, label, primary_key, schema, status)
		VALUES ($1::uuid, $2, $3, $4, $5::jsonb, 'active')
		RETURNING id::text, tenant_id::text, key, label, primary_key, COALESCE(schema::text, '{}'),
		          status, version, created_at, updated_at`,
		tenantID, p.Key, p.Label, pk, string(schema))
	o, err := scanType(row)
	if err != nil {
		if isUniqueViolation(err) {
			return ObjectType{}, ErrConflict
		}
		return ObjectType{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "custom_object.type.create", "custom_object_type", o.ID, map[string]any{
		"key": o.Key, "status": o.Status,
	}); err != nil {
		return ObjectType{}, fmt.Errorf("audit custom_object type create: %w", err)
	}
	return o, tx.Commit(ctx)
}

func (s *pgStore) UpdateType(ctx context.Context, tenantID, id string, p UpdateTypeParams) (ObjectType, error) {
	auditMeta, err := mutationAuditMeta(ctx, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	if err := validateUpdateTypeParams(p); err != nil {
		return ObjectType{}, err
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return ObjectType{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var primaryKey string
	var currentVersion int64
	if err := tx.QueryRow(ctx, `
		SELECT primary_key, version
		  FROM custom_object_types
		 WHERE id = $1::uuid
		 FOR UPDATE`, id).Scan(&primaryKey, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ObjectType{}, ErrNotFound
		}
		return ObjectType{}, fmt.Errorf("lock custom_object_type for update: %w", err)
	}
	if currentVersion != p.ExpectedVersion {
		return ObjectType{}, ErrStale
	}
	if err := validateUpdatedSchemaPrimaryKey(primaryKey, p.Schema); err != nil {
		return ObjectType{}, err
	}
	row := tx.QueryRow(ctx, `
		UPDATE custom_object_types
		   SET label = $2, schema = $3::jsonb, status = $4, version = version + 1
		 WHERE id = $1::uuid AND version = $5
		 RETURNING id::text, tenant_id::text, key, label, primary_key, COALESCE(schema::text, '{}'),
		           status, version, created_at, updated_at`,
		id, p.Label, string(p.Schema), p.Status, p.ExpectedVersion)
	o, err := scanType(row)
	if err != nil {
		return ObjectType{}, err
	}
	if err := db.Audit(ctx, tx, auditMeta, "custom_object.type.update", "custom_object_type", o.ID, map[string]any{
		"status": o.Status, "version": o.Version,
	}); err != nil {
		return ObjectType{}, fmt.Errorf("audit custom_object type update: %w", err)
	}
	return o, tx.Commit(ctx)
}

func (s *pgStore) DeleteType(ctx context.Context, tenantID, id string, p DeleteTypeParams) error {
	auditMeta, err := mutationAuditMeta(ctx, tenantID)
	if err != nil {
		return err
	}
	if err := validateDeleteTypeParams(p); err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID string
	err = tx.QueryRow(ctx, `
		DELETE FROM custom_object_types
		 WHERE id = $1::uuid AND version = $2 AND key = $3
		 RETURNING id::text`, id, p.ExpectedVersion, p.ConfirmationKey).Scan(&deletedID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var version int64
			var key string
			probeErr := tx.QueryRow(ctx, `SELECT version, key FROM custom_object_types WHERE id = $1::uuid`, id).Scan(&version, &key)
			if errors.Is(probeErr, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if probeErr != nil {
				return fmt.Errorf("probe custom_object_type delete: %w", probeErr)
			}
			if version != p.ExpectedVersion {
				return ErrStale
			}
			return ErrConfirmationMismatch
		}
		return fmt.Errorf("delete custom_object_types: %w", err)
	}
	if err := db.Audit(ctx, tx, auditMeta, "custom_object.type.delete", "custom_object_type", deletedID, map[string]any{
		"cascade_records": true, "version": p.ExpectedVersion,
	}); err != nil {
		return fmt.Errorf("audit custom_object type delete: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *pgStore) ListRecords(ctx context.Context, tenantID, typeID string, f ListRecordsFilter) (RecordPage, error) {
	validated, err := validateListRecordsFilter(f)
	if err != nil {
		return RecordPage{}, err
	}
	limit := validated.Limit
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return RecordPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var typePresent bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM custom_object_types WHERE id = $1::uuid)`, typeID).Scan(&typePresent); err != nil {
		return RecordPage{}, fmt.Errorf("verify custom_object_type for record list: %w", err)
	}
	if !typePresent {
		return RecordPage{}, ErrNotFound
	}

	args := []any{typeID, limit + 1}
	q := `SELECT id::text, tenant_id::text, object_type_id::text, external_id,
	             COALESCE(properties::text, '{}'), version, created_at, updated_at
	        FROM custom_object_records
	       WHERE object_type_id = $1::uuid`
	if validated.PropertyKey != "" {
		args = append(args, validated.PropertyKey, validated.PropertyValue)
		q += fmt.Sprintf(" AND properties->>($%d) = $%d", len(args)-1, len(args))
	}
	q += " ORDER BY updated_at DESC, id DESC LIMIT $2"
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return RecordPage{}, fmt.Errorf("list custom_object_records: %w", err)
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return RecordPage{}, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return RecordPage{}, fmt.Errorf("iterate custom_object_records: %w", err)
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordPage{}, err
	}
	return RecordPage{Items: out, Limit: limit, HasMore: hasMore}, nil
}

func (s *pgStore) GetRecord(ctx context.Context, tenantID, recordID string) (Record, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, object_type_id::text, external_id,
		       COALESCE(properties::text, '{}'), version, created_at, updated_at
		  FROM custom_object_records
		 WHERE id = $1::uuid`, recordID)
	r, err := scanRecord(row)
	if err != nil {
		return Record{}, err
	}
	return r, tx.Commit(ctx)
}

func (s *pgStore) UpsertRecord(ctx context.Context, tenantID, typeID string, p UpsertRecordParams) (Record, error) {
	auditMeta, err := mutationAuditMeta(ctx, tenantID)
	if err != nil {
		return Record{}, err
	}
	if err := validateUpsertRecordParams(p); err != nil {
		return Record{}, err
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var typeStatus, typeSchema string
	if err := tx.QueryRow(ctx, `
		SELECT status, COALESCE(schema::text, '{}')
		  FROM custom_object_types
		 WHERE id = $1::uuid
		 FOR SHARE`, typeID).Scan(&typeStatus, &typeSchema); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Record{}, ErrNotFound
		}
		return Record{}, fmt.Errorf("read custom_object_type before record write: %w", err)
	}
	if typeStatus == "disabled" {
		return Record{}, ErrTypeDisabled
	}
	if validation := Validate(json.RawMessage(typeSchema), p.Properties); validation.HasErrors() {
		return Record{}, validation
	}

	var row pgx.Row
	action := "custom_object.record.create"
	if p.ExpectedVersion == 0 {
		row = tx.QueryRow(ctx, `
			INSERT INTO custom_object_records (tenant_id, object_type_id, external_id, properties)
			VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
			ON CONFLICT (tenant_id, object_type_id, external_id) DO NOTHING
			RETURNING id::text, tenant_id::text, object_type_id::text, external_id,
			          COALESCE(properties::text, '{}'), version, created_at, updated_at`,
			tenantID, typeID, p.ExternalID, string(p.Properties))
	} else {
		action = "custom_object.record.update"
		row = tx.QueryRow(ctx, `
			UPDATE custom_object_records
			   SET properties = $4::jsonb, version = version + 1
			 WHERE tenant_id = $1::uuid AND object_type_id = $2::uuid
			   AND external_id = $3 AND version = $5
			RETURNING id::text, tenant_id::text, object_type_id::text, external_id,
			          COALESCE(properties::text, '{}'), version, created_at, updated_at`,
			tenantID, typeID, p.ExternalID, string(p.Properties), p.ExpectedVersion)
	}
	r, err := scanRecord(row)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			return Record{}, err
		}
		var exists bool
		if probeErr := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM custom_object_records
				 WHERE object_type_id = $1::uuid AND external_id = $2
			)`, typeID, p.ExternalID).Scan(&exists); probeErr != nil {
			return Record{}, fmt.Errorf("probe custom_object_record write: %w", probeErr)
		}
		// Create-only conflicts and update version mismatches intentionally share
		// one response. Neither returns the current row or natural identifier.
		if exists || p.ExpectedVersion == 0 {
			return Record{}, ErrStale
		}
		return Record{}, ErrNotFound
	}
	if err := db.Audit(ctx, tx, auditMeta, action, "custom_object_record", r.ID, map[string]any{
		"object_type_id": r.ObjectTypeID, "version": r.Version,
	}); err != nil {
		return Record{}, fmt.Errorf("audit custom_object record write: %w", err)
	}
	return r, tx.Commit(ctx)
}

func (s *pgStore) DeleteRecord(ctx context.Context, tenantID, recordID string, p DeleteRecordParams) error {
	auditMeta, err := mutationAuditMeta(ctx, tenantID)
	if err != nil {
		return err
	}
	if err := validateDeleteRecordParams(p); err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID, typeID string
	err = tx.QueryRow(ctx, `
		DELETE FROM custom_object_records
		 WHERE id = $1::uuid AND version = $2 AND external_id = $3
		 RETURNING id::text, object_type_id::text`,
		recordID, p.ExpectedVersion, p.ConfirmationExternalID).Scan(&deletedID, &typeID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var version int64
			var externalID string
			probeErr := tx.QueryRow(ctx, `SELECT version, external_id FROM custom_object_records WHERE id = $1::uuid`, recordID).Scan(&version, &externalID)
			if errors.Is(probeErr, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if probeErr != nil {
				return fmt.Errorf("probe custom_object_record delete: %w", probeErr)
			}
			if version != p.ExpectedVersion {
				return ErrStale
			}
			return ErrConfirmationMismatch
		}
		return fmt.Errorf("delete custom_object_records: %w", err)
	}
	if err := db.Audit(ctx, tx, auditMeta, "custom_object.record.delete", "custom_object_record", deletedID, map[string]any{
		"object_type_id": typeID, "version": p.ExpectedVersion,
	}); err != nil {
		return fmt.Errorf("audit custom_object record delete: %w", err)
	}
	return tx.Commit(ctx)
}

// row is the union of QueryRow + Rows' Scan signature so scanType
// and scanRecord work for both single-row and iteration calls.
type row interface {
	Scan(dest ...any) error
}

func scanType(r row) (ObjectType, error) {
	var o ObjectType
	var schema string
	var createdAt, updatedAt time.Time
	if err := r.Scan(&o.ID, &o.TenantID, &o.Key, &o.Label, &o.PrimaryKey,
		&schema, &o.Status, &o.Version, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ObjectType{}, ErrNotFound
		}
		return ObjectType{}, fmt.Errorf("scan custom_object_type: %w", err)
	}
	if schema != "" {
		o.Schema = json.RawMessage(schema)
	}
	o.CreatedAt = createdAt
	o.UpdatedAt = updatedAt
	return o, nil
}

func scanRecord(r row) (Record, error) {
	var rec Record
	var props string
	var createdAt, updatedAt time.Time
	if err := r.Scan(&rec.ID, &rec.TenantID, &rec.ObjectTypeID, &rec.ExternalID,
		&props, &rec.Version, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Record{}, ErrNotFound
		}
		return Record{}, fmt.Errorf("scan custom_object_record: %w", err)
	}
	if props != "" {
		rec.Properties = json.RawMessage(props)
	}
	rec.CreatedAt = createdAt
	rec.UpdatedAt = updatedAt
	return rec, nil
}

// isUniqueViolation matches Postgres SQLSTATE 23505 (unique_violation).
// We rely on string match because importing pgconn for one error code
// would couple this package to a specific pgx subpackage when the
// rest of apps/api goes through db.* abstractions.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return contains(s, "23505") || contains(s, "duplicate key")
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
