// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/affiliates"
	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/scheduled_reports"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// ---------------------------------------------------------------------------
// billing.TenantAutoProvisioner adapter.
// ---------------------------------------------------------------------------
//
// Auto-mints a tenant + owner user from a billing customer email when the
// /pricing checkout flow lands without a TenantSlug. The webhook hands
// us (provider, email, customer_id); we look up by provider-owned customer id (an
// existing tenant from a prior payment) → email (an existing tenant
// from any owner with that verified email) → create a fresh row.
//
// Idempotency: keyed on (1) provider + customer_id (the strongest invariant),
// then (2) verified email of any owner. If a provider redelivery hits us, we
// return the same tenant id without
// touching the DB beyond the lookup.
// billingAuditLoggerAdapter satisfies billing.AuditLogger by routing
// to db.Audit inside a tenant-scoped transaction. Closes audit-log
// audit HIGH #3 (Stripe webhook events were silently dropped because
// WebhookHandler.Audit was nil). Each call opens a short tx, writes
// one audit_log row, commits. Errors are logged but never returned —
// audit failure should not block ack to Stripe.
// listmonkEventBusAdapter satisfies listmonk_events.EventBus by forwarding
// to the events.Bus. Defined here so listmonk_events stays import-free of the
// events package (SUB-119 / SUB-096 bridge).
type listmonkEventBusAdapter struct {
	Bus *events.Bus
}

func (a listmonkEventBusAdapter) Publish(tenantID, topic string, payload map[string]any) {
	if a.Bus == nil || tenantID == "" {
		return
	}
	a.Bus.Publish(events.Event{Topic: topic, TenantID: tenantID, Payload: payload})
}

// listmonkEngagementSnapshotAdapter satisfies
// listmonk_events.EngagementSnapshotter by delegating to the subscribers
// Repo's EngagementByEmail, mapping the concrete struct onto the package-
// local value type (SUB-096). Keeps listmonk_events import-free of the
// subscribers package.
type listmonkEngagementSnapshotAdapter struct {
	repo *subscribers.Repo
}

func (a listmonkEngagementSnapshotAdapter) EngagementByEmail(
	ctx context.Context, tenantID, email string,
) (listmonk_events.EngagementSnapshot, error) {
	if a.repo == nil {
		return listmonk_events.EngagementSnapshot{}, errors.New("nil engagement repo")
	}
	snap, err := a.repo.EngagementByEmail(ctx, tenantID, email)
	if err != nil {
		return listmonk_events.EngagementSnapshot{}, err
	}
	return listmonk_events.EngagementSnapshot{
		SubscriberID: snap.SubscriberID,
		Email:        snap.Email,
		Sends:        snap.Counts.Sends,
		Opens:        snap.Counts.Opens,
		Clicks:       snap.Counts.Clicks,
	}, nil
}

// approvalsEventBusAdapter satisfies approvals.EventEmitter by
// forwarding to the events.Bus. Defined here to avoid the approvals
// package importing the events package (cycle hygiene).
type approvalsEventBusAdapter struct {
	Bus *events.Bus
}

func (a *approvalsEventBusAdapter) Emit(tenantID, topic string, payload map[string]any) {
	if a == nil || a.Bus == nil || tenantID == "" {
		return
	}
	a.Bus.Publish(events.Event{
		Topic:    topic,
		TenantID: tenantID,
		Payload:  payload,
	})
}

// approvalsTransactionalWebhookFanoutAdapter bridges the approvals-owned
// transaction contract to the canonical outbound-webhook store. The supplied
// pgx transaction is the approval mutation's transaction; the adapter must
// never open or commit a transaction of its own.
type approvalsTransactionalWebhookFanoutAdapter struct {
	canonical *outbound_webhooks.TransactionalFanout
	legacy    *webhooks.Dispatcher
}

var _ approvals.TransactionalWebhookFanout = approvalsTransactionalWebhookFanoutAdapter{}

func (f approvalsTransactionalWebhookFanoutAdapter) FanoutApprovalEvent(
	ctx context.Context,
	tx pgx.Tx,
	event approvals.TransactionalWebhookEvent,
) error {
	// Keep compatibility subscriptions transactional too. Clone the legacy
	// dispatcher with Canonical cleared because canonical fanout below needs
	// the approval's exact occurred_at, which the legacy FireInput does not
	// carry. Both writes still share tx and either failure aborts the approval.
	if f.legacy != nil {
		legacy := *f.legacy
		legacy.Canonical = nil
		if _, err := legacy.Fire(ctx, tx, webhooks.FireInput{
			TenantID:       event.TenantID,
			EventType:      webhooks.EventType(event.EventType),
			Body:           event.Body,
			IdempotencyKey: event.SourceEventID,
		}); err != nil {
			return err
		}
	}
	if f.canonical == nil {
		return nil
	}
	_, err := f.canonical.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
		TenantID:      event.TenantID,
		EventType:     event.EventType,
		SourceEventID: event.SourceEventID,
		Body:          event.Body,
		OccurredAt:    event.OccurredAt,
	})
	return err
}

type billingAuditLoggerAdapter struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
}

func (a *billingAuditLoggerAdapter) Write(ctx context.Context, tenantID, action string, payload map[string]any) error {
	if a == nil || a.Pool == nil || tenantID == "" {
		return nil
	}
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		if a.Logger != nil {
			a.Logger.Warn("billing audit begin failed", "action", action, "err", err.Error())
		}
		return nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil
	}
	if err := db.Audit(ctx, tx, db.AuditMeta{TenantID: tenantID}, action, "billing_webhook", "", payload); err != nil {
		if a.Logger != nil {
			a.Logger.Warn("billing audit write failed", "action", action, "err", err.Error())
		}
		return nil
	}
	_ = tx.Commit(ctx)
	return nil
}

type billingAutoTenantAdapter struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger

	// MagicLinkSender, when non-nil, is invoked asynchronously after a
	// successful tenant + user mint to email the new owner a sign-in
	// link. The send runs in a goroutine so a slow / failing mailer
	// does NOT block the Stripe webhook ack — Stripe retries on 5xx,
	// and we don't want a transient SMTP hiccup to redeliver a tenant
	// creation that's already committed.
	MagicLinkSender func(ctx context.Context, tenantID, userID, email string) error
}

// magicLinkAutoProvisionTotal counts magic-link invitation emails the
// auto-provisioner queues for sending. Labelled by outcome so an
// alert can fire if the failure rate spikes (e.g. mailer DNS
// outage). Cardinality is bounded {ok, send_failed, lookup_failed}.
var magicLinkAutoProvisionTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "magiclink_sent_on_autoprovision_total",
	Help: "Magic-link invitation emails issued from billingAutoTenantAdapter, partitioned by outcome.",
}, []string{"outcome"})

// EnsureTenantForEmail implements the legacy Stripe-shaped
// billing.TenantAutoProvisioner contract.
func (a *billingAutoTenantAdapter) EnsureTenantForEmail(ctx context.Context, email, customerID string) (string, bool, error) {
	return a.EnsureTenantForProviderEmail(ctx, billing.ProviderStripe, email, customerID)
}

// EnsureTenantForProviderEmail is the provider-neutral auto-provisioning
// boundary used by Moosewave's Dodo Payments webhook.
func (a *billingAutoTenantAdapter) EnsureTenantForProviderEmail(ctx context.Context, provider billing.Provider, email, customerID string) (string, bool, error) {
	if a == nil || a.Pool == nil {
		return "", false, errors.New("billing auto-tenant: not configured")
	}
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return "", false, errors.New("billing auto-tenant: empty email")
	}
	tx, err := a.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lookup 1: existing billing_state row by provider customer id. If
	// the customer paid before, we already have a tenant for them.
	if customerID != "" {
		var existing string
		lookupErr := tx.QueryRow(ctx, `
SELECT tenant_id::text FROM billing_state
WHERE (provider = $1 AND customer_id = $2)
   OR ($1 = 'stripe' AND stripe_customer_id = $2)
LIMIT 1`, string(provider), customerID).Scan(&existing)
		if lookupErr == nil && existing != "" {
			if cerr := tx.Commit(ctx); cerr != nil {
				return "", false, cerr
			}
			return existing, false, nil
		}
		if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
			return "", false, fmt.Errorf("lookup by customer: %w", lookupErr)
		}
	}

	// Lookup 2: existing user with that email AND owner role. The
	// users table has a unique (tenant_id,email) so a join via owner
	// users is safe. We accept the first match — a single email
	// shouldn't own multiple tenants in practice.
	var existing string
	err = tx.QueryRow(ctx, `
SELECT u.tenant_id::text
FROM users u
WHERE lower(u.email) = $1 AND u.role = 'owner'
LIMIT 1`, email).Scan(&existing)
	if err == nil && existing != "" {
		if cerr := tx.Commit(ctx); cerr != nil {
			return "", false, cerr
		}
		return existing, false, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", false, fmt.Errorf("lookup by email: %w", err)
	}

	// Mint a new tenant + owner. Slug derives from the email local-
	// part; collision risk is low because brand-new signups go
	// through this path infrequently. On collision we append a 4-byte
	// hex suffix.
	local := email
	if at := strings.IndexByte(email, '@'); at > 0 {
		local = email[:at]
	}
	slug := slugifyEmailLocal(local)
	name := defaultTenantNameFromEmail(email)

	var tenantID string
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		return "", false, fmt.Errorf("gen tenant id: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", false, fmt.Errorf("set tenant guc: %w", err)
	}

	// Try the desired slug first; fall back to a randomized suffix on
	// unique-violation. Two attempts is plenty for the 1-in-N collision rate.
	// data_region seeded from POSTWAVE_DEPLOYMENT_REGION (multi-region
	// audit CRITICAL #1) so billing-auto-provisioned tenants land in
	// the right region instead of silently defaulting to us-east-1.
	region := regions.Provisioning()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES ($1::uuid, $2, $3, 'sandbox', $4)`, tenantID, slug, name, region); err != nil {
		// 23505 = unique_violation. Retry with a unique suffix.
		slug2 := slug + "-" + randomSlugSuffix()
		if _, err2 := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES ($1::uuid, $2, $3, 'sandbox', $4)`, tenantID, slug2, name, region); err2 != nil {
			return "", false, fmt.Errorf("insert tenant: %w", err2)
		}
	}

	var newUserID string
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, auth_provider)
VALUES ($1::uuid, $2, 'owner', 'magic_link')
RETURNING id::text`, tenantID, email).Scan(&newUserID); err != nil {
		return "", false, fmt.Errorf("insert user: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}

	if a.Logger != nil {
		a.Logger.Info("billing auto-tenant created",
			"tenant_id", tenantID,
			"email", email,
			"provider", provider,
			"customer_id", customerID,
			"slug", slug)
	}

	// Magic-link invitation: best-effort + async. Wrapping in a
	// goroutine so a slow mailer doesn't extend the Stripe webhook
	// response time (Stripe times out around 10s — sending an email
	// can spike past that on bad days). We log a structured warn on
	// failure; Stripe's redelivery would otherwise re-mint the tenant
	// (idempotent path catches it now that the row is committed) but
	// would NOT re-trigger an invitation send.
	//
	// We deliberately do NOT block tenant creation on the send: tenant
	// is the durable outcome of this RPC, the email is a follow-up
	// nicety. The user can always hit POST /api/v1/auth/magic-link/start
	// to retry.
	if a.MagicLinkSender != nil {
		// New context detached from `ctx` so the goroutine survives the
		// webhook handler returning. Caps at 30s — a mailer that takes
		// longer than that is broken; we'd rather give up than leak.
		userID := newUserID
		tID, uID, em := tenantID, userID, email
		safego.Go(a.Logger, "magic-link-auto-provision", func() {
			sendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := a.MagicLinkSender(sendCtx, tID, uID, em); err != nil {
				magicLinkAutoProvisionTotal.WithLabelValues("send_failed").Inc()
				if a.Logger != nil {
					a.Logger.Warn("billing auto-tenant: magic-link send failed",
						"tenant_id", tID,
						"user_id", uID,
						"email", em,
						"err", err.Error())
				}
				return
			}
			magicLinkAutoProvisionTotal.WithLabelValues("ok").Inc()
		})
	}

	return tenantID, true, nil
}

// slugifyEmailLocal lowercases + strips characters not allowed in a
// tenant slug. Falls back to "user" if the result is empty.
func slugifyEmailLocal(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	prevDash := false
	for _, c := range strings.ToLower(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			out.WriteRune(c)
			prevDash = false
		case c == '-' || c == '_' || c == '.' || c == '+':
			if !prevDash {
				out.WriteByte('-')
				prevDash = true
			}
		default:
			// drop
		}
	}
	res := strings.Trim(out.String(), "-")
	if res == "" {
		return "user"
	}
	return res
}

// defaultTenantNameFromEmail uses the email's domain as the tenant
// display name when present (e.g. "acme.com"); falls back to the
// local-part otherwise. Operators can rename later from settings.
func defaultTenantNameFromEmail(email string) string {
	at := strings.IndexByte(email, '@')
	if at < 0 || at == len(email)-1 {
		return email
	}
	return email[at+1:]
}

// randomSlugSuffix returns 8 hex chars of randomness for slug
// disambiguation. crypto/rand isn't necessary here — collision risk on
// a 32-bit space is already negligible — but we use it for consistency
// with the rest of the codebase's id generation.
func randomSlugSuffix() string {
	var b [4]byte
	_, _ = cryptorand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// purposeConsentLookupFromEnv always wires the send-time consent gate.
// POSTWAVE_PURPOSE_CONSENT_GATE selects the purpose key in main; when it is
// unset the Guard uses email_marketing. Missing legacy evidence therefore
// remains non-sendable instead of bypassing the final revocation check.
func purposeConsentLookupFromEnv(pool *db.Pool) sending.PurposeConsentLookup {
	return &consent.PurposeLookup{Pool: pool}
}

// billingPaymentFailedAdapter wraps the auth-tier mailer.Mailer to satisfy
// billing.PaymentFailedMailer. The billing package can't depend on
// internal/mailer directly without dragging the whole transactional
// surface; this thin adapter lives in main where everything is already
// stitched together.
type billingPaymentFailedAdapter struct {
	Mailer      mailer.Mailer
	FromAddress string
}

// SendPaymentFailed renders the dunning email and hands it to the
// underlying mailer. Returns the mailer's error so the goroutine in
// webhook.go can log + bump the failure counter.
func (a *billingPaymentFailedAdapter) SendPaymentFailed(ctx context.Context, in billing.PaymentFailedEmail) error {
	if a == nil || a.Mailer == nil {
		return errors.New("billing payment_failed mailer: not configured")
	}
	from := strings.TrimSpace(a.FromAddress)
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	subject, plain, html := billingRenderPaymentFailed(in)
	return a.Mailer.Send(ctx, mailer.Message{
		From:     from,
		To:       in.To,
		Subject:  subject,
		Body:     plain,
		HTMLBody: html,
		Tags: map[string]string{
			"purpose": "billing_payment_failed",
		},
	})
}

// billingRenderPaymentFailed is a thin wrapper around the renderer
// inside the billing package. We could inline the copy here but
// keeping it inside billing/email.go keeps it testable + unit-pinned.
// This shim hides the unexported renderer.
func billingRenderPaymentFailed(in billing.PaymentFailedEmail) (string, string, string) {
	return billing.RenderPaymentFailedEmail(in)
}

// affiliateSignupMailerAdapter sends the admin review email for public
// affiliate applications. The affiliates package owns validation/storage but
// does not import the transactional mailer; main stitches the two together.
type affiliateSignupMailerAdapter struct {
	Mailer      mailer.Mailer
	FromAddress string
}

func (a *affiliateSignupMailerAdapter) NotifyAffiliateSignup(ctx context.Context, in affiliates.AffiliateSignupNotice) error {
	if a == nil || a.Mailer == nil {
		return errors.New("affiliate signup mailer: not configured")
	}
	from := strings.TrimSpace(a.FromAddress)
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	subject := "New affiliate application pending review"
	plain, bodyHTML := renderAffiliateSignupNotice(in)
	return a.Mailer.Send(ctx, mailer.Message{
		From:     from,
		To:       in.To,
		Subject:  subject,
		Body:     plain,
		HTMLBody: bodyHTML,
		Tags: map[string]string{
			"purpose": "affiliate_signup_review",
		},
	})
}

func renderAffiliateSignupNotice(in affiliates.AffiliateSignupNotice) (string, string) {
	var plain strings.Builder
	fmt.Fprintf(&plain, "New affiliate application\n\n")
	fmt.Fprintf(&plain, "Name: %s\n", in.Name)
	fmt.Fprintf(&plain, "Email: %s\n", in.Email)
	fmt.Fprintf(&plain, "Slug: %s\n", in.Slug)
	fmt.Fprintf(&plain, "Affiliate ID: %s\n", in.AffiliateID)
	if in.Country != "" {
		fmt.Fprintf(&plain, "Country: %s\n", in.Country)
	}
	if in.Website != "" {
		fmt.Fprintf(&plain, "Website: %s\n", in.Website)
	}
	if in.AudienceSize > 0 {
		fmt.Fprintf(&plain, "Audience size: %d\n", in.AudienceSize)
	}
	if in.AudienceDesc != "" {
		fmt.Fprintf(&plain, "Audience: %s\n", in.AudienceDesc)
	}
	fmt.Fprintf(&plain, "Status: %s\n", in.Status)

	row := func(label, value string) string {
		if strings.TrimSpace(value) == "" {
			return ""
		}
		return fmt.Sprintf("<tr><th align=\"left\">%s</th><td>%s</td></tr>",
			html.EscapeString(label), html.EscapeString(value))
	}
	htmlBody := "<p>A new affiliate application is pending review.</p><table cellpadding=\"6\" cellspacing=\"0\">" +
		row("Name", in.Name) +
		row("Email", in.Email) +
		row("Slug", in.Slug) +
		row("Affiliate ID", in.AffiliateID) +
		row("Country", in.Country) +
		row("Website", in.Website) +
		row("Audience size", fmt.Sprintf("%d", in.AudienceSize)) +
		row("Audience", in.AudienceDesc) +
		row("Status", string(in.Status)) +
		"</table>"
	return plain.String(), htmlBody
}

// scheduledReportMailerAdapter wraps mailer.Mailer to satisfy
// scheduled_reports.MailSender. Same narrowing pattern as the
// sending + billing adapters.
type scheduledReportMailerAdapter struct {
	Mailer mailer.Mailer
	From   string
}

// Send adapts (to, subject, body) → mailer.Message. Tagged so
// CloudWatch dashboards can filter scheduled-digest traffic
// separately from transactional auth mail.
func (a *scheduledReportMailerAdapter) Send(ctx context.Context, to, subject, body string) error {
	if a == nil || a.Mailer == nil {
		return scheduled_reports.NewRejectedError(
			errors.New("scheduled-reports mailer: not configured"),
		)
	}
	message := mailer.Message{
		From:    a.From,
		To:      to,
		Subject: subject,
		Body:    body,
		Tags:    map[string]string{"purpose": "scheduled_report"},
	}
	if err := message.Validate(); err != nil {
		return scheduled_reports.NewRejectedError(err)
	}
	err := a.Mailer.Send(ctx, message)
	if err == nil {
		return nil
	}
	var permanent *mailer.PermanentError
	if errors.As(err, &permanent) {
		return scheduled_reports.NewRejectedError(err)
	}
	return err
}

// stripeDLQMailerAdapter wraps mailer.Mailer to satisfy
// webhook_retry.Mailer. Same narrowing pattern as
// scheduledReportMailerAdapter above. Tagged so CloudWatch dashboards
// can filter dead-letter alert traffic separately from the rest of the
// transactional mail.
type stripeDLQMailerAdapter struct {
	Mailer mailer.Mailer
	From   string
}

// SendDeadLetterAlert composes a plain-text ops alert from the
// dead-lettered attempt and dispatches it via the platform mailer.
func (a *stripeDLQMailerAdapter) SendDeadLetterAlert(ctx context.Context, to string, attempt webhook_retry.Attempt) error {
	if a == nil || a.Mailer == nil {
		return errors.New("stripe dlq mailer: not configured")
	}
	body := fmt.Sprintf(
		"A Stripe webhook event was dead-lettered after exhausting all retries.\n\n"+
			"Event ID:      %s\n"+
			"Attempts:      %d\n"+
			"Last error:    %s\n"+
			"Dead-lettered: %s\n\n"+
			"Replay it via the internal DLQ admin endpoint once the underlying cause is fixed.",
		attempt.EventID,
		attempt.AttemptNumber,
		attempt.LastError,
		attempt.UpdatedAt.UTC().Format(time.RFC3339))
	return a.Mailer.Send(ctx, mailer.Message{
		From:    a.From,
		To:      to,
		Subject: "[Moosewave] Stripe webhook dead-lettered: " + attempt.EventID,
		Body:    body,
		Tags:    map[string]string{"purpose": "stripe_dlq_alert"},
	})
}

// opsAlertMailerAdapter narrows mailer.Mailer to ops.EmailSender for the
// ops-console push channel. Same narrowing pattern as
// stripeDLQMailerAdapter above; tagged so CloudWatch dashboards can filter
// ops alert traffic separately from the rest of the transactional mail.
type opsAlertMailerAdapter struct {
	Mailer mailer.Mailer
	From   string
}

// Send dispatches one ops push (alert, resolved, repush, digest, or canary)
// via the platform mailer. Subject and body arrive fully rendered from
// ops.EmailChannel.
func (a *opsAlertMailerAdapter) Send(ctx context.Context, to, subject, body string) error {
	if a == nil || a.Mailer == nil {
		return errors.New("ops alert mailer: not configured")
	}
	return a.Mailer.Send(ctx, mailer.Message{
		From:    a.From,
		To:      to,
		Subject: subject,
		Body:    body,
		Tags:    map[string]string{"purpose": "ops_alert"},
	})
}

// sendingMailerAdapter wraps the auth-tier mailer.Mailer to satisfy
// sending.Mailer. The sending package keeps its own narrow Mailer
// interface so a unit test can stub it without importing internal/mailer.
type sendingMailerAdapter struct {
	Mailer mailer.Mailer
}

// sendingNotificationFeedAdapter routes the send-complete notification
// through the unified notifyfanout chokepoint: one feed row per recipient
// (deduped per campaign) whose id also rides mobile push, web push, and the
// SSE bus. Gated per-user by PrefSendComplete — the manifest's Apple-style
// "toggle a category off and it silences everywhere" semantics.
type sendingNotificationFeedAdapter struct {
	fanout *notifyfanout.Fanout
}

func (a *sendingNotificationFeedAdapter) Fanout(ctx context.Context, tenantID string, userIDs []string, n sending.FeedNotification) error {
	if a == nil || a.fanout == nil {
		return nil
	}
	campaignID, _ := n.Payload["campaign_id"].(string)
	dedupe := ""
	if campaignID != "" {
		dedupe = "campaign.sent:" + campaignID
	}
	a.fanout.Dispatch(ctx, tenantID, userIDs, notifyfanout.Event{
		Type:       "campaign.sent",
		Kind:       n.Kind,
		Title:      n.Title,
		Body:       n.Body,
		MobileBody: "A campaign finished sending.",
		URL:        n.DeepLink,
		EntityID:   campaignID,
		DedupeKey:  dedupe,
		Pref:       notifications.PrefSendComplete,
		Payload:    n.Payload,
	})
	return nil
}

// Send adapts a sending.MailMessage to a mailer.Message and dispatches.
// Tags fixed to {purpose: send_complete} so CloudWatch dashboards can
// filter on this notification class.
func (a *sendingMailerAdapter) Send(ctx context.Context, m sending.MailMessage) error {
	if a == nil || a.Mailer == nil {
		return errors.New("send-complete mailer: not configured")
	}
	return a.Mailer.Send(ctx, mailer.Message{
		From:     m.From,
		To:       m.To,
		Subject:  m.Subject,
		Body:     m.Text,
		HTMLBody: m.HTML,
		Tags:     map[string]string{"purpose": "send_complete"},
	})
}

// sendingTenantUserRepo reads admin/editor users for a tenant from the
// `users` table. Implements sending.TenantUserRepo so the send-complete
// notifier can enumerate recipients without the sending package pulling
// in pgx as a direct dependency.
type sendingTenantUserRepo struct {
	Pool *db.Pool
}

// ListUsersForTenant returns the (user_id, email) pairs for users in
// the named roles. Empty `roles` returns no rows (the caller must
// supply a non-empty allowlist). Reads outside any tenant tx — the
// WHERE clause is the isolation boundary, mirroring billing/email.go's
// ownerEmailForTenant.
func (r *sendingTenantUserRepo) ListUsersForTenant(ctx context.Context, tenantID string, roles []string) ([]sending.TenantUser, error) {
	if r == nil || r.Pool == nil || tenantID == "" || len(roles) == 0 {
		return nil, nil
	}
	rows, err := r.Pool.Query(ctx, `
SELECT id::text, email
FROM users
WHERE tenant_id = $1::uuid AND role = ANY($2::text[])
ORDER BY created_at ASC`, tenantID, roles)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]sending.TenantUser, 0, 4)
	for rows.Next() {
		var u sending.TenantUser
		if err := rows.Scan(&u.ID, &u.Email); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// approvalsAdminListerAdapter implements approvals.AdminLister against
// the canonical users table. Returns owner+admin users for the given
// tenant; per-recipient PrefApprovalRequest gating in
// approvals.PostmarkNotifier then decides which addresses actually
// receive the email. Empty result (no enumerated admins) makes the
// notifier fall back to the legacy single-mailbox path inside
// PostmarkNotifier.NotifyRequested.
type approvalsAdminListerAdapter struct{ Pool *db.Pool }

// ListApprovalRecipients enumerates (user_id, email) pairs for users
// in role owner/admin for tenantID. Reads outside any tenant tx — the
// WHERE clause is the isolation boundary, mirroring
// sendingTenantUserRepo.ListUsersForTenant. ORDER BY created_at keeps
// the recipient ordering stable across runs.
func (a *approvalsAdminListerAdapter) ListApprovalRecipients(ctx context.Context, tenantID string) ([]approvals.AdminRecipient, error) {
	if a == nil || a.Pool == nil || tenantID == "" {
		return nil, nil
	}
	rows, err := a.Pool.Query(ctx, `
SELECT id::text, email
FROM users
WHERE tenant_id = $1::uuid
  AND role IN ('owner', 'admin')
  AND email IS NOT NULL
  AND email <> ''
ORDER BY created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []approvals.AdminRecipient{}
	for rows.Next() {
		var r approvals.AdminRecipient
		if err := rows.Scan(&r.UserID, &r.Email); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// approvalsPushAdapter routes the (upstream-gated) approval signal through
// the unified notifyfanout chokepoint: the feed row's id becomes the shared
// notification identity on every channel, a replayed request dedupes on
// "approval.requested:<id>", and the SSE bus carries the in-app event.
// Native delivery stays content-light — only the event/entity id and a
// generic body reach an Expo payload, never the approval/customer row.
type approvalsPushAdapter struct {
	fanout *notifyfanout.Fanout
}

func (a approvalsPushAdapter) SendToUser(ctx context.Context, tenantID, userID string, n approvals.PushNotification) (int, error) {
	if a.fanout == nil {
		return 0, nil
	}
	entityID := strings.TrimPrefix(n.Tag, "approval-")
	if entityID == n.Tag {
		entityID = ""
	}
	dedupe := n.Tag
	if entityID != "" {
		dedupe = "approval.requested:" + entityID
	}
	deliveries := a.fanout.Dispatch(ctx, tenantID, []string{userID}, notifyfanout.Event{
		Type:       "approval.requested",
		Kind:       "approval_request",
		Title:      n.Title,
		Body:       n.Body,
		MobileBody: "A pending request is waiting for your decision.",
		URL:        n.URL,
		EntityID:   entityID,
		DedupeKey:  dedupe,
		// Pref left empty: approvals gate per-recipient upstream
		// (PostmarkNotifier via notifications.Dispatcher) — no double gate.
	})
	total := 0
	for _, d := range deliveries {
		total += d.WebSent + d.MobileSent
	}
	return total, nil
}

// operatorNotifyAdapter and its engine-event and run-failure notifiers moved to
// operator_notify_alerts.go, which is where the rest of that adapter's alerts
// already lived. This file had grown past its 1000-line budget again, and the
// budget's own rule is that the answer is a cohesive file rather than a raised
// ceiling.

// reviewsFlowEventAdapter bridges reviews.FlowEventEmitter to internal/track so
// native review actions trigger Klaviyo-style flows via the same product_event
// path external review ingestion uses (review_integrations.TrackEventSink).
// Best-effort + detached from the request: the review response never waits on
// (and is never failed by) event recording or flow fanout.
// deliverabilityQuotaAdapter bridges the inboxreality/emailpreview QuotaMeter
// interfaces to deliverability_control's entitlement meter. A quota-exceeded
// result maps to allowed=false (the handler replies 402); any other error is
// surfaced so the handler fails open rather than block a paid feature.
type deliverabilityQuotaAdapter struct{ repo *deliverability_control.Repo }

func (a deliverabilityQuotaAdapter) Consume(ctx context.Context, tenantID, resource string) (int, bool, *deliverability_control.Ceiling, error) {
	remaining, ceiling, err := a.repo.CheckAndConsume(ctx, tenantID, resource)
	if errors.Is(err, deliverability_control.ErrQuotaExceeded) {
		// The ceiling measured by the transaction that refused. nil when the
		// tenant is ungated or the row could not be read — the caller must then
		// OMIT the numbers, never substitute a sentinel: `-1` is not "unknown"
		// to a client, it is a number, and `limit - current` renders it as a
		// plausible zero.
		return 0, false, ceiling, nil
	}
	if err != nil {
		return 0, true, nil, err
	}
	// remaining == -1 means the tenant has no configured entitlement (ungated).
	return remaining, true, nil, nil
}

// approvalsEscalationNotifier is the consumer `approval.escalated` never had.
//
// The sweeper emitted the topic on the event bus and nothing subscribed, so an
// escalation stamped a column and reached nobody. This routes it through the
// same `notifyfanout` chokepoint `approval.requested` uses, which writes the
// feed row first as the cross-channel identity and then fans to web push,
// mobile push and SSE under per-user preferences.
//
// Deduped on "approval.escalated:<id>" — distinct from the request's key, so an
// escalation is not swallowed as a duplicate of the original ask, and a
// re-escalation of the same approval is.
type approvalsEscalationNotifier struct {
	fanout *notifyfanout.Fanout
	// The SAME recipient resolver the request path uses. A second "who should
	// hear about approvals" query would be a copy that drifts.
	admins approvals.AdminLister
	logger *slog.Logger
}

func (a approvalsEscalationNotifier) NotifyEscalated(ctx context.Context, n approvals.EscalationNotice) {
	if a.fanout == nil || a.admins == nil {
		return
	}
	admins, err := a.admins.ListApprovalRecipients(ctx, n.TenantID)
	if err != nil {
		if a.logger != nil {
			a.logger.Warn("approvals escalation: recipient lookup failed",
				"tenant_id", n.TenantID, "approval_id", n.ApprovalID, "err", err.Error())
		}
		return
	}
	recipients := make([]string, 0, len(admins))
	for _, ad := range admins {
		if ad.UserID != "" {
			recipients = append(recipients, ad.UserID)
		}
	}
	if len(recipients) == 0 {
		return
	}
	a.fanout.Dispatch(ctx, n.TenantID, recipients, notifyfanout.Event{
		Type:       "approval.escalated",
		Kind:       "approval_request",
		Title:      "Approval overdue",
		Body:       "A request has passed its escalation window and still needs a decision.",
		MobileBody: "A request has passed its escalation window and still needs a decision.",
		EntityID:   n.ApprovalID,
		DedupeKey:  "approval.escalated:" + n.ApprovalID,
	})
}

// consentSyncWebhookDeliverer pushes a consent-sync ledger row onto the
// outbound-webhook delivery pipeline.
//
// It ENQUEUES rather than performing its own HTTP call. The pipeline already
// owns signing, retry with backoff, secondary-key rotation, the DLQ and the
// delivery-history surface an operator inspects; a second HTTP client here
// would be a parallel delivery mechanism whose failures nobody could see, and
// the ledger's own retry sweep would then be racing it.
//
// The ledger row remains the compliance record — "this destination was told, at
// this time, and here is the attempt history" — and the pipeline is how the
// telling happens.
type consentSyncWebhookDeliverer struct {
	store *outbound_webhooks.Store
}

func (d consentSyncWebhookDeliverer) Deliver(ctx context.Context, row subscribers.ConsentSyncLedgerRow) error {
	if d.store == nil {
		return errors.New("consent sync: no webhook store configured")
	}
	payload, err := json.Marshal(map[string]any{
		"event":         "subscriber.unsubscribed",
		"subscriber_id": row.SubscriberID,
		"event_type":    row.EventType,
		// The ledger row id, so a delivery in the webhook history can be traced
		// back to the consent decision that required it.
		"consent_sync_id": row.ID,
	})
	if err != nil {
		return err
	}
	_, err = d.store.EnqueueDelivery(ctx, row.TenantID, row.DestinationID,
		outbound_webhooks.EventSubscriberUnsubscribed, "consent-sync:"+row.ID, payload)
	return err
}
