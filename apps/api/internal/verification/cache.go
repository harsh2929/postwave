// SPDX-License-Identifier: AGPL-3.0-only
//
// cache.go — the tenant-scoped verdict cache.
//
// This is the single highest-leverage cost control in the package. A
// customer who imports the same CSV twice, or re-verifies a segment
// after editing it, would otherwise pay twice for identical answers.
//
// Cache identity is (tenant_id, normalized_email). Scoping per tenant
// rather than globally is deliberate even though a verdict is not
// really tenant-specific: a shared cache would let one customer learn,
// by timing or by a zero-credit response, which addresses another
// customer has verified. That is a real cross-tenant information leak,
// and it is not worth the credits it would save.

package verification

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// VerificationEvidenceRetention bounds address-level verification and derived
// health history. Terminal verdicts outlive the reusable-credit TTL so a cache
// janitor cannot silently re-enable a known trap/invalid address, but they are
// not retained as plaintext forever. Reverification refreshes this window;
// explicit tenant invalidation can remove a cache row sooner.
const VerificationEvidenceRetention = 365 * 24 * time.Hour

// MaxCacheInvalidationAddresses bounds one lock-taking transaction. Every
// address acquires a tenant-scoped advisory lock and may archive chronology;
// allowing an authenticated request to submit an unbounded list would turn the
// maintenance endpoint into a long-lived transaction/lock amplifier.
const MaxCacheInvalidationAddresses = 1000

var (
	ErrCacheInvalidationTooLarge = errors.New("verification: cache invalidation exceeds the address limit")
	ErrCacheInvalidationInput    = errors.New("verification: cache invalidation contains an invalid address")
)

// TenantCache implements ResultCache against verification_cache for a
// single tenant.
type TenantCache struct {
	Store    *Store
	TenantID string
	TTL      time.Duration
	// Now overrides the clock, for tests.
	Now func() time.Time
}

func (c *TenantCache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now().UTC()
}

func (c *TenantCache) ttl() time.Duration {
	if c.TTL <= 0 {
		return DefaultCacheTTL
	}
	if c.TTL > MaxCacheTTL {
		return MaxCacheTTL
	}
	return c.TTL
}

// Get implements ResultCache.
//
// The returned map is keyed by the address string the CALLER supplied,
// not the normalized form, because that is what the chain will look
// up. Normalizing only for the database lookup keeps "Someone@X.com"
// and "someone@x.com" sharing one cached verdict without forcing the
// caller to pre-normalize.
func (c *TenantCache) Get(ctx context.Context, emails []string) (map[string]Result, error) {
	if c.Store == nil || c.Store.Pool == nil || len(emails) == 0 {
		return map[string]Result{}, nil
	}

	// normalized -> every original spelling that maps to it.
	originals := make(map[string][]string, len(emails))
	lookup := make([]string, 0, len(emails))
	for _, e := range emails {
		n := NormalizeEmail(e)
		if _, seen := originals[n]; !seen {
			lookup = append(lookup, n)
		}
		originals[n] = append(originals[n], e)
	}

	tx, err := db.WithTenant(ctx, c.Store.Pool, c.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT email, status, sub_status, score, domain, free_email, role_account,
		        disposable, mx_found, mx_record, did_you_mean, first_name, last_name,
		        gender, country, city, provider, checked_at
		   FROM verification_cache
		  WHERE tenant_id = $1::uuid
		    AND email = ANY($2::text[])
		    AND expires_at > now()`,
		c.TenantID, lookup)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]Result, len(lookup))
	for rows.Next() {
		var (
			r         Result
			normal    string
			score     *int16
			subStatus string
			status    string
		)
		if err := rows.Scan(&normal, &status, &subStatus, &score, &r.Domain, &r.FreeEmail,
			&r.RoleAccount, &r.Disposable, &r.MXFound, &r.MXRecord, &r.DidYouMean,
			&r.FirstName, &r.LastName, &r.Gender, &r.Country, &r.City,
			&r.Provider, &r.CheckedAt); err != nil {
			return nil, err
		}
		r.Status = Status(status)
		r.SubStatus = SubStatus(subStatus)
		if score != nil {
			v := int(*score)
			r.Score = &v
		}
		r.Email = normal
		if err := validatePersistableResult(r); err != nil {
			// Do not serve malformed legacy evidence and do not expose its fields
			// in an error. A caller must not spend again while the cache's prior
			// paid-result state is untrustworthy.
			return nil, ErrCacheUnavailable
		}
		for _, original := range originals[normal] {
			hit := r
			hit.Email = original
			out[original] = hit
		}
	}
	return out, rows.Err()
}

// Put implements ResultCache.
//
// Writes are upserts on (tenant_id, email): a newer verdict always
// wins, and the expiry window restarts from the new observation.
func (c *TenantCache) Put(ctx context.Context, results []Result) error {
	if c.Store == nil || c.Store.Pool == nil || len(results) == 0 {
		return nil
	}
	expiresAt := c.now().Add(c.ttl())

	tx, err := db.WithTenant(ctx, c.Store.Pool, c.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Collapse duplicates before the write. Keep the first result, matching the
	// chain's first-seen normalization contract, then lock addresses in sorted
	// order so overlapping batches cannot deadlock each other.
	byEmail := make(map[string]Result, len(results))
	for _, r := range results {
		normal := NormalizeEmail(r.Email)
		r.Email = normal
		if err := validatePersistableResult(r); err != nil {
			return fmt.Errorf("verification: refusing to cache a result outside the canonical contract: %w", err)
		}
		if _, exists := byEmail[normal]; !exists {
			byEmail[normal] = r
		}
	}
	emails := make([]string, 0, len(byEmail))
	for email := range byEmail {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	for _, normal := range emails {
		r := byEmail[normal]
		if err := lockVerificationEvidenceAddress(ctx, tx, c.TenantID, normal); err != nil {
			return err
		}
		materializedAt := c.now().UTC()
		// Archive an existing terminal cache fact before any replacement. This is
		// load-bearing for an Unknown/catch-all refresh: neither is affirmative
		// recovery and therefore cannot erase a known invalid/trap verdict.
		if err := preserveCachedTerminalEvidence(
			ctx, tx, c.TenantID, normal, materializedAt,
		); err != nil {
			return err
		}

		var score *int16
		if r.Score != nil {
			v := int16(*r.Score)
			score = &v
		}
		checkedAt := r.CheckedAt
		if checkedAt.IsZero() {
			checkedAt = c.now()
		}
		checkedAt = checkedAt.UTC()
		// Materialize mailbox chronology in the same transaction as its cache
		// write. Background jobs therefore retain terminal history and trusted
		// recovery even when nobody calls the health endpoint before cache expiry.
		switch {
		case r.Status.Decisive():
			if err := preserveTerminalResultEvidence(
				ctx, tx, c.TenantID, normal, r.Status, score, r.Provider,
				checkedAt, materializedAt,
			); err != nil {
				return err
			}
		case r.Status == StatusValid && trustedMailboxVerificationProvider(r.Provider):
			if err := preserveTrustedValidResultEvidence(
				ctx, tx, c.TenantID, normal, score, r.Provider,
				checkedAt, materializedAt,
			); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(ctx,
			`INSERT INTO verification_cache
			     (tenant_id, email, status, sub_status, score, domain, free_email,
			      role_account, disposable, mx_found, mx_record, did_you_mean,
			      first_name, last_name, gender, country, city, provider,
			      checked_at, expires_at)
			 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
			         $13, $14, $15, $16, $17, $18, $19, $20)
			 ON CONFLICT (tenant_id, email) DO UPDATE
			    SET status = EXCLUDED.status, sub_status = EXCLUDED.sub_status,
			        score = EXCLUDED.score, domain = EXCLUDED.domain,
			        free_email = EXCLUDED.free_email, role_account = EXCLUDED.role_account,
			        disposable = EXCLUDED.disposable, mx_found = EXCLUDED.mx_found,
			        mx_record = EXCLUDED.mx_record, did_you_mean = EXCLUDED.did_you_mean,
			        first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
			        gender = EXCLUDED.gender, country = EXCLUDED.country,
			        city = EXCLUDED.city, provider = EXCLUDED.provider,
			        checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at`,
			c.TenantID, normal, string(r.Status), string(r.SubStatus), score, r.Domain,
			r.FreeEmail, r.RoleAccount, r.Disposable, r.MXFound, r.MXRecord, r.DidYouMean,
			r.FirstName, r.LastName, r.Gender, r.Country, r.City, r.Provider,
			checkedAt, expiresAt); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Invalidate drops reusable cached verdicts for specific addresses so the next
// verification is forced to re-check them. Derived health snapshots are retained
// deliberately: invalidating a cache entry is not affirmative mailbox recovery,
// and deleting terminal evidence here would create an immediate send-eligibility
// gap before that re-check completes. A newer trusted verification result retires
// retained terminal evidence through the health resolver/send gate chronology.
func (c *TenantCache) Invalidate(ctx context.Context, emails []string) (int64, error) {
	if len(emails) == 0 {
		return 0, nil
	}
	normalized, err := normalizeCacheInvalidationAddresses(emails)
	if err != nil {
		return 0, err
	}
	if c.Store == nil || c.Store.Pool == nil {
		return 0, nil
	}

	tx, err := db.WithTenant(ctx, c.Store.Pool, c.TenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize delete/reverify races even when no cache row currently exists.
	// The same sorted address locks are used by Put, so a terminal fact is
	// always archived either before deletion or before replacement.
	sort.Strings(normalized)
	for _, email := range normalized {
		if err := lockVerificationEvidenceAddress(ctx, tx, c.TenantID, email); err != nil {
			return 0, err
		}
		if err := preserveCachedTerminalEvidence(
			ctx, tx, c.TenantID, email, c.now().UTC(),
		); err != nil {
			return 0, err
		}
	}

	var removed int64
	if err := tx.QueryRow(ctx, `
WITH requested(email) AS (
       SELECT DISTINCT unnest($2::text[])
), deleted_cache AS (
       DELETE FROM verification_cache AS cache
        USING requested
        WHERE cache.tenant_id = $1::uuid
          AND cache.email = requested.email
       RETURNING cache.email
)
SELECT count(*) FROM deleted_cache`, c.TenantID, normalized).Scan(&removed); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return removed, nil
}

func normalizeCacheInvalidationAddresses(emails []string) ([]string, error) {
	if len(emails) > MaxCacheInvalidationAddresses {
		return nil, ErrCacheInvalidationTooLarge
	}
	for _, raw := range emails {
		normalized := NormalizeEmail(raw)
		if normalized == "" || len(raw) > maxPersistedVerificationEmailBytes ||
			len(normalized) > maxPersistedVerificationEmailBytes ||
			hasUnsafeControlText(raw) {
			return nil, ErrCacheInvalidationInput
		}
	}
	normalized := dedupeNormalized(emails)
	if len(normalized) == 0 || len(normalized) > MaxCacheInvalidationAddresses {
		return nil, ErrCacheInvalidationInput
	}
	return normalized, nil
}

// lockVerificationEvidenceAddress is the serialization boundary for cache
// replacement and invalidation. A transaction-scoped advisory lock is needed
// even when the address has no row yet; row locks alone cannot close the
// concurrent terminal-insert/Unknown-insert race. Tenant id is part of the
// hashed key, and all multi-address callers acquire keys in sorted order.
func lockVerificationEvidenceAddress(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
) error {
	_, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended($1::text || E'\x1f' || $2::text, 0)
)`, tenantID, email)
	return err
}

// preserveCachedTerminalEvidence snapshots the current cache fact before a
// mutation can replace or delete it. The conflict predicate is chronological:
// a stale terminal result cannot overwrite a newer validation snapshot, while
// an equal-time terminal wins over a non-terminal fact fail-closed.
func preserveCachedTerminalEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	materializedAt time.Time,
) error {
	_, err := tx.Exec(ctx, `
WITH terminal AS (
    SELECT status, score, provider, checked_at
      FROM verification_cache
     WHERE tenant_id = $1::uuid
       AND email = $2
       AND status IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
     FOR UPDATE
)
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, evidence_at, verification_status, verification_score,
    verification_provider, verification_checked_at, model_version, computed_at
)
SELECT $1::uuid, $2, 'F', 'blocked', false,
       ARRAY['verification_' || terminal.status], '[]'::jsonb,
       terminal.checked_at, terminal.status, terminal.score, terminal.provider,
       terminal.checked_at, $3, $4
  FROM terminal
ON CONFLICT (tenant_id, email) DO UPDATE SET
    grade = 'F', recommendation = 'blocked',
    hard_stop = email_health_snapshots.hard_stop,
    reason_codes = CASE
        WHEN EXCLUDED.reason_codes[1] = ANY(email_health_snapshots.reason_codes)
            THEN email_health_snapshots.reason_codes
        WHEN cardinality(email_health_snapshots.reason_codes) < 64
            THEN email_health_snapshots.reason_codes || EXCLUDED.reason_codes
        ELSE email_health_snapshots.reason_codes
    END,
    evidence = email_health_snapshots.evidence,
    evidence_at = CASE
        WHEN email_health_snapshots.evidence_at IS NULL THEN EXCLUDED.evidence_at
        WHEN EXCLUDED.evidence_at IS NULL THEN email_health_snapshots.evidence_at
        ELSE greatest(email_health_snapshots.evidence_at, EXCLUDED.evidence_at)
    END,
    verification_status = EXCLUDED.verification_status,
    verification_score = EXCLUDED.verification_score,
    verification_provider = EXCLUDED.verification_provider,
    verification_checked_at = EXCLUDED.verification_checked_at,
    model_version = EXCLUDED.model_version,
    computed_at = EXCLUDED.computed_at
WHERE email_health_snapshots.verification_checked_at IS NULL
   OR EXCLUDED.verification_checked_at > email_health_snapshots.verification_checked_at
   OR (
       EXCLUDED.verification_checked_at = email_health_snapshots.verification_checked_at
       AND COALESCE(email_health_snapshots.verification_status, '') NOT IN
           ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
   )`, tenantID, email, HealthModelVersion, materializedAt)
	return err
}

func preserveTerminalResultEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	status Status,
	score *int16,
	provider string,
	checkedAt, materializedAt time.Time,
) error {
	_, err := tx.Exec(ctx, `
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, evidence_at, verification_status, verification_score,
    verification_provider, verification_checked_at, model_version, computed_at
) VALUES (
    $1::uuid, $2, 'F', 'blocked', false, ARRAY['verification_' || $3],
    '[]'::jsonb, $6, $3, $4, $5, $6, $7, $8
)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    grade = 'F', recommendation = 'blocked',
    hard_stop = email_health_snapshots.hard_stop,
    reason_codes = CASE
        WHEN EXCLUDED.reason_codes[1] = ANY(email_health_snapshots.reason_codes)
            THEN email_health_snapshots.reason_codes
        WHEN cardinality(email_health_snapshots.reason_codes) < 64
            THEN email_health_snapshots.reason_codes || EXCLUDED.reason_codes
        ELSE email_health_snapshots.reason_codes
    END,
    evidence = email_health_snapshots.evidence,
    evidence_at = CASE
        WHEN email_health_snapshots.evidence_at IS NULL THEN EXCLUDED.evidence_at
        WHEN EXCLUDED.evidence_at IS NULL THEN email_health_snapshots.evidence_at
        ELSE greatest(email_health_snapshots.evidence_at, EXCLUDED.evidence_at)
    END,
    verification_status = EXCLUDED.verification_status,
    verification_score = EXCLUDED.verification_score,
    verification_provider = EXCLUDED.verification_provider,
    verification_checked_at = EXCLUDED.verification_checked_at,
    model_version = EXCLUDED.model_version,
    computed_at = EXCLUDED.computed_at
WHERE email_health_snapshots.verification_checked_at IS NULL
   OR EXCLUDED.verification_checked_at > email_health_snapshots.verification_checked_at
   OR (
       EXCLUDED.verification_checked_at = email_health_snapshots.verification_checked_at
       AND COALESCE(email_health_snapshots.verification_status, '') NOT IN
           ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
   )`, tenantID, email, string(status), score, provider, checkedAt,
		HealthModelVersion, materializedAt)
	return err
}

// preserveTrustedValidResultEvidence durably records affirmative recovery so
// deleting an expired reusable cache row cannot resurrect an older terminal
// snapshot. On conflict it updates only verification chronology and retention;
// complaint/consent evidence, hard-stop authority, and their derived grade are
// deliberately left intact for the resolver/canonical suppression gate.
func preserveTrustedValidResultEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, email string,
	score *int16,
	provider string,
	checkedAt, materializedAt time.Time,
) error {
	_, err := tx.Exec(ctx, `
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, evidence_at, verification_status, verification_score,
    verification_provider, verification_checked_at, model_version, computed_at
) VALUES (
    $1::uuid, $2, 'A', 'send', false, ARRAY['verification_valid_30d'],
    '[]'::jsonb, $5, 'valid', $3, $4, $5, $6, $7
)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    evidence_at = CASE
        WHEN email_health_snapshots.evidence_at IS NULL THEN EXCLUDED.evidence_at
        ELSE greatest(email_health_snapshots.evidence_at, EXCLUDED.evidence_at)
    END,
    verification_status = EXCLUDED.verification_status,
    verification_score = EXCLUDED.verification_score,
    verification_provider = EXCLUDED.verification_provider,
    verification_checked_at = EXCLUDED.verification_checked_at,
    model_version = EXCLUDED.model_version,
    computed_at = EXCLUDED.computed_at
WHERE email_health_snapshots.verification_checked_at IS NULL
   OR EXCLUDED.verification_checked_at > email_health_snapshots.verification_checked_at`,
		tenantID, email, score, provider, checkedAt, HealthModelVersion, materializedAt)
	return err
}

// CacheSummary is the per-status rollup the dashboard renders.
type CacheSummary struct {
	Total     int64            `json:"total"`
	ByStatus  map[string]int64 `json:"by_status"`
	OldestAt  *time.Time       `json:"oldest_checked_at,omitempty"`
	NewestAt  *time.Time       `json:"newest_checked_at,omitempty"`
	ExpiringN int64            `json:"expiring_within_7d"`
}

// Summary reports what the tenant currently has cached.
func (c *TenantCache) Summary(ctx context.Context) (CacheSummary, error) {
	out := CacheSummary{ByStatus: map[string]int64{}}
	if c.Store == nil || c.Store.Pool == nil {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, c.Store.Pool, c.TenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT status, count(*), min(checked_at), max(checked_at),
		        count(*) FILTER (WHERE expires_at < now() + interval '7 days')
		   FROM verification_cache
		  WHERE tenant_id = $1::uuid AND expires_at > now()
		  GROUP BY status`, c.TenantID)
	if err != nil {
		return out, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			status         string
			n, expiring    int64
			oldest, newest *time.Time
		)
		if err := rows.Scan(&status, &n, &oldest, &newest, &expiring); err != nil {
			return out, err
		}
		out.ByStatus[status] = n
		out.Total += n
		out.ExpiringN += expiring
		if oldest != nil && (out.OldestAt == nil || oldest.Before(*out.OldestAt)) {
			out.OldestAt = oldest
		}
		if newest != nil && (out.NewestAt == nil || newest.After(*out.NewestAt)) {
			out.NewestAt = newest
		}
	}
	return out, rows.Err()
}

// PurgeExpired deletes expired rows across all tenants. Called by the
// maintenance worker.
//
// This runs WITHOUT a tenant GUC because it is a cross-tenant
// janitorial sweep; it is therefore restricted to the expiry predicate
// only and never reads row contents.
func (s *Store) PurgeExpired(ctx context.Context, limit int) (int64, error) {
	if s.Pool == nil {
		return 0, errors.New("verification: no database pool configured")
	}
	if limit <= 0 {
		limit = 10000
	}
	// Give abandoned non-terminal jobs a durable completion boundary before
	// applying the existing 365-day item-retention rule. This runs independently
	// of the provider runner, so a disabled/crash-looping runner cannot retain
	// plaintext address rows forever.
	if _, err := s.expireStaleJobs(ctx, limit); err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-VerificationEvidenceRetention)
	tag, err := tx.Exec(ctx,
		`DELETE FROM verification_cache
		  WHERE ctid IN (
		      SELECT ctid FROM verification_cache
		       WHERE expires_at <= now()
		         AND (
		             status NOT IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
		             OR checked_at <= $2
		         )
		       LIMIT $1
		  )`, limit, cutoff)
	if err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	removed := tag.RowsAffected()

	tag, err = tx.Exec(ctx, `
DELETE FROM email_health_snapshots
 WHERE ctid IN (
       SELECT ctid FROM email_health_snapshots
        WHERE computed_at <= $2
        LIMIT $1
 )`, limit, cutoff)
	if err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	removed += tag.RowsAffected()

	// Per-address job receipts are useful for reconciliation but contain PII.
	// Keep aggregate job/accounting rows, delete terminal item detail after the
	// same window, and scrub operator-supplied source/idempotency metadata.
	tag, err = tx.Exec(ctx, `
DELETE FROM verification_job_items AS item
 WHERE item.ctid IN (
       SELECT candidate.ctid
         FROM verification_job_items AS candidate
         JOIN verification_jobs AS job
           ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
        WHERE job.status IN ('completed', 'failed', 'canceled')
          AND job.completed_at <= $2
        LIMIT $1
 )`, limit, cutoff)
	if err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	removed += tag.RowsAffected()

	if _, err := tx.Exec(ctx, `
WITH candidates AS (
    SELECT ctid
      FROM verification_jobs
     WHERE status IN ('completed', 'failed', 'canceled')
       AND completed_at <= $1
       AND (source_ref <> '' OR idempotency_key <> '' OR request_fingerprint <> ''
            OR created_by IS NOT NULL)
     ORDER BY completed_at, id
     LIMIT $2
)
UPDATE verification_jobs AS job
   SET source_ref = '', idempotency_key = '', request_fingerprint = '',
       created_by = NULL
  FROM candidates
 WHERE job.ctid = candidates.ctid`, cutoff, limit); err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}

	// Public-form paid-verification identities and their exact-attempt receipts
	// contain hashes and closed decision codes only, but their replay authority
	// is intentionally bounded to 24h. Deleting the identity cascades its linked
	// attempts, so one bounded sweep retires the complete spend fence atomically.
	// FORCE RLS restricts the worker to already-expired identities.
	tag, err = tx.Exec(ctx, `
DELETE FROM verification_signup_identities
 WHERE ctid IN (
       SELECT ctid FROM verification_signup_identities
        WHERE expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
 )`, limit)
	if err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	removed += tag.RowsAffected()
	if err := tx.Commit(ctx); err != nil {
		observeVerificationCachePurge(0, err)
		return 0, err
	}
	observeVerificationCachePurge(removed, nil)
	return removed, nil
}

// RecordUsage folds one batch's accounting into the daily rollup the
// credits dashboard reads.
func (s *Store) RecordUsage(ctx context.Context, tenantID, provider string, stats ChainStats) error {
	if s.Pool == nil || stats.Total == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`INSERT INTO verification_usage_daily
		     (tenant_id, day, provider, verified, credits_spent, local_filtered, cache_hits)
		 VALUES ($1::uuid, current_date, $2, $3, $4, $5, $6)
		 ON CONFLICT (tenant_id, day, provider) DO UPDATE
		    SET verified       = verification_usage_daily.verified + EXCLUDED.verified,
		        credits_spent  = verification_usage_daily.credits_spent + EXCLUDED.credits_spent,
		        local_filtered = verification_usage_daily.local_filtered + EXCLUDED.local_filtered,
		        cache_hits     = verification_usage_daily.cache_hits + EXCLUDED.cache_hits,
		        updated_at     = now()`,
		tenantID, provider, stats.Total, stats.CreditsSpent,
		stats.LocalFiltered, stats.CacheHits); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// UsagePoint is one day of the usage series.
type UsagePoint struct {
	Day           string `json:"day"`
	Provider      string `json:"provider"`
	Verified      int    `json:"verified"`
	CreditsSpent  int    `json:"credits_spent"`
	LocalFiltered int    `json:"local_filtered"`
	CacheHits     int    `json:"cache_hits"`
}

// Usage returns the daily series for the last `days` days.
func (s *Store) Usage(ctx context.Context, tenantID string, days int) ([]UsagePoint, error) {
	if s.Pool == nil {
		return []UsagePoint{}, nil
	}
	if days <= 0 || days > 365 {
		days = 30
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT to_char(day, 'YYYY-MM-DD'), provider, verified, credits_spent,
		        local_filtered, cache_hits
		   FROM verification_usage_daily
		  WHERE tenant_id = $1::uuid
		    AND day >= current_date - make_interval(days => $2)
		  ORDER BY day DESC, provider`, tenantID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []UsagePoint{}
	for rows.Next() {
		var p UsagePoint
		if err := rows.Scan(&p.Day, &p.Provider, &p.Verified, &p.CreditsSpent,
			&p.LocalFiltered, &p.CacheHits); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
