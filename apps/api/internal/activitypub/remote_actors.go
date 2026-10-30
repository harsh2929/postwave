// Package activitypub — persisted remote actor cache.
//
// When a remote actor sends us a Follow, the v1 inbox handler stores
// the actor URL verbatim from the envelope's `actor` field but never
// dereferences it. That means we have no:
//
//   - icon/display_name to render on the admin "Followers" panel
//     (today we fall back to the raw URL),
//   - sharedInbox URL to coalesce multi-follower deliveries on one
//     host into a single POST,
//   - publicKey to verify inbound signed activities.
//
// The cache repository is retained for a future, separately reviewed
// inbound-federation release. No public inbox or network dereferencer is
// registered in this release, so attacker-controlled actor URLs cannot
// trigger outbound traffic.

package activitypub

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RemoteActor is the in-memory projection of an activitypub_remote_actors row.
type RemoteActor struct {
	ID             string    `json:"id"`
	TenantID       string    `json:"tenantId"`
	ActorURL       string    `json:"actorUrl"`
	InboxURL       string    `json:"inboxUrl,omitempty"`
	SharedInboxURL string    `json:"sharedInboxUrl,omitempty"`
	DisplayName    string    `json:"displayName,omitempty"`
	Handle         string    `json:"handle,omitempty"`
	IconURL        string    `json:"iconUrl,omitempty"`
	Summary        string    `json:"summary,omitempty"`
	PublicKeyPEM   string    `json:"publicKeyPem,omitempty"`
	PublicKeyID    string    `json:"publicKeyId,omitempty"`
	FetchFailures  int       `json:"fetchFailures"`
	LastFetchError string    `json:"lastFetchError,omitempty"`
	LastFetchedAt  time.Time `json:"lastFetchedAt,omitempty"`
}

// DefaultRemoteActorTTL is how long a cache row is considered fresh
// before the fetch worker re-dereferences. Mirrors Mastodon's own
// 7-day refresh cycle.
const DefaultRemoteActorTTL = 7 * 24 * time.Hour

// MaxRemoteActorFetchFailures gates the soft-fail counter. After N
// consecutive failures the row is skipped until manually re-enabled.
const MaxRemoteActorFetchFailures = 5

// UpsertRemoteActor writes (or updates) a cache row. Called from the
// inbox handler the first time we see a remote actor, and from the
// background refresh worker on TTL expiry.
//
// Empty optional fields are kept as NULL (NULLIF), so a partial fetch
// (e.g. profile fields only, no key) does not overwrite a populated
// publicKeyPem.
func (r *Repo) UpsertRemoteActor(ctx context.Context, tenantID string, a RemoteActor) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO activitypub_remote_actors (
    tenant_id, actor_url,
    inbox_url, shared_inbox_url,
    display_name, handle, icon_url, summary,
    public_key_pem, public_key_id,
    fetch_failures, last_fetch_error, last_fetched_at
) VALUES (
    $1::uuid, $2,
    NULLIF($3, ''), NULLIF($4, ''),
    NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
    NULLIF($9, ''), NULLIF($10, ''),
    0, NULL, now()
)
ON CONFLICT (tenant_id, actor_url) DO UPDATE
   SET inbox_url        = COALESCE(EXCLUDED.inbox_url, activitypub_remote_actors.inbox_url),
       shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, activitypub_remote_actors.shared_inbox_url),
       display_name     = COALESCE(EXCLUDED.display_name, activitypub_remote_actors.display_name),
       handle           = COALESCE(EXCLUDED.handle, activitypub_remote_actors.handle),
       icon_url         = COALESCE(EXCLUDED.icon_url, activitypub_remote_actors.icon_url),
       summary          = COALESCE(EXCLUDED.summary, activitypub_remote_actors.summary),
       public_key_pem   = COALESCE(EXCLUDED.public_key_pem, activitypub_remote_actors.public_key_pem),
       public_key_id    = COALESCE(EXCLUDED.public_key_id, activitypub_remote_actors.public_key_id),
       fetch_failures   = 0,
       last_fetch_error = NULL,
       last_fetched_at  = now(),
       updated_at       = now()`,
		tenantID, a.ActorURL,
		a.InboxURL, a.SharedInboxURL,
		a.DisplayName, a.Handle, a.IconURL, a.Summary,
		a.PublicKeyPEM, a.PublicKeyID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordRemoteActorFetchFailure bumps the soft-fail counter on a cache
// row. The fetch worker calls this on network/parse error so a
// repeatedly-failing actor eventually stops being retried.
func (r *Repo) RecordRemoteActorFetchFailure(ctx context.Context, tenantID, actorURL, errMsg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE activitypub_remote_actors
   SET fetch_failures   = fetch_failures + 1,
       last_fetch_error = $3,
       last_fetched_at  = now(),
       updated_at       = now()
 WHERE tenant_id = $1::uuid AND actor_url = $2`,
		tenantID, actorURL, errMsg); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetRemoteActor reads a single cache row by URL. Returns ErrNotFound
// when the actor has not been cached yet (caller should issue a fetch).
func (r *Repo) GetRemoteActor(ctx context.Context, tenantID, actorURL string) (*RemoteActor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var a RemoteActor
	var lastFetched *time.Time
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, actor_url,
       COALESCE(inbox_url, ''), COALESCE(shared_inbox_url, ''),
       COALESCE(display_name, ''), COALESCE(handle, ''),
       COALESCE(icon_url, ''), COALESCE(summary, ''),
       COALESCE(public_key_pem, ''), COALESCE(public_key_id, ''),
       fetch_failures, COALESCE(last_fetch_error, ''), last_fetched_at
  FROM activitypub_remote_actors
 WHERE tenant_id = $1::uuid AND actor_url = $2
 LIMIT 1`, tenantID, actorURL).Scan(
		&a.ID, &a.TenantID, &a.ActorURL,
		&a.InboxURL, &a.SharedInboxURL,
		&a.DisplayName, &a.Handle, &a.IconURL, &a.Summary,
		&a.PublicKeyPEM, &a.PublicKeyID,
		&a.FetchFailures, &a.LastFetchError, &lastFetched,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if lastFetched != nil {
		a.LastFetchedAt = *lastFetched
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &a, nil
}

// IsStale returns true when the cache row is past its TTL or has
// never been fetched. Used by the refresh worker's "what to fetch
// next" query.
func (a RemoteActor) IsStale(ttl time.Duration) bool {
	if a.LastFetchedAt.IsZero() {
		return true
	}
	return time.Since(a.LastFetchedAt) > ttl
}
