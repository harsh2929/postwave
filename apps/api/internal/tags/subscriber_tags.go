package tags

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SubscriberTagsRepo is the normalised (subscriber, tag) join store
// added in migration 0244. It complements the legacy subscribers.tags
// text[] column (which is still maintained by dual-write) and answers
// the questions the legacy shape could not:
//
//   - who applied this tag, when, from which surface (audit/history);
//   - how many subscribers carry tag X without unnest+GROUP BY;
//   - atomic apply/remove that survives concurrent UPDATEs.
//
// All methods run inside db.WithTenant so RLS clamps the read/write
// to the calling tenant.
type SubscriberTagsRepo struct {
	Pool *db.Pool
	// History is the optional audit emitter (migration 0263). When set,
	// Apply/Remove/ApplyByName/RemoveByName write a tag_history row
	// inside the same tx as the mutation.
	History *History
}

// SubscriberTag is a single join row in projection form.
type SubscriberTag struct {
	TagID        string    `json:"tag_id"`
	TagName      string    `json:"tag_name"`
	SubscriberID string    `json:"subscriber_id"`
	AppliedAt    time.Time `json:"applied_at"`
	AppliedBy    string    `json:"applied_by,omitempty"`
	Source       string    `json:"source"`
}

// SubscriberWithTag is the projection returned by ListSubscribersForTag.
type SubscriberWithTag struct {
	SubscriberID string    `json:"subscriber_id"`
	Email        string    `json:"email"`
	AppliedAt    time.Time `json:"applied_at"`
	Source       string    `json:"source"`
}

// Apply inserts (subscriber, tag) idempotently with provenance. source
// is one of: "manual", "api", "import", "automation", "backfill",
// "trigger" — handler should pick the closest match.
func (r *SubscriberTagsRepo) Apply(ctx context.Context, tenantID, subscriberID, tagID, appliedBy, source string) error {
	if strings.TrimSpace(source) == "" {
		source = "manual"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, applied_by, source)
VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid, $5)
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING`,
		tenantID, subscriberID, tagID, appliedBy, source)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() > 0 && r.History != nil {
		_ = r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagID:        tagID,
			SubscriberID: subscriberID,
			Action:       ActionTagAdded,
			Source:       source,
			ActorID:      appliedBy,
		})
	}
	return tx.Commit(ctx)
}

// Remove deletes the (subscriber, tag) row. No error if it didn't exist.
func (r *SubscriberTagsRepo) Remove(ctx context.Context, tenantID, subscriberID, tagID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
DELETE FROM subscriber_tags
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND tag_id = $3::uuid`, tenantID, subscriberID, tagID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() > 0 && r.History != nil {
		_ = r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagID:        tagID,
			SubscriberID: subscriberID,
			Action:       ActionTagRemoved,
			Source:       "manual",
		})
	}
	return tx.Commit(ctx)
}

// ListForSubscriber returns the tags this subscriber carries via the
// join, joined to the registry for display fields. Ordered by applied_at
// DESC so the most recent surface appears first.
func (r *SubscriberTagsRepo) ListForSubscriber(ctx context.Context, tenantID, subscriberID string) ([]SubscriberTag, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT st.tag_id::text,
       t.name::text,
       st.subscriber_id::text,
       st.applied_at,
       COALESCE(st.applied_by::text, ''),
       st.source
  FROM subscriber_tags st
  JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid
   AND st.subscriber_id = $2::uuid
 ORDER BY st.applied_at DESC, t.name`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriberTag{}
	for rows.Next() {
		var s SubscriberTag
		if err := rows.Scan(&s.TagID, &s.TagName, &s.SubscriberID, &s.AppliedAt, &s.AppliedBy, &s.Source); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListSubscribersForTag returns subscribers carrying a tag, newest-
// application first. Limit clamped by caller.
func (r *SubscriberTagsRepo) ListSubscribersForTag(ctx context.Context, tenantID, tagID string, limit int) ([]SubscriberWithTag, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT st.subscriber_id::text,
       s.email::text,
       st.applied_at,
       st.source
  FROM subscriber_tags st
  JOIN subscribers s ON s.tenant_id = st.tenant_id AND s.id = st.subscriber_id
 WHERE st.tenant_id = $1::uuid
   AND st.tag_id    = $2::uuid
 ORDER BY st.applied_at DESC
 LIMIT $3`, tenantID, tagID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriberWithTag{}
	for rows.Next() {
		var s SubscriberWithTag
		if err := rows.Scan(&s.SubscriberID, &s.Email, &s.AppliedAt, &s.Source); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ResolveByName returns the tag id for a name in this tenant, creating
// the row if it doesn't exist. Used by the dual-write path so legacy
// text labels can flow through to the join with FK integrity intact.
func (r *SubscriberTagsRepo) ResolveByName(ctx context.Context, tenantID, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("tag name required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, err := resolveTagIDInTx(ctx, tx, tenantID, name)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// resolveTagIDInTx finds-or-creates a tag id inside an existing tenant-
// scoped tx. Exported as a package helper so other repos can do the
// dual-write in their own transactions without opening a second one.
func resolveTagIDInTx(ctx context.Context, tx pgx.Tx, tenantID, name string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
WITH ins AS (
  INSERT INTO tags (tenant_id, name)
  VALUES ($1::uuid, $2::citext)
  ON CONFLICT (tenant_id, name) DO NOTHING
  RETURNING id::text
)
SELECT id FROM ins
UNION ALL
SELECT id::text FROM tags WHERE tenant_id = $1::uuid AND name = $2::citext
LIMIT 1`, tenantID, name).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, nil
}

// ApplyByName resolves the tag id (creating the registry row if
// missing) and inserts the join row in a single tx. This is the
// canonical entry point for legacy "apply tag <text>" call sites that
// still operate on the text[] column — they call this alongside the
// array update so both surfaces stay in lockstep.
func (r *SubscriberTagsRepo) ApplyByName(ctx context.Context, tenantID, subscriberID, name, appliedBy, source string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("tag name required")
	}
	if strings.TrimSpace(source) == "" {
		source = "manual"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tagID, err := resolveTagIDInTx(ctx, tx, tenantID, name)
	if err != nil {
		return "", err
	}
	cmd, err := tx.Exec(ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, applied_by, source)
VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid, $5)
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING`,
		tenantID, subscriberID, tagID, appliedBy, source)
	if err != nil {
		return "", err
	}
	if cmd.RowsAffected() > 0 && r.History != nil {
		_ = r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagID:        tagID,
			TagName:      name,
			SubscriberID: subscriberID,
			Action:       ActionTagAdded,
			Source:       source,
			ActorID:      appliedBy,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tagID, nil
}

// RemoveByName resolves the tag id and removes the join row. No-op if
// the tag or join row doesn't exist.
func (r *SubscriberTagsRepo) RemoveByName(ctx context.Context, tenantID, subscriberID, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
DELETE FROM subscriber_tags
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND tag_id IN (
     SELECT id FROM tags
      WHERE tenant_id = $1::uuid AND name = $3::citext
   )`, tenantID, subscriberID, name)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() > 0 && r.History != nil {
		_ = r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagName:      name,
			SubscriberID: subscriberID,
			Action:       ActionTagRemoved,
			Source:       "manual",
		})
	}
	return tx.Commit(ctx)
}
