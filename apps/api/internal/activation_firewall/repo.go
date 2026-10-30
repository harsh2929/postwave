// SPDX-License-Identifier: AGPL-3.0-only
//
// repo.go — pgx persistence for activation_exclusion_receipts (0406)
// plus the consent adapter that bridges the firewall's slim
// ConsentBatchLookup to the existing consent package.
//
// All tenant-scoped reads/writes go through db.WithTenant (RLS-bound via
// the NULLIF tenant-GUC idiom). The Store interface lets handlers + the
// sync_runner / zerocopy wiring depend on a surface a fake can satisfy
// in tests; *Repo is the production Postgres implementation.
package activation_firewall

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a requested receipt run yields no rows in
// a context where the caller expects existence semantics.
var ErrNotFound = errors.New("activation_firewall: not found")

// receiptListCap bounds the compliance list endpoint + the CSV stream so
// one request can't read an unbounded result set.
const receiptListCap = 50_000

// ExclusionReceipt is one persisted row of activation_exclusion_receipts
// as read back for the list / download surfaces.
type ExclusionReceipt struct {
	ID              int64     `json:"id"`
	RunID           string    `json:"run_id"`
	RunType         string    `json:"run_type"`
	SubscriberEmail string    `json:"subscriber_email"`
	RuleClass       string    `json:"rule_class"`
	RuleReason      string    `json:"rule_reason"`
	ConsentEventID  *int64    `json:"consent_event_id,omitempty"`
	Purpose         string    `json:"purpose"`
	DestinationType string    `json:"destination_type"`
	ExcludedAt      time.Time `json:"excluded_at"`
	Signature       string    `json:"signature"`
}

// ListFilter narrows the compliance list endpoint.
type ListFilter struct {
	Since   *time.Time
	RunType string
	Purpose string
	Limit   int
}

// Store is the firewall's persistence surface. *Repo implements it;
// handler + wiring tests pass a fake.
type Store interface {
	// WriteExclusions persists a run's exclusion records and returns the
	// number of rows written. signKey is the per-row HMAC key.
	WriteExclusions(ctx context.Context, tenantID, runID, runType string, recs []ExclusionRecord, signKey string) (int, error)
	// CountExclusions returns how many receipts exist for one run.
	CountExclusions(ctx context.Context, tenantID, runID string) (int, error)
	// ListExclusionsForRun streams every receipt for one run (for the CSV
	// download), capped at receiptListCap.
	ListExclusionsForRun(ctx context.Context, tenantID, runID string) ([]ExclusionReceipt, error)
	// ListExclusions returns a filtered, paginated slice for the
	// compliance list endpoint.
	ListExclusions(ctx context.Context, tenantID string, f ListFilter) ([]ExclusionReceipt, error)
}

// Repo is the Postgres implementation of Store.
type Repo struct {
	Pool *db.Pool
}

// NewRepo constructs a Repo over a pool.
func NewRepo(pool *db.Pool) *Repo {
	return &Repo{Pool: pool}
}

const receiptColumns = `
id, run_id, run_type, subscriber_email, rule_class, rule_reason,
consent_event_id, purpose, destination_type, excluded_at, signature`

func scanReceipt(row pgx.Row) (ExclusionReceipt, error) {
	var r ExclusionReceipt
	if err := row.Scan(&r.ID, &r.RunID, &r.RunType, &r.SubscriberEmail,
		&r.RuleClass, &r.RuleReason, &r.ConsentEventID, &r.Purpose,
		&r.DestinationType, &r.ExcludedAt, &r.Signature); err != nil {
		return ExclusionReceipt{}, err
	}
	return r, nil
}

// WriteExclusions inserts one row per record inside a single
// tenant-scoped tx. The per-row signature is HMAC-SHA256(signKey,
// canonical-fields) so each receipt row is independently tamper-evident.
func (r *Repo) WriteExclusions(ctx context.Context, tenantID, runID, runType string, recs []ExclusionRecord, signKey string) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("activation_firewall: nil repo")
	}
	if len(recs) == 0 {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	excludedAt := time.Now().UTC()
	batch := &pgx.Batch{}
	for _, rec := range recs {
		sig := SignReceiptRow(signKey, tenantID, runID, rec, excludedAt)
		batch.Queue(`
INSERT INTO activation_exclusion_receipts (
    tenant_id, run_id, run_type, subscriber_email, rule_class, rule_reason,
    consent_event_id, purpose, destination_type, excluded_at, signature
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			tenantID, runID, runType, rec.SubscriberEmail, rec.RuleClass, rec.RuleReason,
			rec.ConsentEventID, rec.Purpose, rec.DestinationType, excludedAt, sig)
	}
	br := tx.SendBatch(ctx, batch)
	for range recs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return 0, err
		}
	}
	if err := br.Close(); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(recs), nil
}

// CountExclusions returns the receipt count for one run.
func (r *Repo) CountExclusions(ctx context.Context, tenantID, runID string) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("activation_firewall: nil repo")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM activation_exclusion_receipts
 WHERE tenant_id = $1::uuid AND run_id = $2`, tenantID, runID).Scan(&n); err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

// ListExclusionsForRun streams every receipt for one run, capped.
func (r *Repo) ListExclusionsForRun(ctx context.Context, tenantID, runID string) ([]ExclusionReceipt, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("activation_firewall: nil repo")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+receiptColumns+`
  FROM activation_exclusion_receipts
 WHERE tenant_id = $1::uuid AND run_id = $2
 ORDER BY id ASC
 LIMIT $3`, tenantID, runID, receiptListCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExclusionReceipt{}
	for rows.Next() {
		rec, err := scanReceipt(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListExclusions returns a filtered, paginated slice for the compliance
// list endpoint.
func (r *Repo) ListExclusions(ctx context.Context, tenantID string, f ListFilter) ([]ExclusionReceipt, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("activation_firewall: nil repo")
	}
	limit := f.Limit
	if limit <= 0 || limit > receiptListCap {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Build the predicate with positional args. tenant_id is always $1.
	args := []any{tenantID}
	where := "tenant_id = $1::uuid"
	if f.Since != nil {
		args = append(args, *f.Since)
		where += " AND excluded_at >= $" + strconv.Itoa(len(args))
	}
	if rt := strings.TrimSpace(f.RunType); rt != "" {
		args = append(args, rt)
		where += " AND run_type = $" + strconv.Itoa(len(args))
	}
	if p := strings.TrimSpace(f.Purpose); p != "" {
		args = append(args, p)
		where += " AND purpose = $" + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	q := `
SELECT ` + receiptColumns + `
  FROM activation_exclusion_receipts
 WHERE ` + where + `
 ORDER BY excluded_at DESC, id DESC
 LIMIT $` + strconv.Itoa(len(args))

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExclusionReceipt{}
	for rows.Next() {
		rec, err := scanReceipt(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SignReceiptRow computes the per-row HMAC-SHA256 over the canonical
// field concatenation. The same scheme is reused by the download
// endpoint for the X-Postwave-Receipt-Signature header (D2). An empty
// signKey yields an empty signature — the column is still written so the
// row exists; the receipt simply isn't cryptographically verifiable
// (degraded mode logged at startup).
func SignReceiptRow(signKey, tenantID, runID string, rec ExclusionRecord, excludedAt time.Time) string {
	if strings.TrimSpace(signKey) == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString(tenantID)
	b.WriteByte('.')
	b.WriteString(runID)
	b.WriteByte('.')
	b.WriteString(rec.SubscriberEmail)
	b.WriteByte('.')
	b.WriteString(rec.RuleClass)
	b.WriteByte('.')
	b.WriteString(rec.RuleReason)
	b.WriteByte('.')
	b.WriteString(rec.Purpose)
	b.WriteByte('.')
	b.WriteString(rec.DestinationType)
	b.WriteByte('.')
	b.WriteString(strconv.FormatInt(excludedAt.Unix(), 10))
	mac := hmac.New(sha256.New, []byte(signKey))
	mac.Write([]byte(b.String()))
	return hex.EncodeToString(mac.Sum(nil))
}

// PurposeBatchAdapter bridges the firewall's ConsentBatchLookup to the same
// consent.PurposeLookup used by the send loop. Delegation is deliberate: it
// keeps campaign delivery and audience activation on one eligibility rule.
// For email marketing, the subscriber-level projection is necessary but not
// sufficient; the exact canonical subscribers.email must also have a
// subscribed, unsuppressed subscriber_emails row.
type PurposeBatchAdapter struct {
	Pool *db.Pool
}

// AllowedBatch resolves per-purpose consent in one tenant-scoped query. Every
// address in a successfully validated bounded batch is present in the returned
// map, including missing subscribers and missing/revoked address projections
// (false). Any error is returned so the firewall records a fail-deny policy
// exclusion; post-validation configuration and database errors also retain the
// lookup's preinitialized denial map.
func (a *PurposeBatchAdapter) AllowedBatch(ctx context.Context, tenantID string, emails []string, purpose string) (map[string]bool, error) {
	var pool *db.Pool
	if a != nil {
		pool = a.Pool
	}
	out, err := (&consent.PurposeLookup{Pool: pool}).AllowedBatch(ctx, tenantID, emails, purpose)
	if err != nil {
		return out, fmt.Errorf("activation_firewall: purpose consent lookup: %w", err)
	}
	return out, nil
}
