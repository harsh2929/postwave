package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/overage"
)

// Repo is a thin pgx repository for billing_events + billing_state.
//
// Webhook ingestion runs in the public route group with no tenant context, so
// these queries do NOT go through db.WithTenant. The billing_state RLS policy
// is enforced when other code (the dashboard handlers) reads the projected
// state — see the migration for the policy definition.
type Repo struct {
	Pool *pgxpool.Pool
}

// NewRepo is a thin constructor (kept for symmetry with other packages).
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{Pool: pool} }

// EventClaimStatus describes what the webhook worker should do for an event id.
type EventClaimStatus string

const (
	EventClaimed    EventClaimStatus = "claimed"
	EventProcessed  EventClaimStatus = "processed"
	EventInProgress EventClaimStatus = "in_progress"
)

const eventClaimLease = 5 * time.Minute

// AlreadyProcessed returns true if we have a billing_events row with a
// non-null processed_at for this id. The caller skips dispatch in that case.
func (r *Repo) AlreadyProcessed(ctx context.Context, eventID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, nil
	}
	var ok bool
	err := r.Pool.QueryRow(ctx,
		`SELECT processed_at IS NOT NULL FROM billing_events WHERE id = $1`,
		eventID,
	).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return ok, err
}

// RecordEvent claims a legacy Stripe event for dispatch. It returns EventProcessed
// when the event is already done and EventInProgress when another delivery is
// actively processing it. Stale/failed claims are reclaimed after a short lease
// so Stripe redeliveries can recover from worker crashes.
func (r *Repo) RecordEvent(ctx context.Context, ev StripeEvent, raw []byte) (EventClaimStatus, error) {
	return r.RecordProviderEvent(ctx, ev.ID, ev.Type, raw)
}

// RecordProviderEvent claims a provider webhook delivery for dispatch. Callers
// namespace ids by provider (for example "dodo:<webhook-id>") so two providers
// cannot collide in the shared append-only event ledger.
func (r *Repo) RecordProviderEvent(ctx context.Context, eventID, eventType string, raw []byte) (EventClaimStatus, error) {
	if r == nil || r.Pool == nil {
		return EventClaimed, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// We store the *raw* body so re-deserialization is bit-exact (e.g. for
	// signature replay during a forensic audit).
	tag, err := tx.Exec(ctx, `
		INSERT INTO billing_events (id, type, payload, processing_started_at)
		VALUES ($1, $2, $3::jsonb, now())
		ON CONFLICT (id) DO NOTHING
	`, eventID, eventType, string(raw))
	if err != nil {
		return "", fmt.Errorf("record event: %w", err)
	}
	if tag.RowsAffected() == 1 {
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		return EventClaimed, nil
	}

	var processedAt, processingStartedAt *time.Time
	var errMsg *string
	if err := tx.QueryRow(ctx, `
		SELECT processed_at, processing_started_at, error
		  FROM billing_events
		 WHERE id = $1
		 FOR UPDATE
	`, eventID).Scan(&processedAt, &processingStartedAt, &errMsg); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("record event disappeared: %w", err)
		}
		return "", err
	}
	if processedAt != nil {
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		return EventProcessed, nil
	}
	if errMsg == nil && processingStartedAt != nil && time.Since(*processingStartedAt) < eventClaimLease {
		if err := tx.Commit(ctx); err != nil {
			return "", err
		}
		return EventInProgress, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE billing_events
		   SET type = $2,
		       payload = $3::jsonb,
		       received_at = now(),
		       processing_started_at = now(),
		       error = NULL
		 WHERE id = $1
	`, eventID, eventType, string(raw)); err != nil {
		return "", fmt.Errorf("reclaim event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return EventClaimed, nil
}

// MarkProcessed stamps processed_at for the row.
func (r *Repo) MarkProcessed(ctx context.Context, eventID string) error {
	if r == nil || r.Pool == nil {
		return nil
	}
	_, err := r.Pool.Exec(ctx,
		`UPDATE billing_events SET processed_at = now(), processing_started_at = NULL, error = NULL WHERE id = $1`, eventID)
	return err
}

// MarkFailed records an error message but leaves processed_at NULL so the
// next redelivery picks it up.
func (r *Repo) MarkFailed(ctx context.Context, eventID, msg string) error {
	if r == nil || r.Pool == nil {
		return nil
	}
	_, err := r.Pool.Exec(ctx,
		`UPDATE billing_events SET error = $2, processing_started_at = NULL WHERE id = $1`, eventID, msg)
	return err
}

// UpsertState writes (or replaces) the billing_state row. Used by every event
// handler that observes a relevant state change.
func (r *Repo) UpsertState(ctx context.Context, st BillingState) error {
	if r == nil || r.Pool == nil {
		return nil
	}
	// We insert with a SECURITY DEFINER style by setting the tenant scope on
	// the local transaction so the RLS policy passes.
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, st.TenantID); err != nil {
		return err
	}
	provider := st.Provider
	customerID := strings.TrimSpace(st.CustomerID)
	subscriptionID := strings.TrimSpace(st.SubscriptionID)
	if provider == "" && (st.StripeCustomerID != "" || st.StripeSubscriptionID != "") {
		provider = ProviderStripe
	}
	if customerID == "" && provider == ProviderStripe {
		customerID = strings.TrimSpace(st.StripeCustomerID)
	}
	if subscriptionID == "" && provider == ProviderStripe {
		subscriptionID = strings.TrimSpace(st.StripeSubscriptionID)
	}
	// NOTE: overage_enabled / overage_cap are a USER preference and are
	// deliberately NOT written here — a redelivered subscription.* event must
	// never clobber the toggle. stripe_overage_item_id IS a Stripe projection
	// field, COALESCE-preserved so a later event lacking the metered item does
	// not null it.
	_, err = tx.Exec(ctx, `
		INSERT INTO billing_state
			(tenant_id, provider, customer_id, subscription_id,
			 stripe_customer_id, stripe_subscription_id, tier,
			 current_period_end, cancel_at, dunning, stripe_overage_item_id, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
		ON CONFLICT (tenant_id) DO UPDATE SET
			provider               = COALESCE(EXCLUDED.provider, billing_state.provider),
			customer_id            = COALESCE(EXCLUDED.customer_id, billing_state.customer_id),
			subscription_id        = EXCLUDED.subscription_id,
			stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id,     billing_state.stripe_customer_id),
			stripe_subscription_id = EXCLUDED.stripe_subscription_id,
			tier                   = COALESCE(EXCLUDED.tier, billing_state.tier),
			current_period_end     = COALESCE(EXCLUDED.current_period_end, billing_state.current_period_end),
			cancel_at              = EXCLUDED.cancel_at,
			dunning                = CASE WHEN $12 THEN EXCLUDED.dunning ELSE billing_state.dunning END,
			stripe_overage_item_id = COALESCE(EXCLUDED.stripe_overage_item_id, billing_state.stripe_overage_item_id),
			updated_at             = now()
		`,
		st.TenantID,
		nullable(string(provider)),
		nullable(customerID),
		nullable(subscriptionID),
		nullable(st.StripeCustomerID),
		nullable(st.StripeSubscriptionID),
		nullable(string(st.Tier)),
		nullableTime(st.CurrentPeriodEnd),
		nullableTime(st.CancelAt),
		st.Dunning,
		nullable(st.StripeOverageItemID),
		st.DunningSet,
	)
	if err != nil {
		return fmt.Errorf("upsert billing_state: %w", err)
	}
	// Keep the tenant entitlement projection in the same transaction as the
	// provider state. Send and feature gates read tenants.tier on authenticated
	// requests; updating only billing_state would accept money without granting
	// (or revoking) the corresponding plan.
	if st.Tier != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE tenants SET tier = $2, updated_at = now() WHERE id = $1`,
			st.TenantID, string(st.Tier)); err != nil {
			return fmt.Errorf("project billing tier to tenant: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// GetState reads back the projected state row for a tenant.
func (r *Repo) GetState(ctx context.Context, tenantID string) (*BillingState, error) {
	if r == nil || r.Pool == nil {
		return nil, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	var st BillingState
	var provider, customerID, subscriptionID, cust, subID, tier, overageItem *string
	var cpe, cancelAt *time.Time
	var overageCap *int
	err = tx.QueryRow(ctx, `
		SELECT tenant_id, provider, customer_id, subscription_id,
		       stripe_customer_id, stripe_subscription_id, tier,
		       current_period_end, cancel_at, dunning, updated_at,
		       overage_enabled, overage_cap, stripe_overage_item_id
		  FROM billing_state WHERE tenant_id = $1
	`, tenantID).Scan(&st.TenantID, &provider, &customerID, &subscriptionID,
		&cust, &subID, &tier, &cpe, &cancelAt, &st.Dunning, &st.UpdatedAt,
		&st.OverageEnabled, &overageCap, &overageItem)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if provider != nil {
		st.Provider = Provider(*provider)
	}
	if customerID != nil {
		st.CustomerID = *customerID
	}
	if subscriptionID != nil {
		st.SubscriptionID = *subscriptionID
	}
	if cust != nil {
		st.StripeCustomerID = *cust
	}
	if subID != nil {
		st.StripeSubscriptionID = *subID
	}
	if tier != nil {
		st.Tier = Tier(*tier)
	}
	if cpe != nil {
		st.CurrentPeriodEnd = *cpe
	}
	if cancelAt != nil {
		st.CancelAt = *cancelAt
	}
	st.OverageCap = overageCap
	if overageItem != nil {
		st.StripeOverageItemID = *overageItem
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &st, nil
}

// OveragePreference resolves a tenant's overage opt-in for the monthly-send
// cap decision (BILL-052). A missing row / any error degrades to the safe
// default {Enabled:false} — the send path then keeps today's hard cap.
func (r *Repo) OveragePreference(ctx context.Context, tenantID string) overage.Preference {
	if r == nil {
		return overage.Preference{}
	}
	st, err := r.GetState(ctx, tenantID)
	if err != nil || st == nil {
		return overage.Preference{}
	}
	return overage.Preference{Enabled: st.OverageEnabled, Cap: st.OverageCap}
}

// SetOverage persists a tenant's overage preference (opt-in + optional unit
// ceiling). It UPSERTs — a bare UPDATE would no-op for a self-host tenant that
// has no billing_state row yet, silently dropping the preference. It never
// touches the Stripe projection columns.
func (r *Repo) SetOverage(ctx context.Context, tenantID string, enabled bool, cap *int) error {
	if r == nil || r.Pool == nil {
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
		INSERT INTO billing_state (tenant_id, overage_enabled, overage_cap, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (tenant_id) DO UPDATE SET
			overage_enabled = EXCLUDED.overage_enabled,
			overage_cap     = EXCLUDED.overage_cap,
			updated_at      = now()
	`, tenantID, enabled, cap); err != nil {
		return fmt.Errorf("set overage: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListInvoices(ctx context.Context, tenantID string, limit int) ([]DashboardInvoice, error) {
	if r == nil || r.Pool == nil {
		return []DashboardInvoice{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 24
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	var provider, customerID string
	_ = tx.QueryRow(ctx, `
SELECT COALESCE(provider, CASE WHEN stripe_customer_id IS NOT NULL THEN 'stripe' ELSE '' END),
       COALESCE(customer_id, stripe_customer_id, '')
  FROM billing_state
 WHERE tenant_id = $1`, tenantID).Scan(&provider, &customerID)
	if customerID == "" {
		return []DashboardInvoice{}, tx.Commit(ctx)
	}
	query := `
SELECT id, type, received_at, payload
FROM (
  SELECT DISTINCT ON (COALESCE(NULLIF(payload #>> '{data,object,id}', ''), id))
         id, type, received_at, payload
    FROM billing_events
   WHERE type IN ('invoice.payment_succeeded', 'invoice.payment_failed')
     AND payload #>> '{data,object,customer}' = $1
   ORDER BY COALESCE(NULLIF(payload #>> '{data,object,id}', ''), id), received_at DESC
) latest
ORDER BY received_at DESC
LIMIT $2`
	if Provider(provider) == ProviderDodo {
		query = `
SELECT id, type, received_at, payload
FROM (
  SELECT DISTINCT ON (COALESCE(NULLIF(payload #>> '{data,payment_id}', ''), id))
         id, type, received_at, payload
    FROM billing_events
   WHERE type IN ('payment.succeeded', 'payment.failed', 'payment.cancelled')
     AND payload #>> '{data,customer,customer_id}' = $1
   ORDER BY COALESCE(NULLIF(payload #>> '{data,payment_id}', ''), id), received_at DESC
) latest
ORDER BY received_at DESC
LIMIT $2`
	}
	rows, err := tx.Query(ctx, query, customerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DashboardInvoice{}
	for rows.Next() {
		var eventID, eventType string
		var at time.Time
		var raw []byte
		if err := rows.Scan(&eventID, &eventType, &at, &raw); err != nil {
			return nil, err
		}
		inv := invoiceFromEvent(eventID, eventType, at, raw)
		if Provider(provider) == ProviderDodo {
			inv = invoiceFromDodoEvent(eventID, eventType, at, raw)
		}
		out = append(out, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) Usage(ctx context.Context, tenantID string, days int) ([]UsagePoint, error) {
	if r == nil || r.Pool == nil {
		return []UsagePoint{}, nil
	}
	if days <= 0 {
		days = 90
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT at::date::text, count(*)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND event_type = 'sent'
   AND at >= now() - make_interval(days => $2)
 GROUP BY at::date
 ORDER BY at::date`, tenantID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsagePoint{}
	for rows.Next() {
		var p UsagePoint
		if err := rows.Scan(&p.Date, &p.Sent); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CurrentMonthUsage returns distinct campaign-recipient sends in the current
// UTC billing month. The UNION covers the queue-driven sender and the legacy
// provider-report path without double-charging a recipient that appears in
// both stores.
func (r *Repo) CurrentMonthUsage(ctx context.Context, tenantID string) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return 0, err
	}
	var used int
	err = tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM (
    SELECT campaign_id::text, lower(subscriber_email::text) AS email
      FROM campaign_recipients
     WHERE tenant_id=$1::uuid
       AND status='sent'
       AND sent_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
    UNION
    SELECT campaign_id::text, lower(subscriber_email::text) AS email
      FROM campaign_report_events
     WHERE tenant_id=$1::uuid
       AND event_type='sent'
       AND at >= date_trunc('month', now() AT TIME ZONE 'UTC')
  ) sends`, tenantID).Scan(&used)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return used, nil
}

// MonthlyDeliveredSends counts DELIVERED sends for a specific month (deduped by
// campaign+recipient), tenant-scoped. Overage is billed off delivered usage —
// never queued len(emails), which over-counts vs suppression/bounce drops — and
// this takes an explicit period so the reconciler can finalize a prior month.
func (r *Repo) MonthlyDeliveredSends(ctx context.Context, tenantID string, period time.Time) (int, error) {
	if r == nil || r.Pool == nil {
		return 0, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return 0, err
	}
	monthStart := period.UTC().Format("2006-01-02")
	var used int
	err = tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM (
    SELECT campaign_id::text, lower(subscriber_email::text) AS email
      FROM campaign_recipients
     WHERE tenant_id=$1::uuid AND status='sent'
       AND sent_at >= $2::date AND sent_at < ($2::date + interval '1 month')
    UNION
    SELECT campaign_id::text, lower(subscriber_email::text) AS email
      FROM campaign_report_events
     WHERE tenant_id=$1::uuid AND event_type='sent'
       AND at >= $2::date AND at < ($2::date + interval '1 month')
  ) sends`, tenantID, monthStart).Scan(&used)
	if err != nil {
		return 0, err
	}
	return used, tx.Commit(ctx)
}

// SetDunning toggles the dunning flag.
func (r *Repo) SetDunning(ctx context.Context, tenantID string, dunning bool) error {
	if r == nil || r.Pool == nil {
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
	_, err = tx.Exec(ctx,
		`UPDATE billing_state SET dunning = $2, updated_at = now() WHERE tenant_id = $1`,
		tenantID, dunning)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ClearDunning clears a real dunning state and reports whether the row made a
// true -> false transition. Callers use the transition bit to avoid treating
// an ordinary successful renewal as an account reactivation.
func (r *Repo) ClearDunning(ctx context.Context, tenantID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE billing_state SET dunning = false, updated_at = now() WHERE tenant_id = $1 AND dunning = true`,
		tenantID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// TenantByCustomer reverse-looks-up a tenant id from a Stripe customer id.
// Used by invoice/charge events which carry a customer id but not a tenant
// id in metadata.
func (r *Repo) TenantByCustomer(ctx context.Context, customerID string) (string, error) {
	return r.TenantByProviderCustomer(ctx, ProviderStripe, customerID)
}

// TenantByProviderCustomer resolves a provider-owned customer id through a
// SECURITY DEFINER database boundary, keeping cross-tenant lookup out of the
// ordinary tenant-scoped query surface.
func (r *Repo) TenantByProviderCustomer(ctx context.Context, provider Provider, customerID string) (string, error) {
	if r == nil || r.Pool == nil || customerID == "" {
		return "", nil
	}
	var tenantID *string
	err := r.Pool.QueryRow(ctx,
		`SELECT billing_tenant_by_provider_customer($1, $2)::text`,
		string(provider), customerID,
	).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if tenantID == nil {
		return "", nil
	}
	return *tenantID, nil
}

func invoiceFromEvent(eventID, eventType string, at time.Time, raw []byte) DashboardInvoice {
	var ev StripeEvent
	_ = json.Unmarshal(raw, &ev)
	var inv Invoice
	_ = json.Unmarshal(ev.Data.Object, &inv)
	if inv.ID == "" {
		inv.ID = eventID
	}
	status := "paid"
	amount := inv.AmountPaid
	if eventType == "invoice.payment_failed" {
		status = "open"
		amount = inv.AmountDue
	}
	return DashboardInvoice{
		ID:          inv.ID,
		Number:      inv.Number,
		Date:        at.UTC().Format("2006-01-02"),
		Amount:      formatUSD(amount),
		Status:      status,
		DownloadURL: safeStripeHostedInvoiceURL(inv.HostedURL),
	}
}

func invoiceFromDodoEvent(eventID, eventType string, at time.Time, raw []byte) DashboardInvoice {
	var envelope dodoWebhookEnvelope
	_ = json.Unmarshal(raw, &envelope)
	var payment dodoPayment
	_ = json.Unmarshal(envelope.Data, &payment)
	id := firstNonEmpty(payment.InvoiceID, payment.PaymentID, eventID)
	status := "paid"
	if eventType != "payment.succeeded" {
		status = "open"
	}
	return DashboardInvoice{
		ID:          id,
		Number:      payment.InvoiceID,
		Date:        at.UTC().Format("2006-01-02"),
		Amount:      formatCurrency(payment.TotalAmount, payment.Currency),
		Status:      status,
		DownloadURL: safeDodoInvoiceURL(payment.InvoiceURL),
	}
}

func safeStripeHostedInvoiceURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return ""
	}
	switch u.Hostname() {
	case "invoice.stripe.com", "pay.stripe.com", "billing.stripe.com", "invoice.stripe.example", "pay.stripe.example":
		u.Fragment = ""
		return u.String()
	default:
		return ""
	}
}

func safeDodoInvoiceURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host != "dodopayments.com" && !strings.HasSuffix(host, ".dodopayments.com") {
		return ""
	}
	u.Fragment = ""
	return u.String()
}

func formatCurrency(minorUnits int64, currency string) string {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if currency == "" || currency == "USD" {
		return formatUSD(minorUnits)
	}
	sign := ""
	if minorUnits < 0 {
		sign = "-"
		minorUnits = -minorUnits
	}
	return fmt.Sprintf("%s%s %d.%02d", sign, currency, minorUnits/100, minorUnits%100)
}

func formatUSD(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s$%d.%02d", sign, cents/100, cents%100)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// jsonbBytes is a small helper used by tests that want to round-trip through
// the payload column without the full pg driver.
func jsonbBytes(v any) ([]byte, error) {
	return json.Marshal(v)
}
