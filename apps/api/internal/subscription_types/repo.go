// SPDX-License-Identifier: AGPL-3.0-only
package subscription_types

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a subscription_type lookup misses.
var ErrNotFound = errors.New("subscription_types: not found")

// ErrNameConflict is returned when the UNIQUE (tenant_id, name) fires.
var ErrNameConflict = errors.New("subscription_types: name already in use")

// ErrCannotDeleteDefault is returned when delete is attempted on the
// only is_default=true row. We always keep at least one default per
// tenant so the preference center has something to render.
var ErrCannotDeleteDefault = errors.New("subscription_types: cannot delete the only default subscription type")

// Repo wraps the pgx pool with CRUD over subscription_types +
// subscription_type_opt_outs. All methods open their own db.WithTenant tx
// so the RLS policies (NULLIF(current_setting('app.tenant_id', true), ”)
// ::uuid) see the bound tenant.
type Repo struct {
	Pool *db.Pool
}

// ---------- subscription_types CRUD ----------

// List returns every row for the tenant, optionally filtered by channel.
// channel="" means no filter. Rows ordered by sort_order ASC, name ASC.
//
// Side effect: if the tenant has zero rows, we seed the two defaults
// ('Marketing emails' default=true, 'Product updates' default=false) so
// the preference center is always renderable. The seed is idempotent via
// the UNIQUE (tenant_id, name) constraint.
func (r *Repo) List(ctx context.Context, tenantID string, channel Channel) ([]SubscriptionType, error) {
	if err := r.seedDefaultsIfEmpty(ctx, tenantID); err != nil {
		return nil, err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, description, channel,
       is_default, is_internal, sort_order, created_at, updated_at
FROM subscription_types
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR channel = $2)
ORDER BY sort_order ASC, name ASC`, tenantID, string(channel))
	if err != nil {
		return nil, fmt.Errorf("subscription_types: list query: %w", err)
	}
	defer rows.Close()
	out := []SubscriptionType{}
	for rows.Next() {
		var s SubscriptionType
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.Channel,
			&s.IsDefault, &s.IsInternal, &s.SortOrder, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("subscription_types: list scan: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Get fetches a single subscription_type by id.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*SubscriptionType, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out, err := getByID(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Create inserts a new subscription_type. Defaults: channel='email'.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*SubscriptionType, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, fmt.Errorf("subscription_types: name required")
	}
	if in.Channel == "" {
		in.Channel = ChannelEmail
	}
	if !ValidChannels[in.Channel] {
		return nil, fmt.Errorf("subscription_types: invalid channel %q", in.Channel)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var s SubscriptionType
	row := tx.QueryRow(ctx, `
INSERT INTO subscription_types (tenant_id, name, description, channel, is_default, sort_order)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
RETURNING id::text, tenant_id::text, name, description, channel,
          is_default, is_internal, sort_order, created_at, updated_at`,
		tenantID, in.Name, in.Description, string(in.Channel), in.IsDefault, in.SortOrder)
	if err := row.Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.Channel,
		&s.IsDefault, &s.IsInternal, &s.SortOrder, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrNameConflict
		}
		return nil, fmt.Errorf("subscription_types: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// Update applies a sparse patch.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*SubscriptionType, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := getByID(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
		if cur.Name == "" {
			return nil, fmt.Errorf("subscription_types: name cannot be empty")
		}
	}
	if in.Description != nil {
		cur.Description = *in.Description
	}
	if in.Channel != nil {
		if !ValidChannels[*in.Channel] {
			return nil, fmt.Errorf("subscription_types: invalid channel %q", *in.Channel)
		}
		cur.Channel = *in.Channel
	}
	if in.IsDefault != nil {
		cur.IsDefault = *in.IsDefault
	}
	if in.SortOrder != nil {
		cur.SortOrder = *in.SortOrder
	}

	row := tx.QueryRow(ctx, `
UPDATE subscription_types SET
    name = $1,
    description = $2,
    channel = $3,
    is_default = $4,
    sort_order = $5,
    updated_at = now()
WHERE id = $6::uuid
RETURNING updated_at`,
		cur.Name, cur.Description, string(cur.Channel), cur.IsDefault, cur.SortOrder, id)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if isUniqueViolation(err) {
			return nil, ErrNameConflict
		}
		return nil, fmt.Errorf("subscription_types: update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cur, nil
}

// Delete removes a subscription_type. Refuses to drop the last default
// row so the preference center always has at least one default
// subscription to render.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := getByID(ctx, tx, id)
	if err != nil {
		return err
	}
	if cur.IsDefault {
		var defaults int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM subscription_types
              WHERE tenant_id = $1::uuid AND is_default = true`,
			tenantID,
		).Scan(&defaults); err != nil {
			return fmt.Errorf("subscription_types: count defaults: %w", err)
		}
		if defaults <= 1 {
			return ErrCannotDeleteDefault
		}
	}

	tag, err := tx.Exec(ctx, `DELETE FROM subscription_types WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("subscription_types: delete: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ---------- per-subscriber opt-out ledger ----------

// ListForSubscriber returns one row per subscription_type with the
// subscriber's opt-out state. The LEFT JOIN keeps every type even when
// the subscriber has never interacted with it.
func (r *Repo) ListForSubscriber(ctx context.Context, tenantID, subscriberID string) ([]SubscriberView, error) {
	if err := r.seedDefaultsIfEmpty(ctx, tenantID); err != nil {
		return nil, err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT t.id::text, t.tenant_id::text, t.name, t.description, t.channel,
       t.is_default, t.is_internal, t.sort_order, t.created_at, t.updated_at,
       o.opted_out_at, COALESCE(o.source, ''), COALESCE(o.channel, '')
FROM subscription_types t
LEFT JOIN subscription_type_opt_outs o
       ON o.tenant_id = t.tenant_id
      AND o.subscription_type_id = t.id
      AND o.subscriber_id = $2::uuid
WHERE t.tenant_id = $1::uuid
ORDER BY t.sort_order ASC, t.name ASC`, tenantID, subscriberID)
	if err != nil {
		return nil, fmt.Errorf("subscription_types: list-for-subscriber: %w", err)
	}
	defer rows.Close()

	out := []SubscriberView{}
	for rows.Next() {
		var (
			v   SubscriberView
			src string
			ch  string
		)
		if err := rows.Scan(
			&v.Type.ID, &v.Type.TenantID, &v.Type.Name, &v.Type.Description,
			&v.Type.Channel, &v.Type.IsDefault, &v.Type.IsInternal,
			&v.Type.SortOrder, &v.Type.CreatedAt, &v.Type.UpdatedAt,
			&v.OptedOutAt, &src, &ch,
		); err != nil {
			return nil, fmt.Errorf("subscription_types: list-for-subscriber scan: %w", err)
		}
		v.OptedOut = v.OptedOutAt != nil
		if v.OptedOut {
			v.Source = OptOutSource(src)
			v.Channel = Channel(ch)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// OptOut inserts an opt-out row idempotently. When `in.Channel` is empty
// it falls back to the subscription type's channel. When `in.Source` is
// empty it defaults to api. Returns the resulting SubscriberView so the
// caller can mirror the new state immediately.
func (r *Repo) OptOut(ctx context.Context, tenantID, subscriberID, typeID string, in OptOutInput) (*SubscriberView, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	st, err := getByID(ctx, tx, typeID)
	if err != nil {
		return nil, err
	}
	channel := in.Channel
	if channel == "" {
		channel = st.Channel
	}
	if !ValidChannels[channel] {
		return nil, fmt.Errorf("subscription_types: invalid channel %q", channel)
	}
	source := in.Source
	if source == "" {
		source = SourceAPI
	}
	if !validOptOutSources[source] {
		return nil, fmt.Errorf("subscription_types: invalid source %q", source)
	}

	// ON CONFLICT does an UPDATE of source/source_event_id but leaves
	// opted_out_at untouched so the original opt-out moment is preserved.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscription_type_opt_outs
    (tenant_id, subscriber_id, subscription_type_id, channel, source, source_event_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULLIF($6, ''))
ON CONFLICT (tenant_id, subscriber_id, subscription_type_id, channel) DO UPDATE
SET source = EXCLUDED.source,
    source_event_id = COALESCE(EXCLUDED.source_event_id, subscription_type_opt_outs.source_event_id)`,
		tenantID, subscriberID, typeID, string(channel), string(source), in.SourceEventID,
	); err != nil {
		return nil, fmt.Errorf("subscription_types: opt-out insert: %w", err)
	}

	v := SubscriberView{Type: *st, OptedOut: true, Channel: channel, Source: source}
	if err := tx.QueryRow(ctx, `
SELECT opted_out_at FROM subscription_type_opt_outs
WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
  AND subscription_type_id = $3::uuid AND channel = $4`,
		tenantID, subscriberID, typeID, string(channel),
	).Scan(&v.OptedOutAt); err != nil {
		return nil, fmt.Errorf("subscription_types: opt-out re-read: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &v, nil
}

// OptIn removes the opt-out row, i.e. the subscriber goes back to the
// default "opted in" state. Channel defaults to the type's channel when
// empty. Returns nil whether or not a row existed (callers don't care).
func (r *Repo) OptIn(ctx context.Context, tenantID, subscriberID, typeID string, channel Channel) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if channel == "" {
		st, err := getByID(ctx, tx, typeID)
		if err != nil {
			return err
		}
		channel = st.Channel
	}
	if !ValidChannels[channel] {
		return fmt.Errorf("subscription_types: invalid channel %q", channel)
	}

	if _, err := tx.Exec(ctx, `
DELETE FROM subscription_type_opt_outs
WHERE tenant_id = $1::uuid
  AND subscriber_id = $2::uuid
  AND subscription_type_id = $3::uuid
  AND channel = $4`,
		tenantID, subscriberID, typeID, string(channel),
	); err != nil {
		return fmt.Errorf("subscription_types: opt-in delete: %w", err)
	}
	return tx.Commit(ctx)
}

// ---------- internals ----------

// seedDefaultsIfEmpty inserts the two default subscription types for a
// tenant on first List call. Idempotent via UNIQUE (tenant_id, name).
// Migration 0247 already does this for existing tenants + has a trigger
// for new ones; the runtime seed is belt-and-suspenders for tenants
// whose seed got rolled back (e.g. trigger disabled during a restore).
func (r *Repo) seedDefaultsIfEmpty(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM subscription_types WHERE tenant_id = $1::uuid`,
		tenantID,
	).Scan(&n); err != nil {
		return fmt.Errorf("subscription_types: seed count: %w", err)
	}
	if n > 0 {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscription_types (tenant_id, name, description, channel, is_default, sort_order)
VALUES
    ($1::uuid, 'Marketing emails',
     'Promotional emails, newsletters, and product announcements.',
     'email', true, 10),
    ($1::uuid, 'Product updates',
     'Release notes, changelogs, and feature launches.',
     'email', false, 20)
ON CONFLICT (tenant_id, name) DO NOTHING`, tenantID); err != nil {
		return fmt.Errorf("subscription_types: seed insert: %w", err)
	}
	return tx.Commit(ctx)
}

// getByID rehydrates a single subscription_type row inside an existing tx.
func getByID(ctx context.Context, tx pgx.Tx, id string) (*SubscriptionType, error) {
	var s SubscriptionType
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, channel,
       is_default, is_internal, sort_order, created_at, updated_at
FROM subscription_types WHERE id = $1::uuid`, id)
	if err := row.Scan(&s.ID, &s.TenantID, &s.Name, &s.Description, &s.Channel,
		&s.IsDefault, &s.IsInternal, &s.SortOrder, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("subscription_types: get-by-id: %w", err)
	}
	return &s, nil
}

func isUniqueViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}
