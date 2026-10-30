// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// ErrNotFound is returned when no row matches a valid tenant-scoped id. A
// malformed id is ErrInvalidID instead.
var ErrNotFound = errors.New("collection not found")

// ErrInvalidID distinguishes a malformed collection identifier from a valid
// UUID that is absent (or hidden by tenant RLS). Handlers map these to 400 and
// 404 respectively.
var ErrInvalidID = errors.New("invalid collection id")

// ErrNameConflict is returned when a tenant already owns a collection with
// the same trimmed, case-insensitive name.
var ErrNameConflict = errors.New("collection name already exists")

var ErrStale = errors.New("collection changed after it was read")

var ErrInvalidVersion = errors.New("collection expected version is invalid")

// Repo is the Postgres-backed reference_collections store. Every method
// binds app.tenant_id via db.WithTenant before touching the RLS-protected
// table.
type Repo struct {
	Pool *db.Pool
}

// collectionColumns is the single source of truth for the projected
// columns, shared by every SELECT + RETURNING clause. Keep in lockstep
// with scanCollection's Scan order.
const collectionColumns = `id::text, tenant_id::text, name, collection_type, source_type, data, created_at, updated_at, version`

// ListOptions is the bounded keyset contract for metadata-only collection
// lists. Confidential row bodies are available only through tenant-scoped Get.
type ListOptions struct {
	Limit          int
	Query          string
	CollectionType string
	Cursor         pagination.Cursor
}

// Create inserts a new collection and returns the persisted row.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Collection, error) {
	in, err := normalizeCreateInput(in)
	if err != nil {
		return nil, err
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion != 0 {
		return nil, ErrInvalidVersion
	}
	dataRaw, err := marshalData(in.Data)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO reference_collections (tenant_id, name, collection_type, source_type, data)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
RETURNING `+collectionColumns,
		tenantID, in.Name, in.CollectionType, in.SourceType, dataRaw)
	c, err := scanCollection(row)
	if err != nil {
		return nil, mapWriteError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// List returns one stable newest-first page plus an exact tenant total. The
// default/normal path projects row_count instead of reading jsonb row bodies.
func (r *Repo) List(ctx context.Context, tenantID string, opts ListOptions) (*ListPage, error) {
	opts, err := normalizeListOptions(opts)
	if err != nil {
		return nil, err
	}
	maxLimit := MaxListLimit
	defaultLimit := DefaultListLimit
	if opts.Limit <= 0 {
		opts.Limit = defaultLimit
	}
	if opts.Limit > maxLimit {
		opts.Limit = maxLimit
	}
	if opts.Cursor.ID != "" {
		parsedID, err := uuid.Parse(opts.Cursor.ID)
		if err != nil {
			return nil, pagination.ErrInvalidCursor
		}
		opts.Cursor.ID = parsedID.String()
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	filterSQL, filterArgs := collectionListFilters(tenantID, opts, false, 2)
	var total int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)
FROM reference_collections
WHERE `+filterSQL, filterArgs...).Scan(&total); err != nil {
		return nil, err
	}
	listFilterSQL, args := collectionListFilters(tenantID, opts, true, 3)
	args = append([]any{tenantID, opts.Limit + 1}, args[1:]...)
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, collection_type, source_type,
       CASE WHEN jsonb_typeof(data) = 'array' THEN jsonb_array_length(data) ELSE 0 END,
       created_at, updated_at, version
FROM reference_collections
WHERE `+listFilterSQL+`
ORDER BY created_at DESC, id DESC
LIMIT $2`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanCollectionSummaries(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	items, hasMore := pagination.HasMore(items, opts.Limit)
	nextCursor := ""
	if hasMore {
		last := items[len(items)-1]
		nextCursor = encodeCollectionCursor(last, opts, tenantID)
	}
	return &ListPage{Items: items, Total: total, NextCursor: nextCursor}, nil
}

func collectionListFilters(tenantID string, opts ListOptions, includeCursor bool, firstDynamicPlaceholder int) (string, []any) {
	clauses := []string{"tenant_id = $1::uuid"}
	args := []any{tenantID}
	nextPlaceholder := firstDynamicPlaceholder
	if opts.Query != "" {
		clauses = append(clauses, fmt.Sprintf("lower(name) LIKE lower($%d) ESCAPE E'\\\\'", nextPlaceholder))
		args = append(args, "%"+escapeLikeLiteral(opts.Query)+"%")
		nextPlaceholder++
	}
	if opts.CollectionType != "" {
		clauses = append(clauses, fmt.Sprintf("collection_type = $%d", nextPlaceholder))
		args = append(args, opts.CollectionType)
		nextPlaceholder++
	}
	if includeCursor && opts.Cursor.ID != "" {
		clauses = append(clauses, fmt.Sprintf("(created_at, id) < ($%d::timestamptz, $%d::uuid)", nextPlaceholder, nextPlaceholder+1))
		args = append(args, opts.Cursor.SortKey.UTC(), opts.Cursor.ID)
	}
	return strings.Join(clauses, " AND "), args
}

func escapeLikeLiteral(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

// Get returns one collection by id. ErrNotFound when no row matches.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Collection, error) {
	id, err := normalizeCollectionID(id)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+collectionColumns+`
FROM reference_collections
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	c, err := scanCollection(row)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// Update patches the mutable fields. A nil pointer leaves the column
// untouched; an explicit value writes it. Data is replaced only when
// in.dataSet is true (set by the handler when the request carried a "data"
// key). ErrNotFound when no row matches.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Collection, error) {
	id, err := normalizeCollectionID(id)
	if err != nil {
		return nil, err
	}
	in, err = normalizeUpdateInput(in)
	if err != nil {
		return nil, err
	}
	var dataArg any
	if in.dataSet {
		raw, err := marshalData(in.Data)
		if err != nil {
			return nil, err
		}
		dataArg = raw
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		return nil, ErrInvalidVersion
	}
	var currentVersion int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM reference_collections WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
		tenantID, id).Scan(&currentVersion); err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if currentVersion != *in.ExpectedVersion {
		return nil, ErrStale
	}
	row := tx.QueryRow(ctx, `
UPDATE reference_collections SET
    name            = COALESCE($3, name),
    collection_type = COALESCE($4, collection_type),
    source_type     = COALESCE($5, source_type),
    data            = CASE WHEN $6::boolean THEN $7::jsonb ELSE data END,
    updated_at      = now(),
    version         = version + 1
WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $8
RETURNING `+collectionColumns,
		tenantID, id, in.Name, in.CollectionType, in.SourceType, in.dataSet, dataArg, *in.ExpectedVersion)
	c, err := scanCollection(row)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, mapWriteError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// Delete removes a collection by id. ErrNotFound when no row matched.
func (r *Repo) Delete(ctx context.Context, tenantID, id string, expectedVersion int64) (int64, error) {
	id, err := normalizeCollectionID(id)
	if err != nil {
		return 0, err
	}
	if expectedVersion <= 0 {
		return 0, ErrInvalidVersion
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentVersion int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM reference_collections WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
		tenantID, id).Scan(&currentVersion); err != nil {
		if isNotFound(err) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if currentVersion != expectedVersion {
		return 0, ErrStale
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM reference_collections WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $3`, tenantID, id, expectedVersion)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return currentVersion + 1, nil
}

func isNotFound(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

func mapWriteError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	if pgErr.Code == "23505" && pgErr.ConstraintName == "reference_collections_tenant_name_uidx" {
		return ErrNameConflict
	}
	if pgErr.Code == "23514" {
		switch pgErr.ConstraintName {
		case "reference_collections_name_length_check":
			return &inputValidationError{Code: "invalid_name", Message: "name violates the persisted text-safety limits"}
		case "reference_collections_data_shape_check":
			return &inputValidationError{Code: "invalid_data", Message: "data violates the persisted shape or compact encoded-size limits"}
		}
	}
	return err
}

func normalizeCollectionID(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil || id != parsed.String() {
		return "", ErrInvalidID
	}
	return parsed.String(), nil
}

// marshalData serialises the rows array to a jsonb-ready string. A nil
// slice becomes the empty array "[]" (never SQL NULL).
func marshalData(rows []RowValue) (string, error) {
	if rows == nil {
		return "[]", nil
	}
	b, err := marshalCollectionJSON(rows)
	if err != nil {
		return "", fmt.Errorf("marshal data: %w", err)
	}
	return string(b), nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanCollection(row scanner) (*Collection, error) {
	var c Collection
	var dataRaw []byte
	if err := row.Scan(&c.ID, &c.TenantID, &c.Name, &c.CollectionType, &c.SourceType, &dataRaw, &c.CreatedAt, &c.UpdatedAt, &c.Version); err != nil {
		return nil, err
	}
	if err := validateCollectionMetadata(c); err != nil {
		return nil, fmt.Errorf("stored collection metadata violates contract: %w", err)
	}
	c.Data = []RowValue{}
	if len(dataRaw) > 0 && string(dataRaw) != "null" {
		decoder := json.NewDecoder(bytes.NewReader(dataRaw))
		decoder.UseNumber()
		if err := decoder.Decode(&c.Data); err != nil {
			return nil, fmt.Errorf("decode data: %w", err)
		}
	}
	if err := validateRows(c.Data); err != nil {
		return nil, fmt.Errorf("stored collection data violates contract: %w", err)
	}
	c.RowCount = len(c.Data)
	return &c, nil
}

func scanCollectionSummaries(rows pgx.Rows) ([]Collection, error) {
	defer rows.Close()
	out := []Collection{}
	for rows.Next() {
		var c Collection
		if err := rows.Scan(
			&c.ID,
			&c.TenantID,
			&c.Name,
			&c.CollectionType,
			&c.SourceType,
			&c.RowCount,
			&c.CreatedAt,
			&c.UpdatedAt,
			&c.Version,
		); err != nil {
			return nil, err
		}
		if err := validateCollectionMetadata(c); err != nil {
			return nil, fmt.Errorf("stored collection metadata violates contract: %w", err)
		}
		c.Data = []RowValue{}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func validateCollectionMetadata(c Collection) error {
	if _, err := normalizeCollectionID(c.ID); err != nil {
		return err
	}
	if _, err := uuid.Parse(c.TenantID); err != nil {
		return errors.New("invalid tenant id")
	}
	if err := validateName(c.Name); err != nil {
		return err
	}
	if !isValidCollectionType(string(c.CollectionType)) {
		return errors.New("invalid collection type")
	}
	if !isValidSourceType(string(c.SourceType)) {
		return errors.New("invalid source type")
	}
	if c.RowCount < 0 || c.RowCount > MaxRows {
		return fmt.Errorf("invalid row count %d", c.RowCount)
	}
	if c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() {
		return errors.New("collection timestamps are required")
	}
	if c.Version <= 0 {
		return errors.New("collection version must be positive")
	}
	if c.UpdatedAt.Before(c.CreatedAt) {
		return errors.New("updated_at must not precede created_at")
	}
	return nil
}
