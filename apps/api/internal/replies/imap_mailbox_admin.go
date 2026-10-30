package replies

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Tenant-facing management of the IMAP reply mailboxes.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The registry, its RLS and its poller shipped with F05; the tenant-facing half
// never did. `MailboxStore` carried only DueMailboxes/AdvanceCursor/RecordFailure —
// all poller verbs, all running under `withWorkerScope` — so connecting a reply
// mailbox meant an operator writing SQL against the table by hand. Migration
// 1975 anticipated this: its tenant policy comment says the permissive policy
// exists "to permit the tenant INSERT", which is a policy written for a caller
// that was not built.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
// It never accepts, stores or returns a credential. `username_secret_ref` and
// `password_secret_ref` are REFERENCES into an external secret store. The HTTP
// boundary confines them to a tenant-specific namespace and the worker repeats
// that check before resolution; the database's broader scheme CHECK is storage
// integrity, not authorization. An operator provisions the secret out of band,
// so an IMAP password never transits this API and never lands in its logs.
//
// ── TENANT SCOPE ───────────────────────────────────────────────────────────
// Every query here runs inside `db.WithTenant`, so the existing
// `reply_imap_mailboxes_tenant` policy — `tenant_id = NULLIF(current_setting(
// 'app.tenant_id', true), '')::uuid` — is what isolates the rows. That is the
// same GUC idiom the rest of the schema uses, and the reason these methods do NOT
// reuse the poller's `withWorkerScope`: the worker policy is deliberately
// tenant-blind so the poller can discover what is due before it knows whose it is,
// and running an operator's request under it would defeat the isolation entirely.

// ErrMailboxNotFound is returned when a mailbox is absent for this tenant.
var ErrMailboxNotFound = errors.New("replies: imap mailbox not found")

// ErrMailboxConflict is returned when the (host, folder, username) triple is
// already registered for this tenant — the table's UNIQUE constraint.
var ErrMailboxConflict = errors.New("replies: imap mailbox already registered")

var (
	ErrMailboxUnsafeConfiguration = errors.New("replies: insecure imap mailbox configuration")
	ErrMailboxSecurityQuarantined = errors.New("replies: imap mailbox is security quarantined")
)

// MailboxSummary is the tenant-visible view of a registered mailbox.
//
// It carries the secret REFS rather than any secret, because an operator needs to
// see which reference a row points at in order to fix a mis-typed one — and a ref
// is not sensitive, which is the whole point of storing a ref.
type MailboxSummary struct {
	ID                       string `json:"id"`
	Label                    string `json:"label"`
	Host                     string `json:"host"`
	Port                     int    `json:"port"`
	UseTLS                   bool   `json:"use_tls"`
	Folder                   string `json:"folder"`
	UsernameSecretRef        string `json:"username_secret_ref"`
	PasswordSecretRef        string `json:"password_secret_ref"`
	Enabled                  bool   `json:"enabled"`
	LastPolledAt             string `json:"last_polled_at,omitempty"`
	LastError                string `json:"last_error,omitempty"`
	SecurityQuarantinedAt    string `json:"security_quarantined_at,omitempty"`
	SecurityQuarantineReason string `json:"security_quarantine_reason,omitempty"`
}

// NewMailbox is the create input. Port, TLS and folder have server-side defaults
// matching the column defaults, so a caller may send the three fields that
// genuinely have no sensible default and nothing else.
type NewMailbox struct {
	Label             string
	Host              string
	Port              int
	UseTLS            *bool
	Folder            string
	UsernameSecretRef string
	PasswordSecretRef string
}

const mailboxSelectColumns = `id::text, label, host, port, use_tls, folder,
       username_secret_ref, password_secret_ref, enabled,
       COALESCE(to_char(last_polled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
       COALESCE(last_error, ''),
       COALESCE(to_char(security_quarantined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
       COALESCE(security_quarantine_reason, '')`

func scanMailboxSummary(row pgx.Row) (MailboxSummary, error) {
	var out MailboxSummary
	if err := row.Scan(&out.ID, &out.Label, &out.Host, &out.Port, &out.UseTLS,
		&out.Folder, &out.UsernameSecretRef, &out.PasswordSecretRef, &out.Enabled,
		&out.LastPolledAt, &out.LastError, &out.SecurityQuarantinedAt,
		&out.SecurityQuarantineReason); err != nil {
		return MailboxSummary{}, err
	}
	return out, nil
}

// ListMailboxes returns this tenant's registered mailboxes, newest first.
func (s *MailboxStore) ListMailboxes(ctx context.Context, tenantID string) ([]MailboxSummary, error) {
	if s == nil || s.Pool == nil {
		return nil, fmt.Errorf("replies: mailbox store is not configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT `+mailboxSelectColumns+`
  FROM reply_imap_mailboxes
 ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]MailboxSummary, 0, 8)
	for rows.Next() {
		summary, scanErr := scanMailboxSummary(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, summary)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	return out, tx.Commit(ctx)
}

// CreateMailbox registers a mailbox, DISABLED.
//
// Disabled is not a courtesy default; it is the column default and the migration
// explains why: "A mailbox appears in the table the moment an operator starts
// configuring it, and polling someone's live inbox because a row exists is not a
// mistake worth making." So creation never begins polling, and enabling is a
// separate, deliberate call.
func (s *MailboxStore) CreateMailbox(ctx context.Context, tenantID string, in NewMailbox) (MailboxSummary, error) {
	if s == nil || s.Pool == nil {
		return MailboxSummary{}, fmt.Errorf("replies: mailbox store is not configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return MailboxSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	port := in.Port
	if port == 0 {
		port = 993
	}
	folder := strings.TrimSpace(in.Folder)
	if folder == "" {
		folder = "INBOX"
	}
	// Implicit TLS unless the caller explicitly says otherwise. The column comment
	// is explicit that downgrading is a deliberate act, so an omitted field must
	// not be read as "plaintext is fine".
	useTLS := true
	if in.UseTLS != nil {
		useTLS = *in.UseTLS
	}
	if !useTLS || port != secureIMAPPort ||
		!ValidTenantSecretReference(tenantID, in.UsernameSecretRef) ||
		!ValidTenantSecretReference(tenantID, in.PasswordSecretRef) {
		return MailboxSummary{}, ErrMailboxUnsafeConfiguration
	}

	row := tx.QueryRow(ctx, `
INSERT INTO reply_imap_mailboxes
       (tenant_id, label, host, port, use_tls, folder,
        username_secret_ref, password_secret_ref, enabled)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, false)
RETURNING `+mailboxSelectColumns,
		tenantID, strings.TrimSpace(in.Label), strings.TrimSpace(in.Host), port,
		useTLS, folder, strings.TrimSpace(in.UsernameSecretRef),
		strings.TrimSpace(in.PasswordSecretRef))

	summary, err := scanMailboxSummary(row)
	if err != nil {
		if isUniqueViolation(err) {
			return MailboxSummary{}, ErrMailboxConflict
		}
		return MailboxSummary{}, err
	}
	return summary, tx.Commit(ctx)
}

// SetMailboxEnabled starts or stops polling for one mailbox.
func (s *MailboxStore) SetMailboxEnabled(ctx context.Context, tenantID, mailboxID string, enabled bool) (MailboxSummary, error) {
	if s == nil || s.Pool == nil {
		return MailboxSummary{}, fmt.Errorf("replies: mailbox store is not configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return MailboxSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanMailboxSummary(tx.QueryRow(ctx, `
SELECT `+mailboxSelectColumns+`
  FROM reply_imap_mailboxes
 WHERE id = $1::uuid
 FOR UPDATE`, mailboxID))
	if errors.Is(err, pgx.ErrNoRows) {
		return MailboxSummary{}, ErrMailboxNotFound
	}
	if err != nil {
		return MailboxSummary{}, err
	}
	if enabled && (current.SecurityQuarantinedAt != "" || !current.UseTLS ||
		current.Port != secureIMAPPort ||
		!ValidTenantSecretReference(tenantID, current.UsernameSecretRef) ||
		!ValidTenantSecretReference(tenantID, current.PasswordSecretRef)) {
		return MailboxSummary{}, ErrMailboxSecurityQuarantined
	}

	row := tx.QueryRow(ctx, `
UPDATE reply_imap_mailboxes
   SET enabled = $2, updated_at = now()
 WHERE id = $1::uuid
RETURNING `+mailboxSelectColumns, mailboxID, enabled)

	summary, err := scanMailboxSummary(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return MailboxSummary{}, ErrMailboxNotFound
	}
	if err != nil {
		return MailboxSummary{}, err
	}
	return summary, tx.Commit(ctx)
}

// DeleteMailbox removes a mailbox and, with it, its poll cursor.
//
// A later replacement starts at the mailbox's then-current high-water mark, as
// PlanFetch requires for every never-polled registration. Replies that arrived
// while no registration existed can therefore be skipped. DisableMailbox is the
// cursor-preserving choice when an operator may resume polling later.
func (s *MailboxStore) DeleteMailbox(ctx context.Context, tenantID, mailboxID string) error {
	if s == nil || s.Pool == nil {
		return fmt.Errorf("replies: mailbox store is not configured")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `DELETE FROM reply_imap_mailboxes WHERE id = $1::uuid`, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrMailboxNotFound
	}
	return tx.Commit(ctx)
}

// isUniqueViolation reports a Postgres 23505 without importing pgconn at every
// call site.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}
