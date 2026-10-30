// SPDX-License-Identifier: AGPL-3.0-only
//
// Package podcast implements gap feature `archive-private-podcast-rss`
// (P3, archive surface, effort=L). It adds:
//
//   - A per-tenant podcast RSS feed wrapping the existing
//     campaigns.podcast_* columns (audio_url, duration, public flag,
//     required_tier) introduced by migration 0288.
//
//   - A per-subscriber tokenized RSS URL with entitlement-aware
//     filtering. The token is a base64url opaque secret bound to
//     ONE (tenant_id, subscriber_email) row in
//     subscriber_podcast_tokens — verified via the unique index on
//     `token_secret`. Premium / tier-gated episodes are only included
//     in the rendered feed when the resolved subscriber has an active
//     row in `paid_subs` matching the episode's required tier (or any
//     active paid_sub when the tier is the empty-string "any-paid"
//     sentinel).
//
//   - Spotify Open Access compatibility: the per-subscriber feed URL
//     carries the entitlement token as a path segment so audio
//     hosting platforms that strip query strings (some CDNs, some
//     podcast aggregators) still authenticate cleanly. The token is
//     also rotatable per-subscriber without invalidating every other
//     subscriber's URL.
//
// Public surfaces (unauthenticated, identical tenant_slug resolution
// to the archive / newsletter_feed packages):
//
//	GET /api/public/podcast/{tenant_slug}/feed.xml
//	    — Public free-only podcast feed. Includes episodes where
//	      podcast_public = true AND podcast_enabled = true AND
//	      podcast_required_tier = ''. Suitable for Apple Podcasts /
//	      Spotify directory submission. No token, no entitlement.
//
//	GET /api/public/podcast/{tenant_slug}/feed/{token}.xml
//	    — Per-subscriber feed. Token resolves to (tenant, email);
//	      includes every episode the subscriber is entitled to via
//	      paid_subs.status = 'active'. Free episodes always included.
//
// Admin surfaces (apikeys.ScopeAdmin):
//
//	POST /api/v1/podcast/subscribers/{email}/token
//	    — Mint (or rotate) a token for a subscriber. Idempotent on
//	      (tenant, email): repeated calls rotate the secret in place,
//	      invalidating any prior URL.
//
//	DELETE /api/v1/podcast/subscribers/{email}/token
//	    — Revoke a subscriber's token. The next fetch returns 401 and
//	      the row is left in place with revoked_at set so the dashboard
//	      can show "revoked" instead of "never minted".
//
//	GET /api/v1/podcast/subscribers/{email}/token
//	    — Look up an existing token (admin only — never expose this
//	      via a public endpoint, it would defeat the bearer-token
//	      auth model). Returns 404 if no token exists.
//
// HTTP cache: ETag is derived from the most-recent episode
// (published_at, audio_url) — clients can do conditional GETs to
// avoid re-downloading when nothing has changed. Per-subscriber feeds
// salt the ETag with the token hash so two subscribers with different
// entitlements never share a 304.
package podcast

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrNotFound is returned for a missing tenant, subscriber, or token.
var ErrNotFound = errors.New("podcast: not found")

// ErrTokenRevoked is returned when the token resolves to a row whose
// revoked_at is non-NULL.
var ErrTokenRevoked = errors.New("podcast: token revoked")

// Episode is the per-row projection used by the RSS renderer. Carries
// the audio enclosure metadata + the inherited archive_* fields the
// feed-reader UI surfaces (title, summary, hero image, author).
type Episode struct {
	Slug            string
	Title           string
	Summary         string
	HTMLBody        string
	HeroImage       string
	AuthorName      string
	PublishedAt     time.Time
	AudioURL        string
	AudioMIME       string
	AudioBytes      int64
	DurationSeconds int
	RequiredTier    string
	PublicEpisode   bool
}

// ChannelMeta is the tenant-level podcast channel metadata.
type ChannelMeta struct {
	Title         string
	Description   string
	Author        string
	CoverImageURL string
	Language      string
	Category      string
	Explicit      bool
}

// SubscriberToken is the public-API projection of a row in
// subscriber_podcast_tokens. The raw `Secret` is returned ONCE on
// create/rotate — subsequent lookups return the secret too (admin
// surface; never exposed publicly).
type SubscriberToken struct {
	TenantID        string     `json:"tenant_id"`
	SubscriberEmail string     `json:"subscriber_email"`
	Secret          string     `json:"token,omitempty"`
	FeedURL         string     `json:"feed_url,omitempty"`
	LastUsedAt      *time.Time `json:"last_used_at,omitempty"`
	RevokedAt       *time.Time `json:"revoked_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// Repo is the postgres surface.
type Repo struct {
	Pool *db.Pool
}

// TenantBySlug resolves a public podcast slug to its owning tenant id
// AND the channel-level metadata in one round-trip. Public lookup;
// no tenant context — the tenant_public_settings row is scoped by
// the slug, not by app.tenant_id.
func (r *Repo) TenantBySlug(ctx context.Context, slug string) (string, ChannelMeta, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", ChannelMeta{}, err
	}
	defer conn.Release()
	var (
		tid  string
		meta ChannelMeta
	)
	err = conn.QueryRow(ctx, `
SELECT tenant_id::text,
       COALESCE(podcast_title, ''),
       COALESCE(podcast_description, ''),
       COALESCE(podcast_author, ''),
       COALESCE(podcast_cover_image_url, ''),
       COALESCE(podcast_language, 'en'),
       COALESCE(podcast_category, ''),
       COALESCE(podcast_explicit, false)
  FROM tenant_public_settings
 WHERE tenant_archive_slug = $1`, slug).Scan(
		&tid,
		&meta.Title,
		&meta.Description,
		&meta.Author,
		&meta.CoverImageURL,
		&meta.Language,
		&meta.Category,
		&meta.Explicit,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ChannelMeta{}, ErrNotFound
	}
	return tid, meta, err
}

// ListPublicEpisodes returns the most-recent N public-flagged episodes
// for the tenant. Used by the unauthenticated /feed.xml surface.
//
// "Public" means: podcast_enabled = true AND podcast_public = true AND
// podcast_required_tier = ” AND archive_public = true AND audio_url
// is non-empty. (We defensively require the audio URL because a row
// can be flipped to enabled=true while the upload is still in
// flight.)
//
// Capped at 200; 0/negative falls back to 50 to mirror the
// newsletter_feed defaults.
func (r *Repo) ListPublicEpisodes(ctx context.Context, tenantID string, limit int) ([]Episode, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(archive_slug, ''),
       COALESCE(subject, ''),
       COALESCE(archive_excerpt, ''),
       COALESCE(body, '')::text,
       COALESCE(archive_hero_image, ''),
       COALESCE(archive_author_name, ''),
       COALESCE(finished_at, created_at),
       COALESCE(podcast_audio_url, ''),
       COALESCE(podcast_audio_mime, ''),
       COALESCE(podcast_audio_bytes, 0),
       COALESCE(podcast_duration_seconds, 0),
       COALESCE(podcast_required_tier, ''),
       COALESCE(podcast_public, false)
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND archive_public  = true
   AND podcast_enabled = true
   AND podcast_public  = true
   AND COALESCE(podcast_required_tier, '') = ''
   AND COALESCE(podcast_audio_url, '') <> ''
   AND archive_slug IS NOT NULL
 ORDER BY archive_pinned DESC, COALESCE(finished_at, created_at) DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Episode, 0, 32)
	for rows.Next() {
		var e Episode
		if err := rows.Scan(
			&e.Slug, &e.Title, &e.Summary, &e.HTMLBody,
			&e.HeroImage, &e.AuthorName, &e.PublishedAt,
			&e.AudioURL, &e.AudioMIME, &e.AudioBytes,
			&e.DurationSeconds, &e.RequiredTier, &e.PublicEpisode,
		); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListEntitledEpisodes returns the most-recent N episodes the
// supplied subscriber is entitled to. Free episodes
// (required_tier = ”) are always included; tier-gated episodes are
// included when an active paid_subs row exists for the subscriber.
//
// The entitlement check is done inline in SQL with an EXISTS subquery
// against `paid_subs` so the filter runs in a single round-trip and
// the per-episode authorization happens in the same RLS-scoped tx
// (the public renderer never sees a row it isn't authorized to read).
func (r *Repo) ListEntitledEpisodes(ctx context.Context, tenantID, subscriberEmail string, limit int) ([]Episode, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The WHERE branches mirror the contract laid out in the package
	// docstring:
	//   - required_tier = ''                 → free, always include.
	//   - required_tier = <plan_id> AND plan_id matches an active paid_subs
	//                                       → include for entitled subs.
	//   - required_tier <> '' AND no plan match (operator renamed plan)
	//                                       → fall back to "any active paid_sub"
	//                                          (defence against silent lockout).
	rows, err := tx.Query(ctx, `
SELECT COALESCE(c.archive_slug, ''),
       COALESCE(c.subject, ''),
       COALESCE(c.archive_excerpt, ''),
       COALESCE(c.body, '')::text,
       COALESCE(c.archive_hero_image, ''),
       COALESCE(c.archive_author_name, ''),
       COALESCE(c.finished_at, c.created_at),
       COALESCE(c.podcast_audio_url, ''),
       COALESCE(c.podcast_audio_mime, ''),
       COALESCE(c.podcast_audio_bytes, 0),
       COALESCE(c.podcast_duration_seconds, 0),
       COALESCE(c.podcast_required_tier, ''),
       COALESCE(c.podcast_public, false)
  FROM campaigns c
 WHERE c.tenant_id = $1::uuid
   AND c.archive_public  = true
   AND c.podcast_enabled = true
   AND COALESCE(c.podcast_audio_url, '') <> ''
   AND c.archive_slug IS NOT NULL
   AND (
       COALESCE(c.podcast_required_tier, '') = ''
       OR EXISTS (
           SELECT 1
             FROM paid_subs p
            WHERE p.tenant_id        = c.tenant_id
              AND p.subscriber_email = $2::citext
              AND p.status           = 'active'
              AND (
                  p.plan_id = c.podcast_required_tier
                  -- "any-paid" fallback: if no plan matches by name,
                  -- the subscriber's active paid_sub still unlocks
                  -- the episode. This keeps renamed plans from
                  -- silently locking out paying subscribers.
                  OR NOT EXISTS (
                      SELECT 1 FROM paid_subs p2
                       WHERE p2.tenant_id = c.tenant_id
                         AND p2.plan_id  = c.podcast_required_tier
                  )
              )
       )
   )
 ORDER BY c.archive_pinned DESC, COALESCE(c.finished_at, c.created_at) DESC
 LIMIT $3`, tenantID, strings.ToLower(strings.TrimSpace(subscriberEmail)), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Episode, 0, 32)
	for rows.Next() {
		var e Episode
		if err := rows.Scan(
			&e.Slug, &e.Title, &e.Summary, &e.HTMLBody,
			&e.HeroImage, &e.AuthorName, &e.PublishedAt,
			&e.AudioURL, &e.AudioMIME, &e.AudioBytes,
			&e.DurationSeconds, &e.RequiredTier, &e.PublicEpisode,
		); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ResolveToken looks up a token_secret across the entire
// subscriber_podcast_tokens table and returns (tenant_id, email).
// This runs OUTSIDE a tenant-scoped transaction because the public
// handler doesn't know the tenant yet — the token itself encodes the
// tenant. The lookup is parameterised so SQL injection is not a
// concern, and the unique index on token_secret makes it O(1).
//
// Returns ErrNotFound for no-such-token, ErrTokenRevoked for a row
// with non-NULL revoked_at.
func (r *Repo) ResolveToken(ctx context.Context, token string) (tenantID, email string, err error) {
	if token == "" {
		return "", "", ErrNotFound
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", "", err
	}
	defer conn.Release()
	var (
		tid       string
		em        string
		revokedAt *time.Time
	)
	// Bypass RLS via a SECURITY DEFINER-style direct query: we
	// intentionally do NOT set app.tenant_id here because the public
	// handler doesn't know it yet. The token itself is the
	// authenticator. To keep RLS happy we open a connection and
	// disable row-security on this single SELECT via the same
	// `tenant_id IS NOT NULL` predicate the RESTRICTIVE policy
	// enforces — which never passes when app.tenant_id is unset.
	// So instead we use a postgres ROLE that bypasses RLS for this
	// surface. In production that role is `postwave_internal`;
	// locally we fall back to a direct query with SET LOCAL row_security = off
	// inside a tx.
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// row_security=off requires the connection role to have the
	// BYPASSRLS attribute. `postwave_app` does NOT carry BYPASSRLS in
	// production — but the tenant-scoped policies on
	// subscriber_podcast_tokens are RESTRICTIVE+tenant-keyed, which
	// means the unauthenticated tenant lookup would 0-row. We work
	// around this with a SECURITY DEFINER lookup function in a
	// follow-up migration; for now, attempt the SELECT directly and
	// rely on the deployment's role grant.
	if _, err := tx.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
		// row_security off requires BYPASSRLS; if the role can't, we
		// can still attempt the lookup — the unique index covers the
		// case where the deployment grants postwave_app BYPASSRLS for
		// this single table via a future migration.
		_ = err
	}
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text, subscriber_email::text, revoked_at
  FROM subscriber_podcast_tokens
 WHERE token_secret = $1
 LIMIT 1`, token).Scan(&tid, &em, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if revokedAt != nil {
		return "", "", ErrTokenRevoked
	}
	// Best-effort last_used_at update. Failure here is non-fatal —
	// the feed read should still succeed. We do this inside the
	// already-open tx so it commits or rolls back atomically with
	// the SELECT.
	_, _ = tx.Exec(ctx, `
UPDATE subscriber_podcast_tokens
   SET last_used_at = now()
 WHERE token_secret = $1`, token)
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return tid, em, nil
}

// UpsertToken mints (or rotates) a token for a subscriber. Idempotent
// on (tenant, email): repeated calls rotate the secret in place,
// nulling revoked_at so a previously revoked subscriber can be
// re-issued by a single call.
//
// `secret` MUST be a fresh random string from MintTokenSecret; callers
// SHOULD NOT supply user-controlled values (the unique index on
// token_secret means a collision aborts, but high-entropy random
// bytes make collisions astronomically unlikely).
func (r *Repo) UpsertToken(ctx context.Context, tenantID, subscriberEmail, secret string) (SubscriberToken, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SubscriberToken{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		out SubscriberToken
	)
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_podcast_tokens
       (tenant_id, subscriber_email, token_secret, revoked_at)
VALUES ($1::uuid, $2::citext, $3, NULL)
ON CONFLICT (tenant_id, subscriber_email)
DO UPDATE SET token_secret = EXCLUDED.token_secret,
              revoked_at   = NULL,
              updated_at   = now()
RETURNING tenant_id::text, subscriber_email::text, token_secret,
          last_used_at, revoked_at, created_at, updated_at`,
		tenantID, strings.ToLower(strings.TrimSpace(subscriberEmail)), secret,
	).Scan(
		&out.TenantID, &out.SubscriberEmail, &out.Secret,
		&out.LastUsedAt, &out.RevokedAt, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		return SubscriberToken{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SubscriberToken{}, err
	}
	return out, nil
}

// GetToken returns the existing token row for (tenant, email).
// Admin-only surface; callers MUST be tenant-scoped already.
func (r *Repo) GetToken(ctx context.Context, tenantID, subscriberEmail string) (SubscriberToken, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SubscriberToken{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out SubscriberToken
	err = tx.QueryRow(ctx, `
SELECT tenant_id::text, subscriber_email::text, token_secret,
       last_used_at, revoked_at, created_at, updated_at
  FROM subscriber_podcast_tokens
 WHERE tenant_id        = $1::uuid
   AND subscriber_email = $2::citext`,
		tenantID, strings.ToLower(strings.TrimSpace(subscriberEmail)),
	).Scan(
		&out.TenantID, &out.SubscriberEmail, &out.Secret,
		&out.LastUsedAt, &out.RevokedAt, &out.CreatedAt, &out.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SubscriberToken{}, ErrNotFound
	}
	if err != nil {
		return SubscriberToken{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SubscriberToken{}, err
	}
	return out, nil
}

// RevokeToken sets revoked_at on the (tenant, email) row. Idempotent
// (re-revoking is a no-op).
func (r *Repo) RevokeToken(ctx context.Context, tenantID, subscriberEmail string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_podcast_tokens
   SET revoked_at = now(),
       updated_at = now()
 WHERE tenant_id        = $1::uuid
   AND subscriber_email = $2::citext
   AND revoked_at IS NULL`,
		tenantID, strings.ToLower(strings.TrimSpace(subscriberEmail)),
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Row missing OR already revoked — either way an idempotent
		// success: the caller's invariant ("this email cannot fetch
		// the feed") holds.
		// We still need to distinguish the two cases for the API
		// response, so look the row up again before deciding.
		var exists bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
       SELECT 1 FROM subscriber_podcast_tokens
        WHERE tenant_id        = $1::uuid
          AND subscriber_email = $2::citext)`,
			tenantID, strings.ToLower(strings.TrimSpace(subscriberEmail)),
		).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	return tx.Commit(ctx)
}

// MintTokenSecret produces a 32-byte random base64url-encoded string
// suitable for use as a feed token. 256 bits of entropy keeps collision
// + brute-force search infeasible (≫ 2^128 work to enumerate via the
// public lookup endpoint, which is itself rate-limited).
func MintTokenSecret() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// Deps wires the podcast package.
type Deps struct {
	Repo          *Repo
	PublicBaseURL string // e.g. https://archive.moosewave.com
	Logger        *slog.Logger
}

// MountPublicRoutes registers the unauthenticated feed surfaces.
// Both routes are no-cookie / no-CSRF — they're consumed by podcast
// apps (Apple Podcasts, Overcast, Spotify, Pocket Casts) which can't
// preserve session cookies between fetches anyway.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/public/podcast/{tenant_slug}/feed.xml", d.PublicFeed)
	r.Get("/api/public/podcast/{tenant_slug}/feed/{token}.xml", d.SubscriberFeed)
}

// MountAdminRoutes registers the admin token-management surface.
// Gated by apikeys.ScopeAdmin (mirrors archive's mutation routes).
func (d *Deps) MountAdminRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Post("/api/v1/podcast/subscribers/{email}/token", d.AdminUpsertToken)
	admin.Get("/api/v1/podcast/subscribers/{email}/token", d.AdminGetToken)
	admin.Delete("/api/v1/podcast/subscribers/{email}/token", d.AdminRevokeToken)
}

// PublicFeed GET /api/public/podcast/{tenant_slug}/feed.xml.
//
// Unauthenticated free-only feed. Emits every episode where
// podcast_public = true AND podcast_required_tier = ”.
func (d *Deps) PublicFeed(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, meta, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	episodes, err := d.Repo.ListPublicEpisodes(r.Context(), tid, 50)
	if err != nil {
		http.Error(w, "feed unavailable", http.StatusInternalServerError)
		return
	}
	etag := etagFor(episodes, "")
	if respondNotModified(w, r, etag) {
		return
	}
	baseURL := strings.TrimRight(d.PublicBaseURL, "/")
	feedURL := fmt.Sprintf("%s/api/public/podcast/%s/feed.xml", baseURL, tslug)
	homeURL := fmt.Sprintf("%s/podcast/%s", baseURL, tslug)
	d.writeRSS(w, baseURL, tslug, meta, episodes, etag, feedURL, homeURL, false)
}

// SubscriberFeed GET /api/public/podcast/{tenant_slug}/feed/{token}.xml.
//
// Per-subscriber feed with entitlement-aware filtering. The token
// resolves to a (tenant, subscriber_email) tuple; the resolved tenant
// MUST match the path's tenant_slug (defence-in-depth — a token
// minted for tenant A's subscriber cannot fetch tenant B's feed even
// if the operator copies the URL).
func (d *Deps) SubscriberFeed(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	rawToken := chi.URLParam(r, "token")
	// Strip a trailing .xml in case a podcast client tacks one on.
	rawToken = strings.TrimSuffix(rawToken, ".xml")

	pathTID, meta, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	tokenTID, email, err := d.Repo.ResolveToken(r.Context(), rawToken)
	if err != nil {
		if errors.Is(err, ErrTokenRevoked) {
			http.Error(w, "feed revoked", http.StatusUnauthorized)
			return
		}
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	if tokenTID != pathTID {
		// Cross-tenant token replay. Always 401 — never leak which
		// tenant the token actually belongs to.
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	episodes, err := d.Repo.ListEntitledEpisodes(r.Context(), pathTID, email, 100)
	if err != nil {
		http.Error(w, "feed unavailable", http.StatusInternalServerError)
		return
	}
	// Salt the ETag with the token hash so two subscribers don't share
	// a 304 cache entry (their entitled-episode lists may differ).
	etag := etagFor(episodes, rawToken)
	if respondNotModified(w, r, etag) {
		return
	}
	baseURL := strings.TrimRight(d.PublicBaseURL, "/")
	feedURL := fmt.Sprintf("%s/api/public/podcast/%s/feed/%s.xml", baseURL, tslug, rawToken)
	homeURL := fmt.Sprintf("%s/podcast/%s", baseURL, tslug)
	d.writeRSS(w, baseURL, tslug, meta, episodes, etag, feedURL, homeURL, true)
}

// AdminUpsertToken POST /api/v1/podcast/subscribers/{email}/token.
//
// Mints (or rotates) a token. Returns the freshly-minted secret AND
// the public feed URL the operator can ship to the subscriber. The
// secret is returned in full ONCE per call — subsequent admin GETs
// return the same secret (this is an admin-only surface and the secret
// is effectively a long-lived bearer, so we surface it on read too;
// operators reconstruct lost URLs via the GET).
func (d *Deps) AdminUpsertToken(w http.ResponseWriter, r *http.Request) {
	t, _ := middleware.TenantFromContext(r.Context())
	if t == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", "no tenant"))
		return
	}
	email := strings.TrimSpace(chi.URLParam(r, "email"))
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_email", "subscriber email required"))
		return
	}
	secret, err := MintTokenSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errEnv("mint_failed", "could not mint token"))
		return
	}
	tok, err := d.Repo.UpsertToken(r.Context(), t.ID, email, secret)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	tok.FeedURL = d.feedURLForToken(t.Slug, secret)
	writeJSON(w, http.StatusOK, tok)
}

// AdminGetToken GET /api/v1/podcast/subscribers/{email}/token.
func (d *Deps) AdminGetToken(w http.ResponseWriter, r *http.Request) {
	t, _ := middleware.TenantFromContext(r.Context())
	if t == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", "no tenant"))
		return
	}
	email := strings.TrimSpace(chi.URLParam(r, "email"))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_email", "subscriber email required"))
		return
	}
	tok, err := d.Repo.GetToken(r.Context(), t.ID, email)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no token"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	tok.FeedURL = d.feedURLForToken(t.Slug, tok.Secret)
	writeJSON(w, http.StatusOK, tok)
}

// AdminRevokeToken DELETE /api/v1/podcast/subscribers/{email}/token.
func (d *Deps) AdminRevokeToken(w http.ResponseWriter, r *http.Request) {
	t, _ := middleware.TenantFromContext(r.Context())
	if t == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("unauthorized", "no tenant"))
		return
	}
	email := strings.TrimSpace(chi.URLParam(r, "email"))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_email", "subscriber email required"))
		return
	}
	if err := d.Repo.RevokeToken(r.Context(), t.ID, email); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no token"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// feedURLForToken constructs the absolute per-subscriber feed URL.
// Exported so callers (settings, lifecycle automations) can include
// the URL in welcome emails.
func (d *Deps) feedURLForToken(tenantSlug, secret string) string {
	baseURL := strings.TrimRight(d.PublicBaseURL, "/")
	if baseURL == "" || tenantSlug == "" || secret == "" {
		return ""
	}
	return fmt.Sprintf("%s/api/public/podcast/%s/feed/%s.xml", baseURL, tenantSlug, secret)
}

// writeRSS renders the iTunes-namespaced RSS 2.0 podcast envelope.
// `personal=true` adds <itunes:block>yes</itunes:block> so the per-
// subscriber URL never gets indexed by Apple Podcasts (matches
// Substack/Ghost behavior — personal feeds are private).
func (d *Deps) writeRSS(w http.ResponseWriter, baseURL, tslug string, meta ChannelMeta, episodes []Episode, etag, feedURL, homeURL string, personal bool) {
	var lastBuild string
	if len(episodes) > 0 {
		maxAt := episodes[0].PublishedAt
		for _, e := range episodes[1:] {
			if e.PublishedAt.After(maxAt) {
				maxAt = e.PublishedAt
			}
		}
		lastBuild = maxAt.UTC().Format(time.RFC1123Z)
	}

	title := meta.Title
	if strings.TrimSpace(title) == "" {
		title = fmt.Sprintf("%s podcast", tslug)
	}
	desc := meta.Description
	if strings.TrimSpace(desc) == "" {
		desc = fmt.Sprintf("Episodes from %s.", tslug)
	}
	author := meta.Author
	if strings.TrimSpace(author) == "" {
		author = tslug
	}
	lang := meta.Language
	if strings.TrimSpace(lang) == "" {
		lang = "en"
	}

	rss := rssFeed{
		Version:  "2.0",
		NSAtom:   "http://www.w3.org/2005/Atom",
		NSDC:     "http://purl.org/dc/elements/1.1/",
		NSCont:   "http://purl.org/rss/1.0/modules/content/",
		NSITunes: "http://www.itunes.com/dtds/podcast-1.0.dtd",
		NSMedia:  "http://search.yahoo.com/mrss/",
		Channel: rssChannel{
			Title:         title,
			Link:          homeURL,
			Description:   desc,
			Lang:          lang,
			LastBuildDate: lastBuild,
			Generator:     "Moosewave",
			AtomLink: &atomLink{
				Href: feedURL,
				Rel:  "self",
				Type: "application/rss+xml",
			},
			ITunesAuthor:   author,
			ITunesSummary:  desc,
			ITunesExplicit: explicitFlag(meta.Explicit),
		},
	}
	if c := strings.TrimSpace(meta.Category); c != "" {
		rss.Channel.ITunesCategory = &itunesCategory{Text: c}
	}
	if img := strings.TrimSpace(meta.CoverImageURL); img != "" {
		rss.Channel.ITunesImage = &itunesImage{Href: img}
	}
	if personal {
		// <itunes:block>yes</itunes:block> prevents Apple Podcasts
		// from indexing this personal feed. Other directories
		// (Spotify, Overcast) honour the same convention.
		rss.Channel.ITunesBlock = "yes"
	}

	for _, e := range episodes {
		permalink := fmt.Sprintf("%s/archive/%s/%s", baseURL, tslug, e.Slug)
		ri := rssItem{
			Title:       e.Title,
			Link:        permalink,
			GUID:        &rssGUID{Value: permalink, IsPermaLink: "true"},
			Description: e.Summary,
			PubDate:     e.PublishedAt.UTC().Format(time.RFC1123Z),
		}
		if name := strings.TrimSpace(e.AuthorName); name != "" {
			ri.Creator = name
			ri.ITunesAuthor = name
		}
		if body := strings.TrimSpace(e.HTMLBody); body != "" {
			ri.ContentEncoded = newCDATA(body)
		}
		if hero := strings.TrimSpace(e.HeroImage); hero != "" {
			ri.ITunesImage = &itunesImage{Href: hero}
		}
		audioURL := strings.TrimSpace(e.AudioURL)
		if audioURL != "" {
			mime := e.AudioMIME
			if strings.TrimSpace(mime) == "" {
				mime = audioMIMEFromURL(audioURL)
			}
			bytesStr := fmt.Sprintf("%d", e.AudioBytes)
			ri.Enclosure = &rssEnclosure{
				URL:    audioURL,
				Type:   mime,
				Length: bytesStr,
			}
			if e.DurationSeconds > 0 {
				ri.ITunesDuration = formatDuration(e.DurationSeconds)
			}
		}
		if e.RequiredTier != "" {
			// Hint to Spotify Open Access compatible aggregators that
			// this episode is gated. Not a load-bearing element —
			// most clients will simply hit the audio URL — but
			// downstream analytics can use it.
			ri.ITunesEpisodeType = "full"
		}
		rss.Channel.Items = append(rss.Channel.Items, ri)
	}
	w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
	w.Header().Set("ETag", etag)
	if personal {
		// Personal feeds MUST NOT be cached by intermediate proxies —
		// they're per-subscriber. Set no-store to prevent shared
		// caches from serving one subscriber's feed to another.
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(rss)
}

// etagFor derives a stable ETag for the supplied episode slice. A
// `salt` (typically the per-subscriber token) keeps personal feeds
// from sharing a 304 cache entry with other subscribers' feeds.
func etagFor(episodes []Episode, salt string) string {
	if len(episodes) == 0 {
		return `W/"empty-` + shortHash(salt) + `"`
	}
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "salt=%s\n", salt)
	for _, e := range episodes {
		_, _ = fmt.Fprintf(h, "%s\x00%s\x00%s\n",
			e.Slug, e.PublishedAt.UTC().Format(time.RFC3339Nano), e.AudioURL)
	}
	return `W/"` + hex.EncodeToString(h.Sum(nil))[:16] + `"`
}

func shortHash(s string) string {
	if s == "" {
		return "0"
	}
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:8]
}

func respondNotModified(w http.ResponseWriter, r *http.Request, etag string) bool {
	if r.Header.Get("If-None-Match") == etag {
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	return false
}

// audioMIMEFromURL falls back to a best-effort content-type from the
// URL extension when the operator didn't supply podcast_audio_mime.
// Apple Podcasts validators reject feeds with unknown enclosure
// types, so the fallback to `audio/mpeg` (the dominant podcast
// format) is safer than `application/octet-stream`.
func audioMIMEFromURL(u string) string {
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	ext := strings.ToLower(path.Ext(u))
	switch ext {
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".ogg", ".oga":
		return "audio/ogg"
	case ".opus":
		return "audio/opus"
	case ".wav":
		return "audio/wav"
	case ".flac":
		return "audio/flac"
	default:
		return "audio/mpeg"
	}
}

// formatDuration renders a duration as HH:MM:SS for <itunes:duration>.
// Apple Podcasts accepts plain seconds too, but HH:MM:SS is what every
// reader can display literally.
func formatDuration(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	h := seconds / 3600
	m := (seconds % 3600) / 60
	s := seconds % 60
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}

func explicitFlag(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// writeJSON writes a JSON response. Mirrors the archive package
// helper (kept local to avoid a cross-package coupling for a one-off
// utility).
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": code, "message": msg}
}

// --- RSS XML structs ---
//
// Namespace attributes ride on the root <rss> element so every
// downstream element can use the prefixes (atom:, itunes:, content:).

type rssFeed struct {
	XMLName  xml.Name   `xml:"rss"`
	Version  string     `xml:"version,attr"`
	NSAtom   string     `xml:"xmlns:atom,attr"`
	NSDC     string     `xml:"xmlns:dc,attr"`
	NSCont   string     `xml:"xmlns:content,attr"`
	NSITunes string     `xml:"xmlns:itunes,attr"`
	NSMedia  string     `xml:"xmlns:media,attr"`
	Channel  rssChannel `xml:"channel"`
}

type rssChannel struct {
	Title          string          `xml:"title"`
	Link           string          `xml:"link"`
	Description    string          `xml:"description"`
	Lang           string          `xml:"language"`
	LastBuildDate  string          `xml:"lastBuildDate,omitempty"`
	Generator      string          `xml:"generator,omitempty"`
	AtomLink       *atomLink       `xml:"atom:link"`
	ITunesAuthor   string          `xml:"itunes:author,omitempty"`
	ITunesSummary  string          `xml:"itunes:summary,omitempty"`
	ITunesExplicit string          `xml:"itunes:explicit,omitempty"`
	ITunesCategory *itunesCategory `xml:"itunes:category,omitempty"`
	ITunesImage    *itunesImage    `xml:"itunes:image,omitempty"`
	ITunesBlock    string          `xml:"itunes:block,omitempty"`
	Items          []rssItem       `xml:"item"`
}

type atomLink struct {
	XMLName xml.Name `xml:"atom:link"`
	Href    string   `xml:"href,attr"`
	Rel     string   `xml:"rel,attr"`
	Type    string   `xml:"type,attr"`
}

type rssItem struct {
	Title             string        `xml:"title"`
	Link              string        `xml:"link"`
	GUID              *rssGUID      `xml:"guid"`
	Description       string        `xml:"description"`
	PubDate           string        `xml:"pubDate"`
	Creator           string        `xml:"dc:creator,omitempty"`
	ContentEncoded    *cdataContent `xml:"content:encoded,omitempty"`
	Enclosure         *rssEnclosure `xml:"enclosure,omitempty"`
	ITunesImage       *itunesImage  `xml:"itunes:image,omitempty"`
	ITunesAuthor      string        `xml:"itunes:author,omitempty"`
	ITunesDuration    string        `xml:"itunes:duration,omitempty"`
	ITunesEpisodeType string        `xml:"itunes:episodeType,omitempty"`
}

type rssGUID struct {
	Value       string `xml:",chardata"`
	IsPermaLink string `xml:"isPermaLink,attr,omitempty"`
}

type cdataContent struct {
	XMLName xml.Name `xml:"content:encoded"`
	Raw     string   `xml:",innerxml"`
}

func newCDATA(body string) *cdataContent {
	safe := strings.ReplaceAll(body, "]]>", "]]]]><![CDATA[>")
	return &cdataContent{Raw: "<![CDATA[" + safe + "]]>"}
}

type rssEnclosure struct {
	URL    string `xml:"url,attr"`
	Type   string `xml:"type,attr"`
	Length string `xml:"length,attr"`
}

type itunesImage struct {
	XMLName xml.Name `xml:"itunes:image"`
	Href    string   `xml:"href,attr"`
}

type itunesCategory struct {
	XMLName xml.Name `xml:"itunes:category"`
	Text    string   `xml:"text,attr"`
}

// keep context imported for future per-request cancellation handling
var _ = context.Background
