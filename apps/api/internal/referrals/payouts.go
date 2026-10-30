// SPDX-License-Identifier: AGPL-3.0-only
//
// Referral payouts (desktop audit A10).
//
// A payout row is the operator-facing fulfilment record for ONE
// (referrer, milestone) pair: "alice unlocked the 5-referral reward —
// has she been paid yet?". Rows live in referral_payouts (migration
// 0374, tenant-RLS) and move pending → approved → paid.
//
// Row generation — two producers, both idempotent via the
// (tenant_id, referrer, milestone_count) unique index:
//
//  1. Event-driven: the congrats worker (congrats_sender.go) already
//     detects the exact conversion that crossed a milestone boundary;
//     its tick now calls Repo.EnsurePendingPayout for each unlock.
//  2. Derive-on-read backstop: ListPayouts first recomputes achieved
//     milestones from referral_conversions (same fraud/credit filters
//     as the rest of the package) and inserts any missing rows as
//     'pending'. This covers tenants where the mailer-backed worker
//     isn't running and conversions that predate the table — the row
//     is persisted on first read, after which only its status changes.
//     The pass is TTL-guarded per tenant (payoutDeriveTTL, in-memory):
//     repeated or concurrent reads within the window skip re-derivation
//     so a hot payouts page / CSV export doesn't re-issue thousands of
//     ON CONFLICT DO NOTHING INSERTs per request.
package referrals

import (
	"context"
	"encoding/csv"

	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// errPayoutNotFound / errPayoutBadTransition let the HTTP layer pick
// 404 vs 409 without string-matching SQL errors.
var (
	errPayoutNotFound      = errors.New("referrals: payout not found")
	errPayoutBadTransition = errors.New("referrals: invalid payout status transition")
)

// PayoutRow is one milestone reward awaiting (or past) fulfilment.
type PayoutRow struct {
	ID          string    `json:"id"`
	ReferrerID  string    `json:"referrer_id"`
	Milestone   int       `json:"milestone"`
	RewardLabel string    `json:"reward_label"`
	Status      string    `json:"status"` // pending | approved | paid
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// EnsurePendingPayout records that referrerID achieved the milestone.
// Idempotent: re-running for an already-recorded milestone is a no-op,
// and an existing row's status is never touched.
func (r *Repo) EnsurePendingPayout(ctx context.Context, tenantID, referrerID string, milestone int, rewardLabel string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO referral_payouts (tenant_id, referrer_subscriber_id, milestone_count, reward_label)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, referrer_subscriber_id, milestone_count) DO NOTHING`,
		tenantID, referrerID, milestone, rewardLabel); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// maxPayoutDeriveReferrers bounds the derive-on-read pass. 1000 distinct
// referrers per GET is far beyond any current tenant; the cap just keeps
// a pathological dataset from turning a list request into a batch job.
const maxPayoutDeriveReferrers = 1000

// payoutDeriveTTL is how long one tenant's derive-on-read pass stays
// fresh. Within the window, repeated GET /payouts and CSV exports skip
// re-derivation entirely — the pass can issue up to
// maxPayoutDeriveReferrers × len(milestones) INSERTs, which is far too
// heavy to re-run on every read. The event-driven producer (congrats
// worker) still records new unlocks immediately; the backstop only
// needs to be eventually-consistent.
const payoutDeriveTTL = 60 * time.Second

// payoutDeriveGuard is a per-key (tenant id) TTL gate. Lock-free via
// sync.Map so concurrent GETs never queue behind each other: exactly
// one caller per TTL window wins tryAcquire and runs the derivation,
// everyone else skips straight to the read.
type payoutDeriveGuard struct {
	// m maps tenant id -> time.Time of the last acquired derive.
	m sync.Map
}

// tryAcquire reports whether the caller should run the derivation for
// key, and (when true) stamps now as the window start. Safe for
// concurrent use; among racing callers exactly one wins per window.
func (g *payoutDeriveGuard) tryAcquire(key string, now time.Time, ttl time.Duration) bool {
	for {
		v, loaded := g.m.LoadOrStore(key, now)
		if !loaded {
			return true // first ever derive for this key
		}
		last, ok := v.(time.Time)
		if ok && now.Sub(last) < ttl {
			return false // window still fresh — skip
		}
		// Window expired (or value corrupt): try to claim it. A lost
		// CompareAndSwap means a racing caller claimed first — loop and
		// re-evaluate against their fresher stamp.
		if g.m.CompareAndSwap(key, v, now) {
			return true
		}
	}
}

// release undoes a tryAcquire after a FAILED derivation so the next
// read retries instead of waiting out the TTL on a failure. No-op if
// another caller has re-stamped the window since.
func (g *payoutDeriveGuard) release(key string, acquiredAt time.Time) {
	g.m.CompareAndDelete(key, acquiredAt)
}

// ensureAchievedPayouts is the TTL-guarded entry point for the
// derive-on-read backstop: at most one derivation per tenant per
// payoutDeriveTTL. The first GET after the TTL derives again; failed
// derivations release the window immediately so they don't cache.
func (r *Repo) ensureAchievedPayouts(ctx context.Context, tenantID string) error {
	now := time.Now()
	if !r.payoutDerive.tryAcquire(tenantID, now, payoutDeriveTTL) {
		return nil
	}
	if err := r.deriveAchievedPayouts(ctx, tenantID); err != nil {
		r.payoutDerive.release(tenantID, now)
		return err
	}
	return nil
}

// deriveAchievedPayouts is the derive-on-read backstop documented in the
// package comment: recompute each referrer's credited, fraud-filtered
// conversion count and insert a pending payout row for every milestone
// the count satisfies that isn't recorded yet. Callers go through
// ensureAchievedPayouts, which TTL-guards this per tenant.
func (r *Repo) deriveAchievedPayouts(ctx context.Context, tenantID string) error {
	prog, err := r.GetActiveProgram(ctx, tenantID)
	if err != nil || prog == nil || len(prog.Milestones) == 0 {
		// No active program (or no milestones) — nothing derivable.
		return err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT referrer_subscriber_id, COUNT(*)::int
FROM referral_conversions
WHERE tenant_id = $1::uuid
  AND COALESCE(fraud_score, 0) < $2
  AND COALESCE(credit_status, 'credited') = 'credited'
GROUP BY referrer_subscriber_id
LIMIT `+strconv.Itoa(maxPayoutDeriveReferrers),
		tenantID, referralFraudThreshold)
	if err != nil {
		return err
	}
	type referrerCount struct {
		id    string
		count int
	}
	counts := []referrerCount{}
	for rows.Next() {
		var rc referrerCount
		if err := rows.Scan(&rc.id, &rc.count); err != nil {
			rows.Close()
			return err
		}
		counts = append(counts, rc)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, rc := range counts {
		for _, m := range MilestonesUnlocked(prog.Milestones, rc.count) {
			if _, err := tx.Exec(ctx, `
INSERT INTO referral_payouts (tenant_id, referrer_subscriber_id, milestone_count, reward_label)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, referrer_subscriber_id, milestone_count) DO NOTHING`,
				tenantID, rc.id, m.Count, m.RewardLabel); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// ListPayouts returns payout rows (optionally filtered by status,
// newest first) plus the total row count for the same filter — the
// total ignores limit so the UI can paginate/badge accurately.
func (r *Repo) ListPayouts(ctx context.Context, tenantID, status string, limit int) ([]PayoutRow, int, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT id::text, referrer_subscriber_id, milestone_count, reward_label, status,
       created_at, updated_at, COUNT(*) OVER()::int AS total
FROM referral_payouts
WHERE tenant_id = $1::uuid`
	args := []any{tenantID}
	if status != "" {
		args = append(args, status)
		q += " AND status = $" + strconv.Itoa(len(args))
	}
	q += " ORDER BY created_at DESC, id DESC LIMIT " + strconv.Itoa(limit)
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []PayoutRow{}
	total := 0
	for rows.Next() {
		var p PayoutRow
		if err := rows.Scan(&p.ID, &p.ReferrerID, &p.Milestone, &p.RewardLabel,
			&p.Status, &p.CreatedAt, &p.UpdatedAt, &total); err != nil {
			return nil, 0, err
		}
		out = append(out, p)
	}
	return out, total, rows.Err()
}

// UpdatePayoutStatus advances a payout's lifecycle. Allowed transitions:
// pending → approved, pending → paid, approved → paid. Anything else
// (including regressions) returns errPayoutBadTransition; an unknown id
// returns errPayoutNotFound.
func (r *Repo) UpdatePayoutStatus(ctx context.Context, tenantID, id, status string) (*PayoutRow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p PayoutRow
	err = tx.QueryRow(ctx, `
UPDATE referral_payouts
SET status = $2, updated_at = now()
WHERE id::text = $1
  AND (   ($2 = 'approved' AND status = 'pending')
       OR ($2 = 'paid'     AND status IN ('pending', 'approved')))
RETURNING id::text, referrer_subscriber_id, milestone_count, reward_label,
          status, created_at, updated_at`,
		id, status).Scan(&p.ID, &p.ReferrerID, &p.Milestone, &p.RewardLabel,
		&p.Status, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		// Distinguish "no such payout" from "exists but transition not
		// allowed" so the handler can answer 404 vs 409.
		var exists bool
		if scanErr := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM referral_payouts WHERE id::text = $1)`,
			id).Scan(&exists); scanErr != nil {
			return nil, scanErr
		}
		if !exists {
			return nil, errPayoutNotFound
		}
		return nil, errPayoutBadTransition
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

func validPayoutFilterStatus(s string) bool {
	switch s {
	case "", "pending", "approved", "paid":
		return true
	}
	return false
}

// ListPayouts GET /api/v1/referrals/payouts?status=pending&limit=100
// Response: {"items": [PayoutRow...], "total": n}
func (d *Deps) ListPayouts(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	if !validPayoutFilterStatus(status) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_status", "status must be pending|approved|paid"))
		return
	}
	// Derive-on-read backstop (see package comment). Best-effort: a
	// derivation hiccup shouldn't blank an otherwise-working checklist,
	// so we log and continue to the read.
	if err := d.Repo.ensureAchievedPayouts(r.Context(), t.ID); err != nil && d.Logger != nil {
		d.Logger.Warn("referrals: derive payouts failed", "tenant_id", t.ID, "err", err)
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	items, total, err := d.Repo.ListPayouts(r.Context(), t.ID, status, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// UpdatePayout PATCH /api/v1/referrals/payouts/{id}
// Body: {"status": "approved"|"paid"} — returns the updated row.
func (d *Deps) UpdatePayout(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chiURLParamPath(r, "id")
	var in struct {
		Status string `json:"status"`
	}
	if err := httpbody.DecodeJSON(w, r, 4*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	switch in.Status {
	case "approved", "paid":
	default:
		writeJSON(w, http.StatusBadRequest, errEnv("bad_status", "status must be approved|paid"))
		return
	}
	row, err := d.Repo.UpdatePayoutStatus(r.Context(), t.ID, id, in.Status)
	if err != nil {
		switch {
		case errors.Is(err, errPayoutNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, errPayoutBadTransition):
			writeJSON(w, http.StatusConflict, errEnv("bad_transition",
				"payout status can only move pending→approved, pending→paid, or approved→paid"))
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, row)
}

// ExportPayoutsCSV streams the fulfilment checklist as CSV for finance
// tools. Same derive-on-read + view as ListPayouts so operators never
// export a different set than the product shows.
func (d *Deps) ExportPayoutsCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	status := r.URL.Query().Get("status")
	if !validPayoutFilterStatus(status) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_status", "status must be pending|approved|paid"))
		return
	}
	if err := d.Repo.ensureAchievedPayouts(r.Context(), t.ID); err != nil && d.Logger != nil {
		d.Logger.Warn("referrals: derive payouts failed", "tenant_id", t.ID, "err", err)
	}
	rows, _, err := d.Repo.ListPayouts(r.Context(), t.ID, status, 500)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="referral-payouts.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{
		"id", "referrer_id", "milestone", "reward_label", "status",
		"created_at", "updated_at",
	})
	for _, row := range rows {
		_ = cw.Write([]string{
			row.ID,
			row.ReferrerID,
			strconv.Itoa(row.Milestone),
			row.RewardLabel,
			row.Status,
			row.CreatedAt.UTC().Format(time.RFC3339),
			row.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}
	cw.Flush()
}

// chiURLParamPath extracts the {id} from a path like
// /api/v1/referrals/payouts/{id} — the chi import lives in the
// package's referrals.go, so we re-use the helper via the existing
// path-parsing pattern. (This is a tiny inline parser to avoid an
// import-cycle ceremony.)
func chiURLParamPath(r *http.Request, _ string) string {
	// Last path segment.
	p := r.URL.Path
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}
