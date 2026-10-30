// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// confirmationTarget loads a submission with its form and workspace name
// under tenant RLS. ErrNotFound when the submission no longer exists.
func (r *Repo) confirmationTarget(ctx context.Context, tenantID, submissionID string) (*confirmationTarget, error) {
	if _, err := uuid.Parse(submissionID); err != nil {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	target := &confirmationTarget{TenantID: tenantID}
	var (
		state    string
		settings []byte
	)
	err = tx.QueryRow(ctx, `
SELECT s.id::text, s.email, COALESCE(s.confirmation_token, ''), s.status,
       s.confirmation_expires_at, COALESCE(s.confirmation_email_state, ''),
       f.id::text, f.slug, f.name, f.settings, t.name
  FROM form_submissions s
  JOIN forms f ON f.id = s.form_id AND f.tenant_id = s.tenant_id
  JOIN tenants t ON t.id = s.tenant_id
 WHERE s.tenant_id = $1::uuid
   AND s.id = $2::uuid`, tenantID, submissionID).Scan(
		&target.SubmissionID, &target.Email, &target.Token, &target.Status,
		&target.ExpiresAt, &state,
		&target.Form.ID, &target.Form.Slug, &target.Form.Name, &settings, &target.WorkspaceName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("forms: load confirmation target: %w", err)
	}
	target.EmailState = ConfirmationEmailState(state)
	target.Form.TenantID = tenantID
	if len(settings) > 0 {
		if err := json.Unmarshal(settings, &target.Form.Settings); err != nil {
			return nil, fmt.Errorf("forms: decode form settings: %w", err)
		}
	}
	return target, tx.Commit(ctx)
}

// recordConfirmationEmail stores the last outcome of a submission's
// confirmation email.
func (r *Repo) recordConfirmationEmail(ctx context.Context, tenantID, submissionID string, state ConfirmationEmailState) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE form_submissions
   SET confirmation_email_state = $3, confirmation_email_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, submissionID, string(state)); err != nil {
		return fmt.Errorf("forms: record confirmation email outcome: %w", err)
	}
	return tx.Commit(ctx)
}

// confirmationsSentSince counts the workspace's confirmation emails sent
// since a time, whoever sent them. The standard sender's hourly cap counts
// them all, so it never lets more through than its limit.
func (r *Repo) confirmationsSentSince(ctx context.Context, tenantID string, since time.Time) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM form_submissions
 WHERE tenant_id = $1::uuid
   AND confirmation_email_state = 'sent'
   AND confirmation_email_at >= $2`, tenantID, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("forms: count sent confirmation emails: %w", err)
	}
	return n, tx.Commit(ctx)
}

// requireMailboxProof turns a single opt-in submission that could not
// subscribe its address (it had opted out) into a pending one with a fresh
// confirmation link, and queues the confirmation email in the same
// transaction. Clicking the link is verified consent, which may reverse the
// opt-out. It changes nothing once the submission has left the confirmed
// state or has a link, so a redelivered event sends no second email.
func (r *Repo) requireMailboxProof(ctx context.Context, tenantID, formID, submissionID string, out OutboxAppender) error {
	if out == nil {
		return errors.New("forms: no outbox is configured to send the confirmation email")
	}
	token, err := NewConfirmationToken()
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE form_submissions
   SET status = 'pending',
       confirmed_at = NULL,
       confirmation_token = $3,
       confirmation_expires_at = now() + interval '30 days',
       confirmation_email_state = 'queued',
       confirmation_email_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'confirmed'
   AND confirmation_token IS NULL`, tenantID, submissionID, token)
	if err != nil {
		return fmt.Errorf("forms: make the submission pending: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if err := appendConfirmationSend(ctx, tx, out, tenantID, formID, submissionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func appendConfirmationSend(ctx context.Context, tx pgx.Tx, out OutboxAppender, tenantID, formID, submissionID string) error {
	if _, err := out.Append(ctx, tx, OutboxAppendInput{
		TenantID: tenantID,
		Kind:     OutboxKindSendConfirmation,
		Payload:  confirmationSendPayload{TenantID: tenantID, FormID: formID, SubmissionID: submissionID},
	}); err != nil {
		return fmt.Errorf("forms: queue the confirmation email: %w", err)
	}
	return nil
}
