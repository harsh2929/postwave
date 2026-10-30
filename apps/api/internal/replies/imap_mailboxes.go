// SPDX-License-Identifier: AGPL-3.0-only

// imap_mailboxes.go — the tenant-owned mailboxes the reply poller reads.
//
// Replies reach the platform two ways today, both PUSH: a provider webhook, or
// MX delivery to a per-tenant address. Neither helps a sender whose customers
// reply to a mailbox the tenant already owns, which is the common case for
// anyone migrating onto the platform. This is the PULL path.
//
// No credential ever lives in this struct. The row holds secret REFERENCES and
// the resolver holds the material, so a mailbox record — in a dump, a log line,
// or an error message — is worth nothing on its own.

package replies

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Mailbox is one configured IMAP source. Deliberately carries references, not
// credentials; see resolveMailboxCredentials for where material is fetched and
// how briefly it is held.
type Mailbox struct {
	ID                string
	TenantID          string
	Label             string
	Host              string
	Port              int
	UseTLS            bool
	Folder            string
	UsernameSecretRef string
	PasswordSecretRef string
	Enabled           bool

	// UIDValidity 0 means never polled. A real IMAP UIDVALIDITY is a non-zero
	// uint32, so the sentinel cannot collide with a server value.
	UIDValidity uint32
	LastUID     uint32
	Generation  int64
}

// NeverPolled reports whether this mailbox has no usable cursor yet.
//
// The distinction matters on the first poll: a mailbox with no cursor must NOT
// ingest its entire history as new replies. The poller starts from the current
// high-water mark instead, because a five-year-old message is not a reply to a
// campaign we sent this week.
func (m Mailbox) NeverPolled() bool { return m.UIDValidity == 0 }

type MailboxStore struct {
	Pool *db.Pool
}

// withWorkerScope sets the two-factor GUC the worker policies require.
//
// Two flags rather than one: the outbox scope is shared by every background
// worker, so on its own it would let any worker read every tenant's mailbox
// configuration. The second flag narrows that to this worker.
func withWorkerScope(ctx context.Context, pool *db.Pool) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.outbox_worker','true',true),
		        set_config('app.reply_imap_worker','true',true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("replies: reply IMAP worker scope: %w", err)
	}
	return tx, nil
}

// DueMailboxes returns enabled mailboxes ordered by least-recently-polled.
func (s *MailboxStore) DueMailboxes(ctx context.Context, limit int) ([]Mailbox, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("replies: mailbox store unavailable")
	}
	if limit <= 0 {
		limit = 25
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, label, host, port, use_tls, folder,
       username_secret_ref, password_secret_ref, enabled,
       uid_validity, last_uid, generation
  FROM reply_imap_mailboxes
 WHERE enabled
 ORDER BY last_polled_at NULLS FIRST, id
 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("replies: list due mailboxes: %w", err)
	}
	defer rows.Close()

	var out []Mailbox
	for rows.Next() {
		var mailbox Mailbox
		var uidValidity, lastUID int64
		if err := rows.Scan(&mailbox.ID, &mailbox.TenantID, &mailbox.Label,
			&mailbox.Host, &mailbox.Port, &mailbox.UseTLS, &mailbox.Folder,
			&mailbox.UsernameSecretRef, &mailbox.PasswordSecretRef, &mailbox.Enabled,
			&uidValidity, &lastUID, &mailbox.Generation); err != nil {
			return nil, fmt.Errorf("replies: scan mailbox: %w", err)
		}
		mailbox.UIDValidity = uint32(uidValidity)
		mailbox.LastUID = uint32(lastUID)
		out = append(out, mailbox)
	}
	return out, rows.Err()
}

// AdvanceCursor records progress after messages have been persisted.
//
// Called AFTER the replies commit, never before. A cursor advanced first and
// persisted second loses every message in the gap on a crash — silently, since
// the next poll starts above them. Re-reading a message is cheap because
// Persist deduplicates on the provider message id; skipping one is permanent.
func (s *MailboxStore) AdvanceCursor(
	ctx context.Context, mailboxID string, uidValidity, lastUID uint32, resetGeneration bool,
) error {
	if s == nil || s.Pool == nil {
		return errors.New("replies: mailbox store unavailable")
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	generationExpression := "generation"
	if resetGeneration {
		generationExpression = "generation + 1"
	}
	tag, err := tx.Exec(ctx, fmt.Sprintf(`
UPDATE reply_imap_mailboxes
   SET uid_validity = $2, last_uid = $3, generation = %s,
       last_polled_at = now(), last_error = NULL
 WHERE id = $1::uuid`, generationExpression),
		mailboxID, int64(uidValidity), int64(lastUID))
	if err != nil {
		return fmt.Errorf("replies: advance mailbox cursor: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("replies: mailbox %s not found for cursor advance", mailboxID)
	}
	return tx.Commit(ctx)
}

// RecordFailure stores why a poll failed WITHOUT touching the cursor.
//
// The cursor stays put so the next attempt re-reads the same range: a failure
// mid-batch must not look like progress. The message is truncated and carries
// no credential, because this column is read by operators and shipped to logs.
func (s *MailboxStore) RecordFailure(ctx context.Context, mailboxID, reason string) error {
	if s == nil || s.Pool == nil {
		return errors.New("replies: mailbox store unavailable")
	}
	reason = strings.TrimSpace(reason)
	if len(reason) > 2000 {
		reason = reason[:2000]
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE reply_imap_mailboxes
   SET last_polled_at = now(), last_error = $2
 WHERE id = $1::uuid`, mailboxID, reason); err != nil {
		return fmt.Errorf("replies: record mailbox failure: %w", err)
	}
	return tx.Commit(ctx)
}

// PollInterval is how often a mailbox is revisited. Modest on purpose: an IMAP
// server is someone else's infrastructure and a tight loop against a customer's
// provider is a good way to get the account rate-limited or locked.
const PollInterval = 2 * time.Minute
