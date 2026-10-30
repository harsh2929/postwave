// SPDX-License-Identifier: AGPL-3.0-only

package frequency

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

// Keep the worst-case advisory-lock footprint below the default PostgreSQL
// max_locks_per_transaction budget. The lock table is shared by every active
// backend, so thousands of stripes per large campaign can starve unrelated
// transactions even though the set is technically bounded. Sixty-four keeps
// million-recipient admission constant-space while preserving useful
// concurrency for smaller, disjoint audiences.
const frequencyAdmissionLockStripes uint32 = 64

// AdmissionResult is the authoritative in-transaction frequency decision.
// ReservationIDs names only rows inserted by this call, allowing a caller to
// undo them without deleting an older idempotent reservation when another
// admission authority later rejects the recipient.
type AdmissionResult struct {
	FilterResult
	ReservationIDs []int64
}

// AdmitAndReserveTx linearizes one batch per subscriber, evaluates the current
// tenant rules, and reserves every admitted recipient in subscriber_send_log.
// The caller must use the same transaction for recipient materialization and
// lifecycle state; rollback then releases both reservations and work.
func AdmitAndReserveTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID, channel string,
	candidates []string,
) (AdmissionResult, error) {
	var result AdmissionResult
	if tx == nil {
		return result, errors.New("frequency: admission transaction is required")
	}
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if tenantID == "" || campaignID == "" {
		return result, errors.New("frequency: admission tenant and campaign are required")
	}
	channel = normalizeChannel(channel)
	ordered, err := normalizeAdmissionCandidates(candidates)
	if err != nil {
		return result, err
	}
	if len(ordered) == 0 {
		result.Kept = []string{}
		return result, nil
	}

	// Hold canonical identity stable through the caller's commit. Rotations,
	// merges, and erasure take the exclusive side before subscriber row locks;
	// concurrent admissions retain per-recipient concurrency under this shared
	// tenant fence and the stripes below.
	if err := subscriberidentitylock.Shared(ctx, tx, tenantID); err != nil {
		return result, err
	}
	if err := lockAdmissionSubscribers(ctx, tx, tenantID, ordered); err != nil {
		return result, err
	}

	var evaluatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&evaluatedAt); err != nil {
		return result, fmt.Errorf("frequency: read admission clock: %w", err)
	}

	// A retry/requeue of the same campaign-recipient pair is idempotent. Its
	// existing reservation is already part of history and must neither be
	// counted twice nor cause the same work item to reject itself.
	existing := make(map[string]struct{})
	rows, err := tx.Query(ctx, `
SELECT lower(subscriber_email::text)
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND channel = $3
   AND subscriber_email = ANY($4::citext[])`, tenantID, campaignID, channel, ordered)
	if err != nil {
		return result, fmt.Errorf("frequency: inspect existing reservations: %w", err)
	}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			rows.Close()
			return result, fmt.Errorf("frequency: scan existing reservation: %w", err)
		}
		existing[email] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, fmt.Errorf("frequency: iterate existing reservations: %w", err)
	}
	rows.Close()

	rules, err := listActiveRules(ctx, tx, tenantID)
	if err != nil {
		return result, err
	}
	eligible := make([]string, 0, len(ordered))
	for _, email := range ordered {
		if _, alreadyReserved := existing[email]; !alreadyReserved {
			eligible = append(eligible, email)
		}
	}
	skipped := make(map[string]struct{})
	for _, rule := range rules {
		if len(eligible) == 0 || !ruleAppliesToChannel(rule, channel) {
			continue
		}
		over, err := overCapEmailsAt(ctx, tx, tenantID, eligible, rule, evaluatedAt.UTC())
		if err != nil {
			return result, fmt.Errorf("frequency: evaluate admission rule %s: %w", rule.ID, err)
		}
		if len(over) == 0 {
			continue
		}
		result.Breakdown = append(result.Breakdown, SkipBreakdown{
			RuleID: rule.ID, RuleLabel: rule.Label, Skipped: len(over),
		})
		overSet := make(map[string]struct{}, len(over))
		for _, email := range over {
			email = strings.ToLower(strings.TrimSpace(email))
			overSet[email] = struct{}{}
			skipped[email] = struct{}{}
		}
		next := make([]string, 0, len(eligible)-len(overSet))
		for _, email := range eligible {
			if _, blocked := overSet[email]; !blocked {
				next = append(next, email)
			}
		}
		eligible = next
	}

	result.Kept = make([]string, 0, len(ordered)-len(skipped))
	toReserve := make([]string, 0, len(eligible))
	eligibleSet := make(map[string]struct{}, len(eligible))
	for _, email := range eligible {
		eligibleSet[email] = struct{}{}
	}
	for _, email := range ordered {
		if _, blocked := skipped[email]; blocked {
			continue
		}
		result.Kept = append(result.Kept, email)
		if _, alreadyReserved := existing[email]; alreadyReserved {
			continue
		}
		if _, admitted := eligibleSet[email]; admitted {
			toReserve = append(toReserve, email)
		}
	}
	result.Skipped = len(skipped)
	if len(toReserve) == 0 {
		return result, nil
	}
	rows, err = tx.Query(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel, sent_at)
SELECT $1::uuid, email, $2::uuid, $3, $4
  FROM unnest($5::citext[]) AS email
RETURNING id`, tenantID, campaignID, channel, evaluatedAt.UTC(), toReserve)
	if err != nil {
		return result, fmt.Errorf("frequency: reserve admitted recipients: %w", err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, fmt.Errorf("frequency: scan reservation: %w", err)
		}
		result.ReservationIDs = append(result.ReservationIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, fmt.Errorf("frequency: iterate reservations: %w", err)
	}
	rows.Close()
	if len(result.ReservationIDs) != len(toReserve) {
		return result, errors.New("frequency: reservation count does not match admitted recipients")
	}
	return result, nil
}

// ReleaseReservationsTx removes only reservations inserted by one admission
// attempt. It is used when a later authority in the same transaction (such as
// a subscriber pause) refuses materialization but the retry lifecycle update
// still needs to commit.
func ReleaseReservationsTx(ctx context.Context, tx pgx.Tx, tenantID string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::bigint[])`, tenantID, ids)
	if err != nil {
		return fmt.Errorf("frequency: release admission reservations: %w", err)
	}
	if tag.RowsAffected() != int64(len(ids)) {
		return errors.New("frequency: admission reservation ownership changed")
	}
	return nil
}

func normalizeAdmissionCandidates(candidates []string) ([]string, error) {
	seen := make(map[string]struct{}, len(candidates))
	ordered := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		email := strings.ToLower(strings.TrimSpace(candidate))
		if email == "" {
			return nil, errors.New("frequency: admission candidate email is empty")
		}
		if _, duplicate := seen[email]; duplicate {
			continue
		}
		seen[email] = struct{}{}
		ordered = append(ordered, email)
	}
	return ordered, nil
}

func lockAdmissionSubscribers(ctx context.Context, tx pgx.Tx, tenantID string, emails []string) error {
	// A campaign can contain millions of recipients, while PostgreSQL advisory
	// locks consume shared lock-table entries. Bound each batch to a fixed stripe
	// set: equal normalized addresses always select the same tenant-scoped stripe;
	// collisions only serialize unrelated recipients and never weaken admission.
	ordered := admissionLockStripes(emails)
	batch := &pgx.Batch{}
	for _, stripe := range ordered {
		batch.Queue(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, tenantID, stripe)
	}
	results := tx.SendBatch(ctx, batch)
	for range ordered {
		if _, err := results.Exec(); err != nil {
			_ = results.Close()
			return fmt.Errorf("frequency: lock admission subscriber: %w", err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("frequency: close subscriber lock batch: %w", err)
	}
	return nil
}

func admissionLockStripes(emails []string) []int {
	stripeSet := make(map[uint32]struct{}, min(len(emails), int(frequencyAdmissionLockStripes)))
	for _, email := range emails {
		hasher := fnv.New32a()
		_, _ = hasher.Write([]byte(email))
		stripeSet[hasher.Sum32()%frequencyAdmissionLockStripes] = struct{}{}
	}
	ordered := make([]int, 0, len(stripeSet))
	for stripe := range stripeSet {
		ordered = append(ordered, int(stripe))
	}
	sort.Ints(ordered)
	return ordered
}

func overCapEmailsAt(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	candidates []string,
	rule Rule,
	now time.Time,
) ([]string, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	cutoff := now.Add(-time.Duration(rule.WindowHours) * time.Hour)
	var (
		rows pgx.Rows
		err  error
	)
	if len(rule.Channels) == 0 {
		rows, err = tx.Query(ctx, `
SELECT lower(subscriber_email::text)
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND sent_at >= $2
   AND subscriber_email = ANY($3::citext[])
 GROUP BY subscriber_email
HAVING count(*) >= $4`, tenantID, cutoff, candidates, rule.MaxSends)
	} else {
		rows, err = tx.Query(ctx, `
SELECT lower(subscriber_email::text)
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid
   AND channel = ANY($2::text[])
   AND sent_at >= $3
   AND subscriber_email = ANY($4::citext[])
 GROUP BY subscriber_email
HAVING count(*) >= $5`, tenantID, rule.Channels, cutoff, candidates, rule.MaxSends)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	over := make([]string, 0)
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		over = append(over, email)
	}
	return over, rows.Err()
}
