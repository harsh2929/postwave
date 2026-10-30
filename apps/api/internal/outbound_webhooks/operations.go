// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"fmt"
	"html"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

var (
	ErrAutoDisableNotifierUnconfigured = errors.New(
		"outbound_webhooks: auto-disable notifier is not configured",
	)
	outboundWebhookExhaustedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "outbound_webhook_exhausted_total",
		Help: "Outbound webhook deliveries that reached a terminal exhausted state, by event type.",
	}, []string{"event_type"})
	outboundWebhookLeaseAcquiredTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "outbound_webhook_lease_acquired_total",
		Help: "Outbound webhook delivery rows acquired by workers. Worker identity is deliberately omitted to avoid restart-driven label cardinality.",
	})
)

// PrometheusMetrics is the production MetricsSink.
type PrometheusMetrics struct{}

func (*PrometheusMetrics) IncExhausted(eventType string) {
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		eventType = "unknown"
	}
	outboundWebhookExhaustedTotal.WithLabelValues(eventType).Inc()
}

func (*PrometheusMetrics) IncLeaseAcquired(_ string, count int) {
	if count > 0 {
		outboundWebhookLeaseAcquiredTotal.Add(float64(count))
	}
}

// EmailAutoDisableNotifier sends a single immediate notification to the
// tenant owner, respecting their webhook auto-disable preference. It never
// includes the receiver URL because path/query components can be capabilities.
type EmailAutoDisableNotifier struct {
	Pool          *db.Pool
	Mailer        mailer.Mailer
	From          string
	PublicBaseURL string
}

func (n *EmailAutoDisableNotifier) NotifyWebhookAutoDisabled(
	ctx context.Context,
	tenantID,
	webhookID string,
) error {
	if n == nil || n.Pool == nil || n.Mailer == nil {
		return ErrAutoDisableNotifierUnconfigured
	}
	tx, err := db.WithTenant(ctx, n.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email, tenantName string
	err = tx.QueryRow(ctx, `
SELECT user_account.email, COALESCE(tenant.name, '')
  FROM users AS user_account
  JOIN tenants AS tenant ON tenant.id = user_account.tenant_id
  LEFT JOIN webhook_alert_prefs AS preference
    ON preference.tenant_id = user_account.tenant_id
   AND preference.user_id = user_account.id
 WHERE user_account.tenant_id = $1::uuid
   AND user_account.role = 'owner'
   AND NULLIF(btrim(user_account.email), '') IS NOT NULL
   AND COALESCE(preference.notify_auto_disabled, true) = true
 ORDER BY user_account.created_at, user_account.id
 LIMIT 1`, tenantID).Scan(&email, &tenantName)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	from := strings.TrimSpace(n.From)
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	workspace := strings.TrimSpace(tenantName)
	if workspace == "" {
		workspace = "your Moosewave workspace"
	}
	destination := strings.TrimRight(strings.TrimSpace(n.PublicBaseURL), "/")
	if destination == "" {
		destination = "https://app.moosewave.com"
	}
	// `/webhooks` is not a route on any surface — apps/web serves the outbound
	// webhook manager at /app/settings/webhooks (apps/web/src/app/(dashboard)/
	// app/settings/webhooks), and there is no root-level /webhooks page. The
	// "Review webhook health" link in this email was therefore a 404 for every
	// recipient of an alert whose entire purpose is getting someone to act.
	destination += "/app/settings/webhooks"
	subject := "Action required: an outbound webhook was paused"
	plain := fmt.Sprintf(
		"Moosewave paused outbound webhook %s in %s after %d consecutive delivery failures.\n\n"+
			"Queued deliveries are safely paused and will not be sent until an administrator reviews and re-enables the endpoint.\n\n"+
			"Review webhook health: %s\n",
		webhookID,
		workspace,
		AutoDisableThreshold,
		destination,
	)
	htmlBody := fmt.Sprintf(
		`<!doctype html><html><body><h2>Outbound webhook paused</h2><p>Moosewave paused webhook <code>%s</code> in %s after %d consecutive delivery failures.</p><p>Queued deliveries are safely paused until an administrator reviews and re-enables it.</p><p><a href="%s">Review webhook health</a></p></body></html>`,
		html.EscapeString(webhookID),
		html.EscapeString(workspace),
		AutoDisableThreshold,
		html.EscapeString(destination),
	)
	return n.Mailer.Send(ctx, mailer.Message{
		From:     from,
		To:       strings.TrimSpace(email),
		Subject:  subject,
		Body:     plain,
		HTMLBody: htmlBody,
		Tags: map[string]string{
			"purpose": "outbound_webhook_auto_disabled",
		},
	})
}
