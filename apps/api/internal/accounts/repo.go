// SPDX-License-Identifier: AGPL-3.0-only
package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned by Get/Update/Delete when no row matches the
// tenant-scoped id (or the id is malformed). Maps to 404 in the handler.
var ErrNotFound = errors.New("account not found")

// Repo is the Postgres-backed accounts store. Every method binds
// app.tenant_id via db.WithTenant before touching the RLS-protected
// accounts table.
type Repo struct {
	Pool *db.Pool
}

// accountColumns is the single source of truth for the projected columns,
// shared by every SELECT + RETURNING clause. Keep in lockstep with
// scanAccount's Scan order.
const accountColumns = `id::text, tenant_id::text, name, industry, country, metadata, created_at, updated_at`

// Create inserts a new account and returns the persisted row.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Account, error) {
	metaRaw, err := marshalMeta(in.Metadata)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO accounts (tenant_id, name, industry, country, metadata)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
RETURNING `+accountColumns,
		tenantID, in.Name, in.Industry, in.Country, metaRaw)
	a, err := scanAccount(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// List returns every account for the tenant, name-ordered, plus the total
// count (the count equals len(items) — there is no paging window today —
// but it's returned as a distinct field so a future paged List stays
// envelope-compatible).
func (r *Repo) List(ctx context.Context, tenantID string) (*ListPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+accountColumns+`
FROM accounts
WHERE tenant_id = $1::uuid
ORDER BY lower(name) ASC, created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	items, err := scanAccounts(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ListPage{Items: items, Total: len(items)}, nil
}

// Get returns one account by id. ErrNotFound when no row matches the
// tenant-scoped id (or the id is malformed).
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Account, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+accountColumns+`
FROM accounts
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	a, err := scanAccount(row)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// Update patches the mutable fields. A nil pointer leaves the column
// untouched; an explicit value (including "") writes it. A non-nil
// Metadata map replaces the whole blob; a nil map leaves it untouched.
// ErrNotFound when no row matches.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Account, error) {
	var metaArg any
	metaSet := in.Metadata != nil
	if metaSet {
		raw, err := marshalMeta(in.Metadata)
		if err != nil {
			return nil, err
		}
		metaArg = raw
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE accounts SET
    name     = COALESCE($3, name),
    industry = COALESCE($4, industry),
    country  = COALESCE($5, country),
    metadata = CASE WHEN $6::boolean THEN $7::jsonb ELSE metadata END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+accountColumns,
		tenantID, id, in.Name, in.Industry, in.Country, metaSet, metaArg)
	a, err := scanAccount(row)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// Delete removes an account by id. subscribers.account_id is ON DELETE SET
// NULL, so deleting an account orphans its contacts back to "unlinked"
// rather than cascading a contact delete. ErrNotFound when no row matched.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM accounts WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		if isNotFound(err) {
			return ErrNotFound
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// isNotFound maps pgx.ErrNoRows and the invalid-UUID-syntax pg error
// (22P02) to a not-found condition so a malformed id 404s rather than
// 500s.
func isNotFound(err error) bool {
	if errors.Is(err, pgx.ErrNoRows) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return true
	}
	return false
}

func marshalMeta(m map[string]any) (string, error) {
	if m == nil {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("marshal metadata: %w", err)
	}
	return string(b), nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanAccount(row scanner) (*Account, error) {
	var a Account
	var metaRaw []byte
	if err := row.Scan(&a.ID, &a.TenantID, &a.Name, &a.Industry, &a.Country, &metaRaw, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	a.Metadata = map[string]any{}
	if len(metaRaw) > 0 && string(metaRaw) != "null" {
		if err := json.Unmarshal(metaRaw, &a.Metadata); err != nil {
			return nil, fmt.Errorf("decode metadata: %w", err)
		}
	}
	return &a, nil
}

func scanAccounts(rows pgx.Rows) ([]Account, error) {
	defer rows.Close()
	out := []Account{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
