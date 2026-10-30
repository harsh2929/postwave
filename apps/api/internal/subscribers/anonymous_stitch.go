// SUB-003 — Anonymous-to-known stitching.
//
// Companion to identify.go. When an /subscribers/identify call carries an
// anonymous_id, the activity accrued under that anonymous_id (keyed under a
// bounded hash-derived @no-email.invalid placeholder) must be
// merged onto the now-known profile, the anonymous_id recorded as a
// profile alias, and the pre-identification activity replayed for triggers
// within a 72h backward window.
//
// stitchAnonymous does the in-transaction part (alias persistence + event
// reparenting + anonymous-profile bookkeeping). The trigger replay itself is
// driven post-commit by internal/trigger_replayer, wired from the handler.

package subscribers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// stitchAnonymous reparents pre-identification activity for in.AnonymousID
// onto the (subscriberID, email) profile resolved by Identify, records the
// anonymous_id → subscriber link in subscriber_anonymous_profiles, and
// persists the anonymous_id alias on profile_aliases. No-op when the call
// carries no anonymous_id. Runs inside the caller's open tenant-scoped tx.
//
// Best-effort on the optional tables: a deployment that hasn't applied
// migration 0451 (subscriber_anonymous_profiles) still functions — the
// event reparent + alias persistence (which depend only on long-standing
// tables) succeed and the anonymous-profile bookkeeping is skipped.
func (r *Repo) stitchAnonymous(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, email string, in IdentifyInput) error {
	if in.AnonymousID == "" || subscriberID == "" || email == "" {
		return nil
	}

	// 1. Reparent any events keyed under the anonymous placeholder onto the
	//    known email so the timeline + trigger replay see one stream. The
	//    UNIQUE on subscriber_events is on id (bigserial), so a plain UPDATE
	//    cannot collide.
	placeholders := []string{
		anonymousPlaceholderEmail(in.AnonymousID),
		legacyAnonymousPlaceholderEmail(in.AnonymousID),
	}
	if err := repointProjectedSubscriberEvents(
		ctx, tx, tenantID, placeholders, email,
		projectionMutationAnonymousStitch,
	); err != nil {
		return err
	}

	// 2. Persist the anonymous_id alias. ON CONFLICT mirrors UpsertAlias's
	//    (tenant_id, alias_type, lower(alias_value)) unique index so a
	//    repeated identify is idempotent and reassigns the alias to the
	//    surviving subscriber.
	if _, err := tx.Exec(ctx, `
INSERT INTO profile_aliases
    (tenant_id, subscriber_id, alias_type, alias_value, confidence, source, provenance)
VALUES ($1::uuid, $2::uuid, 'anonymous_id', $3, 1.0, 'identify', '{}'::jsonb)
ON CONFLICT (tenant_id, alias_type, lower(alias_value)) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    last_seen_at = now(),
    updated_at = now()
 WHERE profile_aliases.alias_value = EXCLUDED.alias_value`,
		tenantID, subscriberID, in.AnonymousID); err != nil {
		return err
	}

	// 3. Record / advance the anonymous-profile registry row (SUB-003,
	//    migration 0451). Tolerate the table being absent (pre-0451) so the
	//    stitch still succeeds on older schemas.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_anonymous_profiles
    (tenant_id, anonymous_id, subscriber_id, identified_at)
VALUES ($1::uuid, $2, $3::uuid, now())
ON CONFLICT (tenant_id, anonymous_id) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    identified_at = COALESCE(subscriber_anonymous_profiles.identified_at, EXCLUDED.identified_at),
    updated_at = now()`,
		tenantID, in.AnonymousID, subscriberID); err != nil {
		if !isUndefinedTable(err) {
			return err
		}
	}
	return nil
}

// AnonymousProfile is a row of the SUB-003 pre-identification registry.
type AnonymousProfile struct {
	AnonymousID  string     `json:"anonymous_id"`
	SubscriberID *string    `json:"subscriber_id,omitempty"`
	IdentifiedAt *time.Time `json:"identified_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// LookupAnonymousAliases returns the anonymous_id alias values currently
// stitched to the given subscriber (via profile_aliases). Used by the
// identify path + tests to confirm a stitch landed.
func (r *Repo) LookupAnonymousAliases(ctx context.Context, tenantID, subscriberID string) ([]string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT alias_value
  FROM profile_aliases
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND alias_type = 'anonymous_id'
 ORDER BY last_seen_at DESC`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ReparentAnonymousEvents moves subscriber_events keyed under an anonymous
// placeholder address onto a known email, in its own tenant-scoped tx.
// Exposed for callers (and tests) that need the reparent without the full
// identify flow. Returns the number of events moved.
func (r *Repo) ReparentAnonymousEvents(ctx context.Context, tenantID, anonymousID, toEmail string) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	placeholders := []string{
		anonymousPlaceholderEmail(anonymousID),
		legacyAnonymousPlaceholderEmail(anonymousID),
	}
	var affected int64
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_repoint_subscriber_events(
       $2::uuid, $3::citext[], $1::citext,
       'anonymous_stitch', gen_random_uuid()
	  )`, toEmail, tenantID, placeholders).Scan(&affected)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return affected, nil
}
