// SPDX-License-Identifier: AGPL-3.0-only
//
// purpose.go — per-purpose consent state-of-record lookup.
//
// Migration 0261 adds five consent_*_at columns to subscribers,
// fed by a BEFORE INSERT trigger on consent_events. This file
// surfaces the read side: a slim, fail-closed lookup the send loop
// (and other activation paths) call before delivering a message
// for a given purpose+channel pair.
//
// The contract is:
//
//   ok, err := IsConsentedForPurpose(ctx, pool, tenantID, email, PurposeAIProcessing)
//
// A nil pool returns (false, nil) — callers stub it out in tests.
// A missing subscriber row returns (false, nil) — no recorded
// consent ≠ consent denial error.
//
// Email marketing has two necessary projections: the subscriber-level
// consent vector and the exact canonical address row in subscriber_emails.
// Missing or unavailable evidence is never interpreted as permission to send.

package consent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const purposeLookupBatchMaxEmails = 1000

// Purpose is the canonical per-purpose key. The string values
// match the consent_events.category values where they overlap; the
// extra "sms_marketing" purpose has no direct category yet (SMS
// opt-in writes go through sms_consent_events) but the column
// exists so the gate is uniform.
type Purpose string

const (
	PurposeEmailMarketing Purpose = "email_marketing"
	PurposeSMSMarketing   Purpose = "sms_marketing"
	PurposeProfiling      Purpose = "profiling"
	PurposeTargetedAds    Purpose = "targeted_ads"
	PurposeAIProcessing   Purpose = "ai_processing"
)

// columnForPurpose returns the subscribers column name for a purpose,
// or "" for unknown.
func columnForPurpose(p Purpose) string {
	switch p {
	case PurposeEmailMarketing:
		return "consent_email_marketing_at"
	case PurposeSMSMarketing:
		return "consent_sms_marketing_at"
	case PurposeProfiling:
		return "consent_profiling_at"
	case PurposeTargetedAds:
		return "consent_targeted_ads_at"
	case PurposeAIProcessing:
		return "consent_ai_processing_at"
	}
	return ""
}

// IsConsentedForPurpose returns true iff subscribers.consent_<purpose>_at
// is non-null for the given (tenant, email).
//
// Nil pool / empty inputs / unknown purpose → (false, nil).
// Missing subscriber row → (false, nil).
func IsConsentedForPurpose(ctx context.Context, pool *db.Pool, tenantID, email string, p Purpose) (bool, error) {
	if pool == nil {
		return false, nil
	}
	tenantID = strings.TrimSpace(tenantID)
	email = strings.ToLower(strings.TrimSpace(email))
	if tenantID == "" || email == "" {
		return false, nil
	}
	if columnForPurpose(p) == "" {
		return false, nil
	}
	return lookupPurposeEligibility(ctx, pool, tenantID, email, p)
}

// purposeEligibilityExpression is intentionally built only from the closed
// Purpose vocabulary. For email marketing the legacy subscriber projection is
// necessary but not sufficient: the exact canonical subscribers.email must
// also have a subscribed, unsuppressed address row owned by the same profile.
// The lower(email::text) shape matches subscriber_emails_unique_email_idx.
func purposeEligibilityExpression(p Purpose) (string, error) {
	col := columnForPurpose(p)
	if col == "" {
		return "", errors.New("unknown consent purpose")
	}
	// Archive is a reversible storage state but an absolute activation stop.
	// Including it in the final purpose gate also protects static audiences that
	// were frozen before the profile was archived.
	legacyProjection := "s.archived_at IS NULL AND s." + col + " IS NOT NULL"
	if p != PurposeEmailMarketing {
		return legacyProjection, nil
	}
	return `(` + legacyProjection + ` AND EXISTS (
    SELECT 1
      FROM subscriber_emails AS se
     WHERE se.tenant_id = s.tenant_id
       AND se.subscriber_id = s.id
       AND lower(se.email::text) = lower(s.email::text)
       AND se.consent_status = 'subscribed'
       AND se.suppressed = false
))`, nil
}

func lookupPurposeEligibility(ctx context.Context, pool *db.Pool, tenantID, email string, p Purpose) (bool, error) {
	expression, err := purposeEligibilityExpression(p)
	if err != nil {
		return false, err
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Identifier interpolation is safe: expression is assembled exclusively
	// from purposeEligibilityExpression's closed vocabulary.
	q := "SELECT " + expression + " FROM subscribers AS s WHERE s.tenant_id = $1::uuid AND s.email = $2::citext LIMIT 1"
	var ok bool
	if err := tx.QueryRow(ctx, q, tenantID, email).Scan(&ok); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return false, err
			}
			return false, nil
		}
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return ok, nil
}

// PurposeLookup is the sending-package-facing interface. Wrapping
// the package-level helper behind an interface lets the send loop
// stub it in tests without importing db.
type PurposeLookup struct {
	Pool *db.Pool
}

// Allowed reports whether the (tenant, email) pair is consented for
// the given purpose. Missing wiring, unknown purposes, and lookup errors
// all fail closed: unavailable evidence is not permission to send.
func (l *PurposeLookup) Allowed(ctx context.Context, tenantID, email, purpose string) (bool, error) {
	if l == nil || l.Pool == nil {
		return false, errors.New("consent purpose lookup unavailable")
	}
	p := Purpose(strings.TrimSpace(purpose))
	if columnForPurpose(p) == "" {
		return false, errors.New("unknown consent purpose")
	}
	parsedTenant, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return false, errors.New("invalid consent tenant")
	}
	normalizedEmail, err := normalizeTrackingEmail(email)
	if err != nil {
		return false, fmt.Errorf("invalid consent email: %w", err)
	}
	ok, err := lookupPurposeEligibility(ctx, l.Pool, parsedTenant.String(), normalizedEmail, p)
	if err != nil {
		return false, err
	}
	return ok, nil
}

// AllowedBatch resolves a bounded recipient batch in one tenant-scoped query.
// On a successfully validated batch, the returned map contains every
// normalized requested address, including subscribers or address projections
// that were not found; those entries remain false so an incomplete result can
// never be mistaken for permission to send. Post-validation configuration and
// database errors preserve that preinitialized denial map alongside the error.
func (l *PurposeLookup) AllowedBatch(ctx context.Context, tenantID string, emails []string, purpose string) (map[string]bool, error) {
	denied, normalized, err := normalizePurposeLookupBatch(emails)
	if err != nil {
		return denied, err
	}
	if l == nil || l.Pool == nil {
		return denied, errors.New("consent purpose lookup unavailable")
	}
	p := Purpose(strings.TrimSpace(purpose))
	expression, err := purposeEligibilityExpression(p)
	if err != nil {
		return denied, err
	}
	parsedTenant, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return denied, errors.New("invalid consent tenant")
	}
	if len(normalized) == 0 {
		return denied, nil
	}
	result := make(map[string]bool, len(denied))
	for email := range denied {
		result[email] = false
	}

	tx, err := db.WithTenant(ctx, l.Pool, parsedTenant.String())
	if err != nil {
		return denied, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Join the normalized input set so PostgreSQL can hash it once while RLS
	// scans the tenant slice. A citext ANY predicate is not leakproof and cannot
	// be pushed through the subscribers security barrier, which otherwise makes
	// its per-row array comparison increasingly expensive on large tenants.
	q := "SELECT requested.email, " + expression +
		" FROM unnest($2::text[]) AS requested(email)" +
		" JOIN subscribers AS s ON s.tenant_id = $1::uuid" +
		" AND lower(s.email::text) = requested.email"
	rows, err := tx.Query(ctx, q, parsedTenant.String(), normalized)
	if err != nil {
		return denied, err
	}
	defer rows.Close()
	for rows.Next() {
		var email string
		var allowed bool
		if err := rows.Scan(&email, &allowed); err != nil {
			return denied, err
		}
		result[strings.ToLower(strings.TrimSpace(email))] = allowed
	}
	if err := rows.Err(); err != nil {
		return denied, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return denied, err
	}
	return result, nil
}

func normalizePurposeLookupBatch(emails []string) (map[string]bool, []string, error) {
	if len(emails) > purposeLookupBatchMaxEmails {
		return map[string]bool{}, nil, fmt.Errorf("consent purpose batch exceeds %d recipients", purposeLookupBatchMaxEmails)
	}
	denied := make(map[string]bool, len(emails))
	normalized := make([]string, 0, len(emails))
	seen := make(map[string]struct{}, len(emails))
	for _, raw := range emails {
		key := strings.ToLower(strings.TrimSpace(raw))
		if key != "" {
			denied[key] = false
		}
		email, err := normalizeTrackingEmail(raw)
		if err != nil {
			return denied, nil, fmt.Errorf("invalid consent email: %w", err)
		}
		if _, exists := seen[email]; exists {
			continue
		}
		seen[email] = struct{}{}
		denied[email] = false
		normalized = append(normalized, email)
	}
	return denied, normalized, nil
}
