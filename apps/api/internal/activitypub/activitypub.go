// Package activitypub retains persistence models and protocol-building
// primitives for a future ActivityPub implementation. It is not a production
// federation surface: the API binary mounts no public discovery, inbox,
// outbox, follower, or admin routes, the OpenAPI contract advertises none,
// and publishing an archive issue does not call this package.
//
// Before any route is mounted, the capability must ship as a complete unit:
// interoperable HTTP signing and verification, replay controls, SSRF-safe
// remote actor resolution, bounded delivery with retries, tenant isolation,
// and end-to-end tests. See MIGRATION.md for that release contract.
package activitypub

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrNotFound is returned when an actor / outbox row is not found.
var ErrNotFound = errors.New("activitypub: not found")

// ErrDisabled is returned when federation is provisioned but the
// admin has flipped the actor row to `enabled=false`.
var ErrDisabled = errors.New("activitypub: federation disabled for tenant")

// ContextURL is the @context array every JSON-LD response carries.
// Two entries: the W3C ActivityStreams 2.0 context + the security
// vocab (for `publicKey`). Mastodon refuses to parse an actor that
// lacks the security context.
var ContextURL = []string{
	"https://www.w3.org/ns/activitystreams",
	"https://w3id.org/security/v1",
}

const (
	// MimeActivityJSON is the canonical ActivityPub content type per
	// AP-spec §3.2. Mastodon negotiates Accept against this string —
	// the "ld+json" variant is also accepted.
	MimeActivityJSON   = "application/activity+json"
	MimeActivityLDJSON = `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`

	// Default page size for outbox / followers collections. Mirrors
	// Mastodon's default of 20.
	DefaultCollectionPageSize = 20
	MaxCollectionPageSize     = 80

	// JSON body cap on the inbox handler. Real Activity envelopes
	// rarely exceed a few KB; 64 KiB leaves room for embedded Article
	// content while bounding abuse.
	inboxMaxBodyBytes int64 = 64 << 10
)

// Actor is the in-memory projection of an activitypub_actors row.
type Actor struct {
	TenantID          string    `json:"tenantId"`
	PreferredUsername string    `json:"preferredUsername"`
	Domain            string    `json:"domain"`
	DisplayName       string    `json:"displayName,omitempty"`
	Summary           string    `json:"summary,omitempty"`
	IconURL           string    `json:"iconUrl,omitempty"`
	ImageURL          string    `json:"imageUrl,omitempty"`
	PublicKeyPEM      string    `json:"publicKeyPem"`
	PrivateKeyPEM     string    `json:"-"`
	Enabled           bool      `json:"enabled"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

// Handle returns the canonical "@user@host" handle Mastodon renders.
func (a *Actor) Handle() string {
	return "@" + a.PreferredUsername + "@" + a.Domain
}

// ActorURL is the dereferenceable id of the actor — Mastodon caches
// this forever, so the format is part of the federation contract.
func (a *Actor) ActorURL() string {
	return "https://" + a.Domain + "/api/public/activitypub/users/" + a.PreferredUsername
}

// InboxURL / OutboxURL / FollowersURL are stable derivatives of the
// actor id used in the actor JSON-LD payload.
func (a *Actor) InboxURL() string     { return a.ActorURL() + "/inbox" }
func (a *Actor) OutboxURL() string    { return a.ActorURL() + "/outbox" }
func (a *Actor) FollowersURL() string { return a.ActorURL() + "/followers" }
func (a *Actor) PublicKeyID() string  { return a.ActorURL() + "#main-key" }

// Follower is the projection of an activitypub_followers row.
type Follower struct {
	ID               string    `json:"id"`
	ActorURL         string    `json:"actorUrl"`
	InboxURL         string    `json:"inboxUrl"`
	SharedInboxURL   string    `json:"sharedInboxUrl,omitempty"`
	DisplayName      string    `json:"displayName,omitempty"`
	Handle           string    `json:"handle,omitempty"`
	State            string    `json:"state"`
	FollowActivityID string    `json:"followActivityId,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
}

// OutboxEntry is the admin-facing projection of an outbox row.
type OutboxEntry struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	CampaignID  string          `json:"campaignId,omitempty"`
	ActivityURL string          `json:"activityUrl"`
	PublishedAt time.Time       `json:"publishedAt"`
	Activity    json.RawMessage `json:"activity,omitempty"`
}

// InboxEntry is the admin-facing projection of an inbox row.
type InboxEntry struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	ActorURL  string          `json:"actorUrl"`
	ObjectURL string          `json:"objectUrl,omitempty"`
	SigState  string          `json:"sigState"`
	Read      bool            `json:"read"`
	CreatedAt time.Time       `json:"createdAt"`
	Activity  json.RawMessage `json:"activity,omitempty"`
}

// Repo is the data-access layer. Mirrors the archive.Repo shape so
// the wiring in main.go is parallel.
type Repo struct {
	Pool *db.Pool
}

// Deps wires the public + admin handlers.
//
// PlatformDomain is the host every actor's id URL is anchored at when
// the tenant has no custom domain configured. It MUST be stable for
// the life of the federation (Mastodon caches actor.id forever).
//
// FederationEnabled is the platform-wide kill switch. When false the
// public endpoints respond 503 — useful for staging/dev configs that
// haven't deployed the delivery worker yet.
//
// Inbound ActivityPub is deliberately absent from the public router.
// Accepting a Follow requires HTTP Signature verification, remote actor
// validation, SSRF-safe dereferencing, replay protection, and signed
// delivery. None of those prerequisites may be enabled independently by
// configuration. See MIGRATION.md for the contract that must be completed
// before an inbox route can be introduced.
type Deps struct {
	Repo              *Repo
	PlatformDomain    string
	FederationEnabled bool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// ---------------------------------------------------------------------
// Repo: actor provisioning + lookup
// ---------------------------------------------------------------------

// ProvisionActor creates a fresh actor row for the tenant (idempotent).
// Generates an RSA-2048 keypair on first call; on subsequent calls
// returns the existing row unchanged.
func (r *Repo) ProvisionActor(ctx context.Context, tenantID, username, domain string) (*Actor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fast-path: row already exists. Read it and return.
	existing, err := readActorTx(ctx, tx, tenantID)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return existing, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	// Slow path: generate keypair + insert.
	pub, priv, err := generateKeypairPEM()
	if err != nil {
		return nil, fmt.Errorf("activitypub: generate keypair: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO activitypub_actors (
    tenant_id, preferred_username, domain, public_key_pem, private_key_pem, enabled
) VALUES ($1::uuid, $2, $3, $4, $5, true)
ON CONFLICT (tenant_id) DO NOTHING`,
		tenantID, username, domain, pub, priv,
	); err != nil {
		return nil, err
	}
	out, err := readActorTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetActor returns the actor row for the tenant. ErrNotFound when the
// tenant has never enabled federation.
func (r *Repo) GetActor(ctx context.Context, tenantID string) (*Actor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	a, err := readActorTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// UpdateActorProfile patches the editable profile metadata fields.
// Pointer-nil fields are left untouched; explicit-empty-string clears.
func (r *Repo) UpdateActorProfile(ctx context.Context, tenantID string, in ActorProfileInput) (*Actor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE activitypub_actors
   SET display_name = COALESCE($2, display_name),
       summary      = COALESCE($3, summary),
       icon_url     = COALESCE($4, icon_url),
       image_url    = COALESCE($5, image_url),
       enabled      = COALESCE($6, enabled),
       updated_at   = now()
 WHERE tenant_id = $1::uuid`,
		tenantID, in.DisplayName, in.Summary, in.IconURL, in.ImageURL, in.Enabled,
	); err != nil {
		return nil, err
	}
	a, err := readActorTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// ActorByUsernameDomain is the public lookup path used by WebFinger
// + the actor endpoint. Runs WITHOUT a tenant GUC — the caller IS
// the public — and relies on the permissive `actor_public_lookup`
// RLS policy + the (domain, preferred_username) UNIQUE.
func (r *Repo) ActorByUsernameDomain(ctx context.Context, username, domain string) (*Actor, error) {
	var a Actor
	err := r.Pool.QueryRow(ctx, `
SELECT tenant_id::text, preferred_username::text, domain::text,
       COALESCE(display_name, ''), COALESCE(summary, ''),
       COALESCE(icon_url, ''), COALESCE(image_url, ''),
       public_key_pem, private_key_pem,
       enabled, created_at, updated_at
  FROM activitypub_actors
 WHERE preferred_username = $1::citext
   AND domain             = $2::citext
   AND enabled            = true
 LIMIT 1`, username, domain).Scan(
		&a.TenantID, &a.PreferredUsername, &a.Domain,
		&a.DisplayName, &a.Summary, &a.IconURL, &a.ImageURL,
		&a.PublicKeyPEM, &a.PrivateKeyPEM,
		&a.Enabled, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !a.Enabled {
		return nil, ErrDisabled
	}
	return &a, nil
}

// ActorProfileInput is the PUT body for the admin actor edit
// endpoint. Pointer semantics so `null` and "omit" mean "leave
// untouched"; explicit empty-string clears the column.
type ActorProfileInput struct {
	DisplayName *string `json:"displayName,omitempty"`
	Summary     *string `json:"summary,omitempty"`
	IconURL     *string `json:"iconUrl,omitempty"`
	ImageURL    *string `json:"imageUrl,omitempty"`
	Enabled     *bool   `json:"enabled,omitempty"`
}

// readActorTx reads the actor row inside an existing tx (tenant GUC
// already bound). Returns ErrNotFound when the tenant has never
// provisioned an actor.
func readActorTx(ctx context.Context, tx pgx.Tx, tenantID string) (*Actor, error) {
	var a Actor
	err := tx.QueryRow(ctx, `
SELECT tenant_id::text, preferred_username::text, domain::text,
       COALESCE(display_name, ''), COALESCE(summary, ''),
       COALESCE(icon_url, ''), COALESCE(image_url, ''),
       public_key_pem, private_key_pem,
       enabled, created_at, updated_at
  FROM activitypub_actors
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(
		&a.TenantID, &a.PreferredUsername, &a.Domain,
		&a.DisplayName, &a.Summary, &a.IconURL, &a.ImageURL,
		&a.PublicKeyPEM, &a.PrivateKeyPEM,
		&a.Enabled, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// generateKeypairPEM mints a fresh RSA-2048 keypair and returns the
// PEM-encoded public + private halves. RSA-2048 is the Mastodon
// minimum — anything smaller is rejected at fetch time.
func generateKeypairPEM() (publicPEM, privatePEM string, err error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	privBlock := &pem.Block{Type: "PRIVATE KEY", Bytes: privDER}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return "", "", err
	}
	pubBlock := &pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}
	return string(pem.EncodeToMemory(pubBlock)), string(pem.EncodeToMemory(privBlock)), nil
}

// ---------------------------------------------------------------------
// Repo: followers
// ---------------------------------------------------------------------

// RecordFollower upserts a follower row. Called from the inbox
// handler when a Follow envelope arrives. Idempotent on (tenant,
// actor_url).
func (r *Repo) RecordFollower(ctx context.Context, tenantID string, f Follower) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO activitypub_followers
    (tenant_id, actor_url, inbox_url, shared_inbox_url, display_name, handle, state, follow_activity_id)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, NULLIF($8, ''))
ON CONFLICT (tenant_id, actor_url) DO UPDATE
   SET inbox_url        = EXCLUDED.inbox_url,
       shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, activitypub_followers.shared_inbox_url),
       display_name     = COALESCE(EXCLUDED.display_name, activitypub_followers.display_name),
       handle           = COALESCE(EXCLUDED.handle, activitypub_followers.handle),
       state            = EXCLUDED.state,
       follow_activity_id = COALESCE(EXCLUDED.follow_activity_id, activitypub_followers.follow_activity_id),
       updated_at       = now()`,
		tenantID, f.ActorURL, f.InboxURL, f.SharedInboxURL, f.DisplayName, f.Handle, f.State, f.FollowActivityID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeFollower flips a follower to state='revoked' (Undo{Follow}).
func (r *Repo) RevokeFollower(ctx context.Context, tenantID, actorURL string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE activitypub_followers
   SET state = 'revoked', updated_at = now()
 WHERE tenant_id = $1::uuid AND actor_url = $2`,
		tenantID, actorURL); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListFollowers reads accepted followers newest-first.
func (r *Repo) ListFollowers(ctx context.Context, tenantID string, limit int) ([]Follower, error) {
	if limit <= 0 || limit > MaxCollectionPageSize {
		limit = DefaultCollectionPageSize
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, actor_url, inbox_url,
       COALESCE(shared_inbox_url, ''),
       COALESCE(display_name, ''),
       COALESCE(handle, ''),
       state,
       COALESCE(follow_activity_id, ''),
       created_at
  FROM activitypub_followers
 WHERE tenant_id = $1::uuid
   AND state = 'accepted'
 ORDER BY created_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Follower, 0, limit)
	for rows.Next() {
		var f Follower
		if err := rows.Scan(&f.ID, &f.ActorURL, &f.InboxURL, &f.SharedInboxURL,
			&f.DisplayName, &f.Handle, &f.State, &f.FollowActivityID, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// FollowerCount returns the total accepted-follower count for the
// tenant. Surfaces in the actor JSON-LD as `followers.totalItems`.
func (r *Repo) FollowerCount(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM activitypub_followers
 WHERE tenant_id = $1::uuid AND state = 'accepted'`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ---------------------------------------------------------------------
// Repo: outbox
// ---------------------------------------------------------------------

// PublishArticle records a `Create{Article}` envelope on the outbox
// and seeds the delivery queue (one row per accepted follower). The
// envelope is built externally; this is the persist+fan-out step.
//
// Idempotent on activity_url — re-publishing the same campaign
// produces the same activity_url and ON CONFLICT-skips the insert.
func (r *Repo) PublishArticle(ctx context.Context, tenantID, campaignID, activityURL string, envelope []byte) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var outboxID string
	err = tx.QueryRow(ctx, `
INSERT INTO activitypub_outbox (tenant_id, kind, campaign_id, activity_json, activity_url)
VALUES ($1::uuid, 'Create', NULLIF($2, '')::uuid, $3::jsonb, $4)
ON CONFLICT (tenant_id, activity_url) DO UPDATE
   SET activity_json = EXCLUDED.activity_json,
       published_at  = activitypub_outbox.published_at
 RETURNING id::text`, tenantID, campaignID, string(envelope), activityURL).Scan(&outboxID)
	if err != nil {
		return "", err
	}
	// Seed delivery queue rows for every accepted follower. ON CONFLICT
	// keeps the call idempotent across republishes.
	if _, err := tx.Exec(ctx, `
INSERT INTO activitypub_delivery_queue (tenant_id, outbox_id, inbox_url, state)
SELECT $1::uuid, $2::uuid, COALESCE(shared_inbox_url, inbox_url), 'pending'
  FROM activitypub_followers
 WHERE tenant_id = $1::uuid AND state = 'accepted'
ON CONFLICT (outbox_id, inbox_url) DO NOTHING`, tenantID, outboxID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return outboxID, nil
}

// ListOutbox returns the most recent outbound activities for the
// tenant. Powers both the public /outbox collection endpoint and the
// admin slideover.
func (r *Repo) ListOutbox(ctx context.Context, tenantID string, limit int, includeBody bool) ([]OutboxEntry, error) {
	if limit <= 0 || limit > MaxCollectionPageSize {
		limit = DefaultCollectionPageSize
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, kind, COALESCE(campaign_id::text, ''), activity_url, published_at,
       CASE WHEN $3 THEN activity_json::text ELSE NULL END
  FROM activitypub_outbox
 WHERE tenant_id = $1::uuid
 ORDER BY published_at DESC
 LIMIT $2`, tenantID, limit, includeBody)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]OutboxEntry, 0, limit)
	for rows.Next() {
		var e OutboxEntry
		var body *string
		if err := rows.Scan(&e.ID, &e.Kind, &e.CampaignID, &e.ActivityURL, &e.PublishedAt, &body); err != nil {
			return nil, err
		}
		if body != nil {
			e.Activity = json.RawMessage(*body)
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

// OutboxCount returns the total outbox row count for the tenant.
// Surfaces in the actor's outbox collection `totalItems`.
func (r *Repo) OutboxCount(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM activitypub_outbox
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ---------------------------------------------------------------------
// Repo: inbox
// ---------------------------------------------------------------------

// RecordInbox persists an incoming Activity envelope. Caller already
// classified `kind` and extracted `actorURL`/`objectURL`. The raw
// envelope is preserved as-is in `activity_json` for audit + the
// inbox detail slideover.
func (r *Repo) RecordInbox(ctx context.Context, tenantID, kind, actorURL, objectURL, sigState string, raw []byte) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO activitypub_inbox (tenant_id, kind, actor_url, object_url, sig_state, activity_json)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6::jsonb)
RETURNING id::text`,
		tenantID, kind, actorURL, objectURL, sigState, string(raw),
	).Scan(&id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// ListInbox is the paged read for the admin inbox surface. When
// `unreadOnly` is true, filters to rows with read_at IS NULL.
func (r *Repo) ListInbox(ctx context.Context, tenantID string, limit int, unreadOnly bool) ([]InboxEntry, error) {
	if limit <= 0 || limit > MaxCollectionPageSize {
		limit = DefaultCollectionPageSize
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT id::text, kind, actor_url,
       COALESCE(object_url, ''),
       sig_state,
       (read_at IS NOT NULL) AS read,
       created_at,
       activity_json::text
  FROM activitypub_inbox
 WHERE tenant_id = $1::uuid`
	if unreadOnly {
		q += ` AND read_at IS NULL`
	}
	q += ` ORDER BY created_at DESC LIMIT $2`
	rows, err := tx.Query(ctx, q, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]InboxEntry, 0, limit)
	for rows.Next() {
		var e InboxEntry
		var body string
		if err := rows.Scan(&e.ID, &e.Kind, &e.ActorURL, &e.ObjectURL, &e.SigState, &e.Read, &e.CreatedAt, &body); err != nil {
			return nil, err
		}
		e.Activity = json.RawMessage(body)
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

// MarkInboxRead flips read_at to now() for a single inbox row.
func (r *Repo) MarkInboxRead(ctx context.Context, tenantID, inboxID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE activitypub_inbox
   SET read_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, inboxID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// InboxUnreadCount surfaces a sidebar badge count in the admin shell.
func (r *Repo) InboxUnreadCount(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM activitypub_inbox
 WHERE tenant_id = $1::uuid AND read_at IS NULL`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ---------------------------------------------------------------------
// HTTP handlers — public read-only federation discovery
// ---------------------------------------------------------------------

// PublicWebfinger handles GET /.well-known/webfinger.
// Spec: RFC 7033. Query param `resource=acct:user@host`.
func (d *Deps) PublicWebfinger(w http.ResponseWriter, r *http.Request) {
	if !d.FederationEnabled {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("disabled", "federation is disabled"))
		return
	}
	resource := r.URL.Query().Get("resource")
	if !strings.HasPrefix(resource, "acct:") {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_resource", "resource must start with acct:"))
		return
	}
	acct := strings.TrimPrefix(resource, "acct:")
	at := strings.LastIndex(acct, "@")
	if at < 1 || at == len(acct)-1 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_resource", "resource not in acct:user@host form"))
		return
	}
	user := acct[:at]
	host := acct[at+1:]
	a, err := d.Repo.ActorByUsernameDomain(r.Context(), user, host)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such actor"))
		return
	}
	// Minimal WebFinger response. Mastodon dereferences the `self`
	// link to fetch the actor JSON-LD.
	resp := map[string]any{
		"subject": resource,
		"aliases": []string{a.ActorURL()},
		"links": []map[string]any{
			{
				"rel":  "self",
				"type": MimeActivityJSON,
				"href": a.ActorURL(),
			},
			{
				"rel":  "http://webfinger.net/rel/profile-page",
				"type": "text/html",
				"href": "https://" + a.Domain + "/archive/" + a.PreferredUsername,
			},
		},
	}
	w.Header().Set("Content-Type", "application/jrd+json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicActor handles GET /api/public/activitypub/users/{slug}.
// Returns the actor JSON-LD that Mastodon caches as the canonical
// identity of the publication.
func (d *Deps) PublicActor(w http.ResponseWriter, r *http.Request) {
	if !d.FederationEnabled {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("disabled", "federation is disabled"))
		return
	}
	slug := chi.URLParam(r, "slug")
	host := requestHost(r, d.PlatformDomain)
	a, err := d.Repo.ActorByUsernameDomain(r.Context(), slug, host)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such actor"))
		return
	}
	resp := map[string]any{
		"@context":          ContextURL,
		"id":                a.ActorURL(),
		"type":              "Service",
		"preferredUsername": a.PreferredUsername,
		"name":              displayNameOr(a),
		"summary":           a.Summary,
		"inbox":             a.InboxURL(),
		"outbox":            a.OutboxURL(),
		"followers":         a.FollowersURL(),
		"url":               "https://" + a.Domain + "/archive/" + a.PreferredUsername,
		"publicKey": map[string]any{
			"id":           a.PublicKeyID(),
			"owner":        a.ActorURL(),
			"publicKeyPem": a.PublicKeyPEM,
		},
	}
	if a.IconURL != "" {
		resp["icon"] = map[string]any{"type": "Image", "url": a.IconURL}
	}
	if a.ImageURL != "" {
		resp["image"] = map[string]any{"type": "Image", "url": a.ImageURL}
	}
	w.Header().Set("Content-Type", MimeActivityJSON)
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicOutbox handles GET /api/public/activitypub/users/{slug}/outbox.
// Returns an OrderedCollection of Create{Article} envelopes,
// newest-first. No paging cursor yet — first page only (Mastodon
// reads enough activities from this page to populate the actor's
// feed in-app).
func (d *Deps) PublicOutbox(w http.ResponseWriter, r *http.Request) {
	if !d.FederationEnabled {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("disabled", "federation is disabled"))
		return
	}
	slug := chi.URLParam(r, "slug")
	host := requestHost(r, d.PlatformDomain)
	a, err := d.Repo.ActorByUsernameDomain(r.Context(), slug, host)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such actor"))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := d.Repo.ListOutbox(r.Context(), a.TenantID, limit, true)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	total, err := d.Repo.OutboxCount(r.Context(), a.TenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	items := make([]json.RawMessage, 0, len(entries))
	for _, e := range entries {
		if len(e.Activity) > 0 {
			items = append(items, e.Activity)
		}
	}
	resp := map[string]any{
		"@context":     ContextURL,
		"id":           a.OutboxURL(),
		"type":         "OrderedCollection",
		"totalItems":   total,
		"orderedItems": items,
	}
	w.Header().Set("Content-Type", MimeActivityJSON)
	w.Header().Set("Cache-Control", "public, max-age=120")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// PublicFollowers handles GET /api/public/activitypub/users/{slug}/followers.
// Returns a Collection of follower actor URLs (count only — actor
// URLs leak follower handles, which most Mastodon admins prefer
// kept private. Mastodon's own followers collection works the same
// way unless the actor opts in to publishing the list).
func (d *Deps) PublicFollowers(w http.ResponseWriter, r *http.Request) {
	if !d.FederationEnabled {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("disabled", "federation is disabled"))
		return
	}
	slug := chi.URLParam(r, "slug")
	host := requestHost(r, d.PlatformDomain)
	a, err := d.Repo.ActorByUsernameDomain(r.Context(), slug, host)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such actor"))
		return
	}
	total, err := d.Repo.FollowerCount(r.Context(), a.TenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resp := map[string]any{
		"@context":   ContextURL,
		"id":         a.FollowersURL(),
		"type":       "OrderedCollection",
		"totalItems": total,
	}
	w.Header().Set("Content-Type", MimeActivityJSON)
	w.Header().Set("Cache-Control", "public, max-age=120")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// ---------------------------------------------------------------------
// HTTP handlers — admin
// ---------------------------------------------------------------------

// AdminGetActor GET /api/v1/activitypub/actor.
func (d *Deps) AdminGetActor(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	a, err := d.Repo.GetActor(r.Context(), t)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_provisioned", "actor not provisioned"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"actor":  a,
		"handle": a.Handle(),
		"urls": map[string]string{
			"actor":     a.ActorURL(),
			"inbox":     a.InboxURL(),
			"outbox":    a.OutboxURL(),
			"followers": a.FollowersURL(),
		},
	})
}

// AdminProvisionActor POST /api/v1/activitypub/actor/provision.
// Body: {"preferredUsername":"foo"} — username defaults to the
// tenant_archive_slug when omitted. Idempotent.
func (d *Deps) AdminProvisionActor(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, inboxMaxBodyBytes)
	if err != nil {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", err.Error())
		return
	}
	var in struct {
		PreferredUsername string `json:"preferredUsername"`
		Domain            string `json:"domain"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &in); err != nil {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
	}
	if in.Domain == "" {
		in.Domain = d.PlatformDomain
	}
	if in.PreferredUsername == "" {
		// Fall back to the tenant's archive slug. The desktop
		// pre-populates this in the form, but if the caller forgot we
		// still want a sensible default.
		in.PreferredUsername = "actor"
	}
	a, err := d.Repo.ProvisionActor(r.Context(), t, in.PreferredUsername, in.Domain)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"actor":  a,
		"handle": a.Handle(),
	})
}

// AdminPutActor PUT /api/v1/activitypub/actor. Body: ActorProfileInput.
func (d *Deps) AdminPutActor(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, inboxMaxBodyBytes)
	if err != nil {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", err.Error())
		return
	}
	var in ActorProfileInput
	if err := json.Unmarshal(body, &in); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	a, err := d.Repo.UpdateActorProfile(r.Context(), t, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// AdminListInbox GET /api/v1/activitypub/inbox?limit=&unread=1.
func (d *Deps) AdminListInbox(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	unread := r.URL.Query().Get("unread") == "1"
	items, err := d.Repo.ListInbox(r.Context(), t, limit, unread)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	n, _ := d.Repo.InboxUnreadCount(r.Context(), t)
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  items,
		"unread": n,
	})
}

// AdminMarkInboxRead POST /api/v1/activitypub/inbox/{id}/read.
func (d *Deps) AdminMarkInboxRead(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.MarkInboxRead(r.Context(), t, id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AdminListFollowers GET /api/v1/activitypub/followers?limit=.
func (d *Deps) AdminListFollowers(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := d.Repo.ListFollowers(r.Context(), t, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	total, _ := d.Repo.FollowerCount(r.Context(), t)
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": total,
	})
}

// AdminListOutbox GET /api/v1/activitypub/outbox?limit=.
func (d *Deps) AdminListOutbox(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := d.Repo.ListOutbox(r.Context(), t, limit, false)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	total, _ := d.Repo.OutboxCount(r.Context(), t)
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": total,
	})
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

func tenantIDFromCtx(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		return "", false
	}
	return t.ID, true
}

// requestHost returns the request's Host header, falling back to the
// platform default. Used to scope WebFinger / actor lookups when the
// tenant runs on a custom domain.
func requestHost(r *http.Request, fallback string) string {
	if r.Host != "" {
		return r.Host
	}
	return fallback
}

// displayNameOr falls back to the preferredUsername when the actor's
// display_name column is empty.
func displayNameOr(a *Actor) string {
	if a.DisplayName != "" {
		return a.DisplayName
	}
	return a.PreferredUsername
}

// BuildArticleEnvelope assembles a Create{Article} envelope for the
// supplied actor + archive issue. Pure function — no DB calls — so
// publish flows can build the envelope, hand the bytes to
// Repo.PublishArticle, and recover the persisted activity_url.
//
// The activity_url is derived from the campaign id so re-publishing
// the same issue produces the same URL (idempotent on
// activitypub_outbox.activity_url UNIQUE).
func BuildArticleEnvelope(a *Actor, campaignID, slug, subject, htmlBody, excerpt string, publishedAt time.Time) (activityURL string, envelope []byte, err error) {
	activityURL = a.ActorURL() + "/activities/" + campaignID
	objectURL := "https://" + a.Domain + "/archive/" + a.PreferredUsername + "/" + slug
	env := map[string]any{
		"@context":  ContextURL,
		"id":        activityURL,
		"type":      "Create",
		"actor":     a.ActorURL(),
		"published": publishedAt.UTC().Format(time.RFC3339),
		"to":        []string{"https://www.w3.org/ns/activitystreams#Public"},
		"cc":        []string{a.FollowersURL()},
		"object": map[string]any{
			"id":           objectURL,
			"type":         "Article",
			"attributedTo": a.ActorURL(),
			"published":    publishedAt.UTC().Format(time.RFC3339),
			"to":           []string{"https://www.w3.org/ns/activitystreams#Public"},
			"cc":           []string{a.FollowersURL()},
			"url":          objectURL,
			"name":         subject,
			"summary":      excerpt,
			"content":      htmlBody,
		},
	}
	b, err := json.Marshal(env)
	if err != nil {
		return "", nil, err
	}
	return activityURL, b, nil
}

// writeJSON / errEnv mirror the helpers in the archive package.
// Duplicated locally to avoid a cross-package shared util that drags
// archive into activitypub's import graph (and vice versa).
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": msg}}
}
