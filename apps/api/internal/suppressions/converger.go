// SuppressionConverger is the read-side unifier for the three
// suppression tables (GAP-LS-001 + 135). It wraps the X1 Store but
// reads through the v_suppressions_unified VIEW (migration 0244) so
// every send-time hit goes through one canonical predicate even while
// the legacy `suppressions` and Mailchimp-parity `email_suppressions`
// tables still carry historical rows.
//
// The converger is the load-bearing object that closes the P0 bug
// where suppressions added through the legacy admin POST / CSV import
// / RFC 8058 one-click path were silently ignored by the send loop.
// With the converger wired into Guard.Suppressions every send-time
// check sees rows from ALL three tables.
//
// Defence-in-depth: if the unified view returns nothing the converger
// ALSO probes the per-table reads directly so a half-applied migration
// can't accidentally hide rows. A non-X1 hit logs a warning so
// operators can track converger backfill completeness.

package suppressions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SuppressionConverger wraps an X1 *Store and the same db.Pool the
// store uses. Writes pass through to the underlying Store (Add /
// Remove); reads consult v_suppressions_unified first and fall back to
// per-table queries on a unified-view miss.
type SuppressionConverger struct {
	Store  *Store
	Pool   *db.Pool
	Logger *slog.Logger
}

// NewConverger wires a converger around an existing X1 Store. Pool is
// duplicated from the Store so the helper has its own handle for the
// fallback queries that don't go through Store methods.
func NewConverger(store *Store, logger *slog.Logger) *SuppressionConverger {
	var pool *db.Pool
	if store != nil {
		pool = store.Pool
	}
	return &SuppressionConverger{Store: store, Pool: pool, Logger: logger}
}

func (c *SuppressionConverger) logger() *slog.Logger {
	if c != nil && c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

// Add proxies to the underlying X1 Store with channel + scope.
// Audit-log integration is layered above in handlers.go so the
// converger stays a thin read+write surface.
func (c *SuppressionConverger) Add(
	ctx context.Context,
	tenantID, email string,
	reason Reason,
	source Source,
	sourceEventID string,
	expiresAt *time.Time,
	metadata map[string]any,
	channel Channel,
	scope Scope,
) (*Entry, error) {
	if c == nil || c.Store == nil {
		return nil, errors.New("suppressions: nil converger")
	}
	return c.Store.AddWithChannel(ctx, tenantID, email, reason, source,
		sourceEventID, expiresAt, metadata, channel, scope)
}

// Remove proxies to the underlying X1 Store. Note: this ONLY removes
// from subscriber_suppressions; legacy + Mailchimp-parity rows are
// addressed by the migrate-legacy / DELETE legacy handlers explicitly
// so an admin "remove from list" doesn't silently leave a row in a
// shadow table.
func (c *SuppressionConverger) Remove(ctx context.Context, tenantID, email string) error {
	if c == nil || c.Store == nil {
		return errors.New("suppressions: nil converger")
	}
	return c.Store.Remove(ctx, tenantID, email)
}

// Check returns (true, *Entry) when (tenantID, email) is suppressed
// for the given (channel, scope). hard_bounce + global_unsubscribe
// always block regardless of scope (see CheckScoped doc-comment).
//
// Resolution order:
//  1. v_suppressions_unified VIEW — preferred path.
//  2. Direct subscriber_suppressions probe — defence-in-depth if the
//     view hasn't been refreshed yet or the migration was partial.
//  3. Legacy `suppressions` table — historical bounces/complaints
//     written by the pre-X1 admin path. Reason normalised on read.
//  4. Mailchimp-parity `email_suppressions` — written by the
//     FBL/ARF pipeline + DSAR subscriber-delete.
//
// On a non-X1 hit we log a warning with source_table so the converger
// backfill worker (lands later) can prioritise eviction.
func (c *SuppressionConverger) Check(ctx context.Context, tenantID, email string, channel Channel, scope Scope) (bool, *Entry, error) {
	if c == nil || c.Pool == nil {
		return false, nil, errors.New("suppressions: nil converger")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false, nil, nil
	}
	if channel == "" {
		channel = ChannelEmail
	}
	if scope == "" {
		scope = ScopeMarketing
	}
	sum := sha256.Sum256([]byte(email))
	hashHex := hex.EncodeToString(sum[:])

	tx, err := db.WithTenant(ctx, c.Pool, tenantID)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Unified view first.
	out := &Entry{}
	var meta []byte
	row := tx.QueryRow(ctx, `
SELECT email::text, reason, source,
       COALESCE(source_event_id, ''), created_at, expires_at, metadata,
       source_table
FROM v_suppressions_unified
WHERE tenant_id = $1::uuid
  AND (email = $2 OR (email_sha256 IS NOT NULL AND email_sha256 = $3))
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`, tenantID, email, hashHex)
	if err := row.Scan(
		&out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
		&out.SourceTable,
	); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return false, nil, fmt.Errorf("converger: view check: %w", err)
		}
		// View miss — fall through to per-table probe below.
	} else {
		// View hit: apply the (channel, scope) filter in Go since the
		// view doesn't expose the columns from the source rows.
		// Defaults: legacy + Mailchimp rows are email + marketing.
		if !channelMatches(out.Source, channel) || !scopeAllows(out.Reason, scope) {
			// Row exists but isn't in scope for this send.
			if err := tx.Commit(ctx); err != nil {
				return false, nil, err
			}
			return false, nil, nil
		}
		if len(meta) > 0 {
			out.Metadata = decodeJSON(meta)
		}
		out.hydrateFromMetadata()
		if out.SourceTable != "subscriber_suppressions" {
			c.logger().Warn("suppressions: hit served from non-X1 source",
				"tenant_id", tenantID,
				"email", email,
				"source_table", out.SourceTable,
				"reason", string(out.Reason))
		}
		if err := tx.Commit(ctx); err != nil {
			return false, nil, err
		}
		return true, out, nil
	}

	// 2. Fallback: probe each underlying table directly. The view path
	// covers the canonical case; this layer protects against partial
	// migration states (e.g. the view was dropped, or a tenant landed
	// on a node where 0244 hasn't applied yet). One short query per
	// table; aborts on the first hit.
	hit, herr := c.fallbackX1(ctx, tx, tenantID, email, hashHex, channel, scope)
	if herr != nil {
		return false, nil, herr
	}
	if hit != nil {
		if err := tx.Commit(ctx); err != nil {
			return false, nil, err
		}
		return true, hit, nil
	}
	hit, herr = c.fallbackLegacy(ctx, tx, tenantID, email, hashHex, scope)
	if herr != nil {
		return false, nil, herr
	}
	if hit != nil {
		c.logger().Warn("suppressions: legacy-table fallback hit",
			"tenant_id", tenantID, "email", email, "source_table", "suppressions")
		if err := tx.Commit(ctx); err != nil {
			return false, nil, err
		}
		return true, hit, nil
	}
	hit, herr = c.fallbackMailchimp(ctx, tx, tenantID, email, scope)
	if herr != nil {
		return false, nil, herr
	}
	if hit != nil {
		c.logger().Warn("suppressions: email_suppressions fallback hit",
			"tenant_id", tenantID, "email", email, "source_table", "email_suppressions")
		if err := tx.Commit(ctx); err != nil {
			return false, nil, err
		}
		return true, hit, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return false, nil, err
	}
	return false, nil, nil
}

// LookupBulk batches the (channel, scope) check across N emails. Returns
// the set of suppressed requested addresses keyed lowercase. It matches both
// plaintext and the DSAR-retained SHA-256 value through the unified view. The
// per-table fallback is per-row work and the bulk path is the queue-fill /
// send-time optimisation — a single round trip is the whole point.
//
// Callers operating during a deliberately partial schema rollout should use
// Check, whose scalar path includes direct per-table fallbacks. Production
// send workers use this batch path only after the unified-view migration is a
// release prerequisite; any query error is propagated and therefore blocks
// delivery rather than silently falling back to clear.
func (c *SuppressionConverger) LookupBulk(ctx context.Context, tenantID string, emails []string, channel Channel, scope Scope) (map[string]*Entry, error) {
	out := map[string]*Entry{}
	if c == nil || c.Pool == nil {
		return out, errors.New("suppressions: nil converger")
	}
	if tenantID == "" || len(emails) == 0 {
		return out, nil
	}
	if channel == "" {
		channel = ChannelEmail
	}
	if scope == "" {
		scope = ScopeMarketing
	}
	seen := make(map[string]struct{}, len(emails))
	norm := make([]string, 0, len(emails))
	for _, e := range emails {
		k := strings.ToLower(strings.TrimSpace(e))
		if k == "" {
			continue
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		norm = append(norm, k)
	}
	if len(norm) == 0 {
		return out, nil
	}
	hashes := make([]string, len(norm))
	for i, email := range norm {
		sum := sha256.Sum256([]byte(email))
		hashes[i] = hex.EncodeToString(sum[:])
	}
	tx, err := db.WithTenant(ctx, c.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH requested(email, email_sha256) AS (
  SELECT *
  FROM unnest($2::text[], $3::text[])
)
SELECT requested.email,
       unified.email::text, unified.reason, unified.source,
       COALESCE(unified.source_event_id,''), unified.created_at,
       unified.expires_at, unified.metadata, unified.source_table
FROM requested
JOIN v_suppressions_unified unified
  ON unified.tenant_id = $1::uuid
 AND (
      lower(unified.email) = requested.email
      OR (
        unified.email_sha256 IS NOT NULL
        AND unified.email_sha256 = requested.email_sha256
      )
 )
WHERE unified.expires_at IS NULL OR unified.expires_at > now()`, tenantID, norm, hashes)
	if err != nil {
		return nil, fmt.Errorf("converger: lookup bulk: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		e := &Entry{}
		var requestedEmail string
		var meta []byte
		if err := rows.Scan(&requestedEmail, &e.Email, &e.Reason, &e.Source,
			&e.SourceEventID, &e.CreatedAt, &e.ExpiresAt, &meta, &e.SourceTable); err != nil {
			return nil, fmt.Errorf("converger: lookup bulk scan: %w", err)
		}
		// Channel + scope predicate applied in Go (see Check). The
		// queue-fill path is fine with last-write-wins on duplicates
		// across source tables — we want the union.
		if !channelMatches(e.Source, channel) || !scopeAllows(e.Reason, scope) {
			continue
		}
		if len(meta) > 0 {
			e.Metadata = decodeJSON(meta)
		}
		e.hydrateFromMetadata()
		// Key by the requested address, not the stored email. DSAR-erased
		// rows intentionally replace the plaintext while retaining only its
		// SHA-256 suppression match, so e.Email may be an erased placeholder.
		key := strings.ToLower(strings.TrimSpace(requestedEmail))
		out[key] = e
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// fallbackX1 probes subscriber_suppressions directly with the
// (channel, scope) predicate. Returns nil when no row matches.
func (c *SuppressionConverger) fallbackX1(
	ctx context.Context, tx pgx.Tx,
	tenantID, email, hashHex string,
	channel Channel, scope Scope,
) (*Entry, error) {
	out := &Entry{}
	var meta []byte
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
       COALESCE(source_event_id,''), created_at, expires_at, metadata,
       COALESCE(channel, 'email'), COALESCE(scope, 'marketing'), COALESCE(match_kind, 'email')
FROM subscriber_suppressions
WHERE tenant_id = $1::uuid
  AND (email = $2 OR email_sha256 = $3)
  AND (expires_at IS NULL OR expires_at > now())
  AND (channel = $4 OR channel = 'any')
  AND (scope = $5 OR scope = 'all'
       OR reason IN ('hard_bounce','global_unsubscribe'))
LIMIT 1`, tenantID, email, hashHex, string(channel), string(scope)).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.Source,
		&out.SourceEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
		&out.Channel, &out.Scope, &out.MatchKind,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("converger: x1 fallback: %w", err)
	}
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	out.SourceTable = "subscriber_suppressions"
	out.hydrateFromMetadata()
	return out, nil
}

// fallbackLegacy probes the pre-X1 `suppressions` table. Marketing
// scope only — legacy rows have no scope column so we treat them as
// marketing-default unless the reason is one of the always-block
// classes.
func (c *SuppressionConverger) fallbackLegacy(
	ctx context.Context, tx pgx.Tx,
	tenantID, email, hashHex string,
	scope Scope,
) (*Entry, error) {
	out := &Entry{}
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, created_at
FROM suppressions
WHERE tenant_id = $1::uuid
  AND (email = $2 OR email_sha256 = $3)
LIMIT 1`, tenantID, email, hashHex).Scan(
		&out.ID, &out.TenantID, &out.Email, &out.Reason, &out.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("converger: legacy fallback: %w", err)
	}
	out.Source = SourceManual
	out.SourceTable = "suppressions"
	out.Channel = ChannelEmail
	out.Scope = ScopeMarketing
	out.MatchKind = "email"
	if !scopeAllows(out.Reason, scope) {
		return nil, nil
	}
	return out, nil
}

// fallbackMailchimp probes the email_suppressions table. Same scope
// caveat as the legacy fallback.
func (c *SuppressionConverger) fallbackMailchimp(
	ctx context.Context, tx pgx.Tx,
	tenantID, email string,
	scope Scope,
) (*Entry, error) {
	out := &Entry{}
	var meta []byte
	var rawReason string
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, reason, source,
       COALESCE(provider_event_id,''), suppressed_at, expires_at, metadata
FROM email_suppressions
WHERE tenant_id = $1::uuid
  AND email = $2
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`, tenantID, email).Scan(
		&out.ID, &out.TenantID, &out.Email, &rawReason, &out.Source,
		&out.ProviderEventID, &out.CreatedAt, &out.ExpiresAt, &meta,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("converger: mailchimp fallback: %w", err)
	}
	out.Reason = NormalizeReason(rawReason)
	if len(meta) > 0 {
		out.Metadata = decodeJSON(meta)
	}
	out.SourceTable = "email_suppressions"
	out.Channel = ChannelEmail
	out.Scope = ScopeMarketing
	out.MatchKind = "email"
	out.hydrateFromMetadata()
	if !scopeAllows(out.Reason, scope) {
		return nil, nil
	}
	return out, nil
}

// channelMatches returns true when a row's source/channel is compatible
// with the lookup channel. The unified view doesn't expose the channel
// column on legacy/Mailchimp rows so we lean on Source as a proxy: any
// row whose Source is one of the email-channel providers (postmark /
// mailgun / ses / manual / api / import) is treated as email. SMS / push
// will get explicit channel rows once those write paths land.
func channelMatches(src Source, want Channel) bool {
	if want == ChannelAny {
		return true
	}
	// Today every source we know about writes email. The X1 path's
	// dedicated channel column overrides this when present (the
	// converger reads it via the per-table fallback path).
	return want == ChannelEmail
}

// scopeAllows returns true when a row of `reason` should block a send
// targeting `want` scope. hard_bounce + global_unsubscribe always block
// regardless of stream because the address is structurally undeliverable
// or the user opted out of all communications.
func scopeAllows(reason Reason, want Scope) bool {
	if reason == ReasonHardBounce || reason == ReasonGlobalUnsubscribe {
		return true
	}
	if want == ScopeMarketing || want == ScopeAll {
		return true
	}
	// Transactional scope: only the always-block reasons above
	// trip; everything else is intentionally allowed through so a
	// password-reset / receipt email can still reach an address that
	// the marketing team has manually suppressed.
	return false
}
