// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// signupSnapshot reloads a committed submission, its form, and the target
// lists that are still the tenant's, under tenant RLS. ErrNotFound when the
// submission no longer exists.
func (r *Repo) signupSnapshot(ctx context.Context, tenantID, submissionID string) (*signupSnapshot, error) {
	if _, err := uuid.Parse(submissionID); err != nil {
		return nil, fmt.Errorf("forms: signup names an invalid submission id: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	snap := &signupSnapshot{TenantID: tenantID}
	var (
		customFields []byte
		listIDs      []string
	)
	err = tx.QueryRow(ctx, `
SELECT s.id::text, s.form_id::text, f.name, s.email::text, COALESCE(s.name, ''),
       s.status, COALESCE(host(s.ip), ''), COALESCE(s.user_agent, ''),
       COALESCE(s.signup_source, ''), s.custom_fields, s.submitted_at,
       s.confirmed_at, s.target_list_ids::text[]
  FROM form_submissions s
  JOIN forms f ON f.id = s.form_id AND f.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1::uuid
   AND s.id = $2::uuid`, tenantID, submissionID).Scan(
		&snap.SubmissionID, &snap.FormID, &snap.FormName, &snap.Email, &snap.Name,
		&snap.Status, &snap.IP, &snap.UserAgent,
		&snap.SignupSource, &customFields, &snap.SubmittedAt,
		&snap.ConfirmedAt, &listIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("forms: load signup submission: %w", err)
	}
	if len(customFields) > 0 {
		if err = json.Unmarshal(customFields, &snap.CustomFields); err != nil {
			return nil, fmt.Errorf("forms: decode submission fields: %w", err)
		}
	}
	if snap.Lists, err = mappedTargetListsInTx(ctx, tx, tenantID, listIDs); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return snap, nil
}

// mappedTargetListsInTx returns the Listmonk ids of the submission's target
// lists, in the submission's order. A list deleted since the submission has no
// mapping left and is skipped: there is nothing to join.
func mappedTargetListsInTx(ctx context.Context, tx pgx.Tx, tenantID string, listIDs []string) ([]TargetList, error) {
	if len(listIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND postwave_uuid = ANY($2::uuid[])`, tenantID, listIDs)
	if err != nil {
		return nil, fmt.Errorf("forms: load submission lists: %w", err)
	}
	engineIDs := make(map[string]int64, len(listIDs))
	for rows.Next() {
		var listID string
		var engineID int64
		if err := rows.Scan(&listID, &engineID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("forms: load submission lists: %w", err)
		}
		engineIDs[strings.ToLower(listID)] = engineID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("forms: load submission lists: %w", err)
	}
	out := make([]TargetList, 0, len(listIDs))
	for _, listID := range listIDs {
		if engineID, ok := engineIDs[strings.ToLower(listID)]; ok {
			out = append(out, TargetList{EngineID: engineID, ListID: listID})
		}
	}
	return out, nil
}

// latestConfirmedSubmissionID finds the submission a confirmation event
// written before migration 2049 (which named the address, not the
// submission) refers to: the address's most recently confirmed submission of
// the form.
func (r *Repo) latestConfirmedSubmissionID(ctx context.Context, tenantID, formID, email string) (string, error) {
	if _, err := uuid.Parse(formID); err != nil || strings.TrimSpace(email) == "" {
		return "", ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM form_submissions
 WHERE tenant_id = $1::uuid
   AND form_id = $2::uuid
   AND email = $3
   AND status = 'confirmed'
 ORDER BY confirmed_at DESC NULLS LAST, submitted_at DESC, id DESC
 LIMIT 1`, tenantID, formID, email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("forms: find confirmed submission: %w", err)
	}
	return id, tx.Commit(ctx)
}
