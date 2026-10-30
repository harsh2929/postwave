package subscribers

// signup_source.go — helpers for the subscribers.signup_source column
// added by migration 0303. Source-based automation filtering
// (archive-source-based-automation-filter, P3): Buttondown lets operators
// filter subscribers AND branch automations by signup source (embedded form,
// hosted page, import, API, integration) so welcome flows can fork on origin
// without manual tagging.
//
// This file is intentionally small and additive — the read/write SQL for
// signup_source is folded into the existing INSERT/UPDATE statements in
// repo.go via the resolveSignupSource helper here, so the diff stays
// minimal and the (already-out-of-band-broken) identify.go path keeps
// compiling without further surgery.

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SetSignupSource flips the signup_source column for an existing row.
// Used by integration adapters (Stripe / Shopify / Slack OAuth flows)
// that discover the subscriber's true origin asynchronously and need to
// upgrade the column without doing a full PATCH.
//
// Only touches rows whose current signup_source is still the placeholder
// 'unknown' — a contact that already self-identified via a real capture
// path must NOT be silently repainted by a later integration sync (that
// would break the welcome-flow branch the contact entered through).
//
// Validation is in-process so a buggy adapter cannot poison the DB
// CHECK constraint and trigger a noisy tx rollback at the bottom of
// the call stack.
func (r *Repo) SetSignupSource(ctx context.Context, tenantID, id, source string) error {
	v := NormalizeSignupSource(source)
	if !ValidSignupSource(v) {
		return fmt.Errorf("invalid signup_source %q", source)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE subscribers
   SET signup_source = $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
   AND signup_source = 'unknown'`, tenantID, id, v)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// CountBySignupSource returns the per-source subscriber counts for a
// tenant — the data the segment-builder summary card and the
// automation-trigger preview both render. Keyed by signup_source value
// (embedded_form, hosted_page, …) so the caller can render in any order.
//
// Subscribers in 'blocklisted' state are excluded since they cannot enter
// any new automation flow — counting them would mislead the operator
// about the addressable audience of a source-branched welcome.
func (r *Repo) CountBySignupSource(ctx context.Context, tenantID string) (map[string]int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT signup_source, count(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND status <> 'blocklisted'
 GROUP BY signup_source`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Seed every legal source so the response shape is stable even when
	// a tenant has zero subscribers in that bucket. The segment-builder
	// UI relies on this to render disabled/0 chips alongside populated
	// ones rather than hiding the option entirely.
	out := map[string]int{
		SignupSourceEmbeddedForm: 0,
		SignupSourceHostedPage:   0,
		SignupSourceImport:       0,
		SignupSourceAPI:          0,
		SignupSourceIntegration:  0,
		SignupSourceUnknown:      0,
	}
	for rows.Next() {
		var src string
		var n int
		if err := rows.Scan(&src, &n); err != nil {
			return nil, err
		}
		out[src] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// resolveSignupSource is the central capture-path resolver. Order:
//  1. explicit caller value (after CHECK-vocabulary normalisation)
//  2. consent_source-derived fallback
//  3. SignupSourceUnknown
//
// Called by Repo.Upsert once per write so every entry point lands on
// the same vocabulary without each call site re-implementing the
// inference. Returned value is always CHECK-safe.
func resolveSignupSource(explicit, consent string) string {
	v := NormalizeSignupSource(explicit)
	if v != SignupSourceUnknown {
		return v
	}
	return SignupSourceFromConsent(consent)
}
