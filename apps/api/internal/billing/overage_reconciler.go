// SPDX-License-Identifier: AGPL-3.0-only
//
// BILL-052 overage reconciler. Overage is metered off DELIVERED usage (the same
// number the plan cap is enforced against), never off queued recipients — a
// queued batch over-counts vs suppression/bounce drops and ON CONFLICT dedup.
//
// Flow: the campaign send path records a per-(tenant, month) "touch" the moment
// it lets a send past the cap (RecordOverageTouch, tenant-scoped). A periodic
// reconciler then, for each touched tenant this period, recomputes the billable
// overage from delivered usage and — only when Stripe is fully configured and
// the tenant opted in — reports the cumulative quantity to the metered
// subscription item with action=set + a deterministic idempotency key. Provider
// reporting is release-held until the billing-period boundary is authoritative;
// the ledger continues to accrue locally (stripe_status='local_only').
package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

// usageReportMaxBytes bounds the Stripe usage-record response read.
const usageReportMaxBytes = 1 << 16

// OverageReportingAvailable withholds the Stripe usage-record POST. The local
// ledger buckets usage by UTC calendar month, but no in-tree subscription
// creator or webhook projection proves that the Stripe subscription item's
// billing_cycle_anchor is the first of that month. Sending cumulative action=set
// quantities across a different billing boundary can misattribute charges.
// Keep the local computation and immutable touch ledger live; release provider
// reporting only with an authoritative period contract and reconciliation.
const OverageReportingAvailable = false

func periodStart(now time.Time) time.Time {
	now = now.UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// RecordOverageTouch marks (tenant, current month) as having sent past the cap,
// so the reconciler processes it. Tenant-scoped; idempotent. billable is left
// to the reconciler, which recomputes it from delivered usage.
func (r *Repo) RecordOverageTouch(ctx context.Context, tenantID string) error {
	if r == nil || r.Pool == nil || tenantID == "" {
		return nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO send_overage_ledger (tenant_id, period_start)
		VALUES ($1::uuid, date_trunc('month', now())::date)
		ON CONFLICT (tenant_id, period_start) DO NOTHING
	`, tenantID); err != nil {
		return fmt.Errorf("overage touch: %w", err)
	}
	return tx.Commit(ctx)
}

// overageLedgerRow is one tenant's reconciliation state for a period.
type overageLedgerRow struct {
	TenantID         string
	ReportedQuantity int
}

type overageLedgerStore interface {
	overageTouchedTenants(context.Context, time.Time) ([]overageLedgerRow, error)
	GetState(context.Context, string) (*BillingState, error)
	MonthlyDeliveredSends(context.Context, string, time.Time) (int, error)
	saveOverageLedger(context.Context, string, time.Time, int, int, string, *time.Time) error
}

// overageTouchedTenants lists tenants with a ledger row for the period, under
// the worker scope (the ledger's worker RLS escape).
func (r *Repo) overageTouchedTenants(ctx context.Context, period time.Time) ([]overageLedgerRow, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT tenant_id::text, reported_quantity
		  FROM send_overage_ledger WHERE period_start = $1::date`, period)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []overageLedgerRow
	for rows.Next() {
		var row overageLedgerRow
		if err := rows.Scan(&row.TenantID, &row.ReportedQuantity); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// saveOverageLedger writes the recomputed billable + reporting outcome under the
// worker scope.
func (r *Repo) saveOverageLedger(ctx context.Context, tenantID string, period time.Time, billable, reportedQty int, status string, reportedAt *time.Time) error {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE send_overage_ledger
		   SET billable_overage = $3, reported_quantity = $4,
		       stripe_status = $5, reported_at = COALESCE($6, reported_at)
		 WHERE tenant_id = $1::uuid AND period_start = $2::date`,
		tenantID, period, billable, reportedQty, status, reportedAt); err != nil {
		return fmt.Errorf("save overage ledger: %w", err)
	}
	return tx.Commit(ctx)
}

// OverageReconciler periodically reconciles overage ledgers and reports metered
// usage to Stripe. Config-gated every tick: with no Stripe secret it only
// accrues locally.
type OverageReconciler struct {
	Repo   overageLedgerStore
	Logger *slog.Logger
	// Secret returns the current Stripe secret key (read per-tick so the gate
	// can flip without a restart, mirroring Checkout/Portal).
	Secret func() string
}

// Start runs an immediate reconciliation pass, then one every interval until
// ctx is cancelled. Config-gating is re-evaluated each pass, so the feature can
// go live (or dark) without a restart.
func (rec *OverageReconciler) Start(ctx context.Context, interval time.Duration) {
	if rec == nil {
		return
	}
	pass := func() {
		if err := rec.ReconcileOnce(ctx, time.Now()); err != nil && rec.Logger != nil {
			rec.Logger.Warn("overage reconcile pass failed", "err", err.Error())
		}
	}
	pass()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pass()
		}
	}
}

// ReconcileOnce runs one reconciliation pass. It processes the current period
// AND the immediately-preceding one: overage delivered in the tail of a month
// (between the last tick and midnight) is recorded under the old period, so the
// first tick after a rollover must still finalize it. reportOverageUsage uses
// action=set (cumulative), so re-processing a fully-reported period is a no-op.
func (rec *OverageReconciler) ReconcileOnce(ctx context.Context, now time.Time) error {
	if rec == nil || rec.Repo == nil {
		return nil
	}
	secret := ""
	if rec.Secret != nil {
		secret = strings.TrimSpace(rec.Secret())
	}
	current := periodStart(now)
	previous := periodStart(current.AddDate(0, 0, -1))
	for _, period := range []time.Time{previous, current} {
		tenants, err := rec.Repo.overageTouchedTenants(ctx, period)
		if err != nil {
			return err
		}
		for _, row := range tenants {
			if err := rec.reconcileTenant(ctx, row, period, secret); err != nil {
				// One tenant's failure must not abort the whole sweep.
				if rec.Logger != nil {
					rec.Logger.Warn("overage reconcile failed", "tenant_id", row.TenantID, "err", err.Error())
				}
			}
		}
	}
	return nil
}

func (rec *OverageReconciler) reconcileTenant(ctx context.Context, row overageLedgerRow, period time.Time, secret string) error {
	st, err := rec.Repo.GetState(ctx, row.TenantID)
	if err != nil {
		return err
	}
	if st == nil {
		return nil
	}
	cap := limits.MonthlySendCap(string(st.Tier))
	if cap <= 0 {
		return nil
	}
	// Bill off DELIVERED usage for THIS period (matches the dashboard's "used"
	// and never over-bills vs suppression/bounce drops), not the enforcement
	// GREATEST which includes queue-incremented snapshots.
	current, err := rec.Repo.MonthlyDeliveredSends(ctx, row.TenantID, period)
	if err != nil {
		return err
	}
	billable := current - cap
	if billable < 0 {
		billable = 0
	}

	// The quantity we would CHARGE honors the user's spend ceiling as a real
	// cap, and only bills when the tenant opted in.
	reportable := billable
	if st.OverageCap != nil && reportable > *st.OverageCap {
		reportable = *st.OverageCap
	}
	if !st.OverageEnabled {
		reportable = 0
	}

	configured := secret != "" && strings.TrimSpace(st.StripeOverageItemID) != ""
	if !configured || reportable <= 0 || !OverageReportingAvailable {
		// Accrue locally; never attempt a Stripe POST.
		return rec.Repo.saveOverageLedger(ctx, row.TenantID, period, billable, row.ReportedQuantity, "local_only", nil)
	}
	if reportable == row.ReportedQuantity {
		// Already reported this cumulative total; action=set would be a no-op.
		return rec.Repo.saveOverageLedger(ctx, row.TenantID, period, billable, reportable, "reported", nil)
	}
	idem := fmt.Sprintf("overage:%s:%s:%d", row.TenantID, period.Format("2006-01"), reportable)
	if err := reportOverageUsage(ctx, secret, st.StripeOverageItemID, reportable, idem); err != nil {
		_ = rec.Repo.saveOverageLedger(ctx, row.TenantID, period, billable, row.ReportedQuantity, "error", nil)
		return err
	}
	nowTs := time.Now().UTC()
	return rec.Repo.saveOverageLedger(ctx, row.TenantID, period, billable, reportable, "reported", &nowTs)
}

// reportOverageUsage is the candidate Stripe adapter behind
// OverageReportingAvailable. Direct tests pin its request shape, but production
// reconciliation cannot call it while the period contract is unqualified.
func reportOverageUsage(ctx context.Context, secret, itemID string, quantity int, idempotencyKey string) error {
	form := url.Values{}
	form.Set("quantity", strconv.Itoa(quantity))
	form.Set("action", "set")
	// No explicit timestamp: Stripe records at now(), which is ALWAYS inside the
	// subscription's current billing period. An explicit calendar-month-start
	// timestamp would fall before current_period_start for any subscription not
	// anchored to day 1 and be rejected 400 (silent under-bill). Release
	// prerequisite: the STRIPE_PRICE_OVERAGE subscription MUST be created
	// with billing_cycle_anchor pinned to the first of the month so Stripe's
	// billing period matches this ledger's calendar-month accounting; otherwise
	// a cumulative action=set spanning a period boundary mis-attributes usage.
	endpoint := stripeAPIBase + "/v1/subscription_items/" + url.PathEscape(strings.TrimSpace(itemID)) + "/usage_records"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("build usage-record request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	resp, err := stripeHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("stripe usage http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, usageReportMaxBytes)
	if resp.StatusCode >= 400 {
		if readErr != nil {
			return fmt.Errorf("stripe usage HTTP %d", resp.StatusCode)
		}
		var se stripeErrorResponse
		_ = json.Unmarshal(body, &se)
		msg := strings.TrimSpace(se.Error.Message)
		if msg == "" {
			msg = fmt.Sprintf("stripe usage HTTP %d", resp.StatusCode)
		}
		return errors.New(msg)
	}
	return nil
}
