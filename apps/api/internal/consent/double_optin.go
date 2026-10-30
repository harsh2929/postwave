// SPDX-License-Identifier: AGPL-3.0-only
//
// double_optin.go — TTL store + sweep worker for the Mailchimp-parity
// "60-day pending" behaviour. Migration 0248 lands the table; this
// file owns: (1) the typed handle that issues / confirms tokens, and
// (2) the Purger worker that sweeps expired rows and downgrades the
// associated unconfirmed subscriber to disabled.
//
// Why this isn't piggybacking on consent_records: the consent ledger
// is append-only; this is a mutable inbox of pending confirmations
// that get either flipped to confirmed_at or hard-deleted at TTL. The
// two stores answer different questions for the regulator vs the
// product.

package consent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// DefaultDoubleOptInTTL mirrors the Mailchimp parity: 60 days from
// the sent_at timestamp. Past this point the worker deletes the
// pending row and the associated unconfirmed subscriber.
const DefaultDoubleOptInTTL = 60 * 24 * time.Hour

// PurgeBatchSize bounds how many rows the sweep worker processes per
// tick. Pickup small enough that one stuck batch can't starve the
// rest of the worker pool.
const PurgeBatchSize = 200

// PurgeInterval is the gap between sweeps. 6h matches the historical
// Mailchimp cadence and keeps the worker quiet enough that ops won't
// notice it.
const PurgeInterval = 6 * time.Hour

// PendingInput is the request to issue a double-opt-in token.
type PendingInput struct {
	TenantID string
	Email    string
	ListID   string // optional
	TTL      time.Duration
}

// PendingIssued is what IssuePending returns so the caller can
// embed the plaintext token in the confirmation email body.
type PendingIssued struct {
	ID        string
	Token     string // plaintext; only available here at issuance
	ExpiresAt time.Time
}

// IssuePending inserts a new double_optin_pending row, returning the
// plaintext token the caller must email to the subscriber. The token
// is stored only as sha256 hash, so a DB dump alone can't confirm
// anyone.
func IssuePending(ctx context.Context, pool *db.Pool, in PendingInput) (*PendingIssued, error) {
	if pool == nil {
		return nil, errors.New("consent: pool required")
	}
	if in.TenantID == "" || strings.TrimSpace(in.Email) == "" {
		return nil, errors.New("consent: tenant_id + email required")
	}
	ttl := in.TTL
	if ttl <= 0 {
		ttl = DefaultDoubleOptInTTL
	}
	token, err := newDoubleOptInToken()
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256([]byte(token))
	hashHex := hex.EncodeToString(hash[:])
	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var listIDArg any
	if in.ListID != "" {
		listIDArg = in.ListID
	}
	expires := time.Now().UTC().Add(ttl)
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO double_optin_pending
  (tenant_id, email, list_id, token_hash, sent_at, expires_at)
VALUES ($1::uuid, $2, $3::uuid, $4, now(), $5)
RETURNING id::text`,
		in.TenantID, strings.ToLower(strings.TrimSpace(in.Email)),
		listIDArg, hashHex, expires).Scan(&id)
	if err != nil {
		// Duplicate token_hash within a tenant is statistically
		// impossible (32 bytes random) but we map the error anyway.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, fmt.Errorf("token collision (try again): %w", err)
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &PendingIssued{ID: id, Token: token, ExpiresAt: expires}, nil
}

// ConfirmPending flips confirmed_at on the matching row. Returns true
// when a row was updated (caller can then activate the subscriber);
// false when the token is unknown / already-expired / already-confirmed.
func ConfirmPending(ctx context.Context, pool *db.Pool, tenantID, token string) (bool, string, error) {
	if pool == nil || tenantID == "" || token == "" {
		return false, "", errors.New("consent: tenant_id + token required")
	}
	hash := sha256.Sum256([]byte(token))
	hashHex := hex.EncodeToString(hash[:])
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	err = tx.QueryRow(ctx, `
UPDATE double_optin_pending
   SET confirmed_at = now()
 WHERE token_hash = $1
   AND confirmed_at IS NULL
   AND expires_at > now()
 RETURNING email::text`, hashHex).Scan(&email)
	if err != nil {
		// pgx.ErrNoRows wraps as "no rows in result set" — treat that
		// as "token is bad / expired" rather than a 500.
		if strings.Contains(err.Error(), "no rows") {
			return false, "", tx.Commit(ctx)
		}
		return false, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, "", err
	}
	return true, email, nil
}

// SendConfirmation emails the plaintext token to the subscriber via
// the transactional mailer. publicBaseURL + path build the link the
// subscriber clicks. Nil-mailer callers (tests) get nil error.
func SendConfirmation(ctx context.Context, m mailer.Mailer, from, publicBaseURL, email, token string) error {
	if m == nil {
		return nil
	}
	link := strings.TrimRight(publicBaseURL, "/") + "/api/public/double-optin/confirm?token=" + token
	return m.Send(ctx, mailer.Message{
		From:    from,
		To:      email,
		Subject: "Confirm your subscription",
		Body: "Thanks for subscribing!\n\n" +
			"Please confirm your email address by clicking the link below:\n\n" +
			link + "\n\n" +
			"If you didn't subscribe, ignore this email — your address will be removed automatically.\n",
		Tags: map[string]string{"purpose": "double_optin"},
	})
}

// Purger sweeps expired double_optin_pending rows. Runs cross-tenant
// under app.outbox_worker so it doesn't need to be aware of tenants —
// the migration 0248 RLS leaves the worker free to read/delete rows
// when the bypass GUC is set.
type Purger struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// BatchSize defaults to PurgeBatchSize when zero.
	BatchSize int
}

// Run blocks until ctx is cancelled, ticking every PurgeInterval.
// SweepOnce is exposed for tests + the on-demand /worker/purge admin
// endpoint we might add later.
func (p *Purger) Run(ctx context.Context) {
	t := time.NewTicker(PurgeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := p.SweepOnce(ctx)
			if err != nil {
				if p.Logger != nil {
					p.Logger.Warn("double_optin_purger sweep failed", "err", err.Error())
				}
				continue
			}
			if n > 0 && p.Logger != nil {
				p.Logger.Info("double_optin_purger swept", "purged", n)
			}
		}
	}
}

// SweepOnce processes one batch. Returns the number of pending rows
// purged. Also downgrades the matching unconfirmed subscriber to
// disabled (mirrors Mailchimp's behaviour: unconfirmed past TTL is
// removed from the active audience).
//
// Worker bypass: this runs without a tenant GUC and relies on the
// outbox-style policies migration 0248 should ship with. If those
// policies aren't present yet, the worker reads zero rows — safe
// degradation, the data isn't deleted.
func (p *Purger) SweepOnce(ctx context.Context) (int, error) {
	if p.Pool == nil {
		return 0, nil
	}
	batch := p.BatchSize
	if batch <= 0 {
		batch = PurgeBatchSize
	}
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Cross-tenant bypass. The setting is local to this tx so it
	// can't leak to other connections from the pool.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return 0, fmt.Errorf("set worker bypass: %w", err)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, email::text
  FROM double_optin_pending
 WHERE confirmed_at IS NULL
   AND expires_at < now()
 ORDER BY expires_at ASC
 LIMIT $1
 FOR UPDATE SKIP LOCKED`, batch)
	if err != nil {
		return 0, err
	}
	type expiredRow struct {
		ID, TenantID, Email string
	}
	expired := []expiredRow{}
	for rows.Next() {
		var er expiredRow
		if err := rows.Scan(&er.ID, &er.TenantID, &er.Email); err != nil {
			rows.Close()
			return 0, err
		}
		expired = append(expired, er)
	}
	rows.Close()
	if len(expired) == 0 {
		return 0, tx.Commit(ctx)
	}
	purged := 0
	for _, er := range expired {
		if _, err := tx.Exec(ctx,
			`DELETE FROM double_optin_pending WHERE id = $1::uuid`, er.ID); err != nil {
			return purged, err
		}
		// Best-effort downgrade. We do not error if the matching
		// subscriber row no longer exists — the customer may have
		// already deleted them through the privacy portal.
		_, _ = tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'disabled'
 WHERE tenant_id = $1::uuid
   AND lower(email) = lower($2)
   AND status = 'unconfirmed'`,
			er.TenantID, er.Email)
		purged++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return purged, nil
}

// newDoubleOptInToken returns 32 bytes of crypto-random data hex-encoded.
// 64 chars is short enough to fit in a URL without paren-wrapping mail
// clients yet long enough to be unguessable.
func newDoubleOptInToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
