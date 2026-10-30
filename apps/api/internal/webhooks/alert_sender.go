// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// AlertSender ticks every Interval, scans webhook_alert_prefs for
// opt-in users, evaluates each user's tenant webhooks against their
// chosen thresholds, and sends one consolidated email per user when
// at least one webhook is misbehaving.
//
// Idempotency: webhook_alert_prefs.last_alerted_at is updated after
// each send so we don't re-alert more than once per cooldown window
// (default 1 hour). Restart-safe — the cooldown lives in the DB.
//
// Refined Webhooks closes the loop on PR 3.
type AlertSender struct {
	Pool     *db.Pool
	Repo     *Repo
	Mailer   mailer.Mailer
	From     string
	Interval time.Duration // default 15 minutes
	Cooldown time.Duration // default 1 hour (per-user, per-condition silence)
	Logger   *slog.Logger
}

// alertRecipient is one row from the join of webhook_alert_prefs
// against users + tenants. Loaded in a single sweep per tick.
type alertRecipient struct {
	UserID             string
	TenantID           string
	Email              string
	TenantName         string
	NotifyAutoDisabled bool
	NotifyFailureRate  bool
	FailureRatePct     int
	NotifyLatency      bool
	LatencyMs          int
	LastAlertedAt      *time.Time
}

// triggered describes one alert hit ready to render into the email.
type triggered struct {
	WebhookID   string
	WebhookURL  string
	Reason      string // "auto_disabled" | "failure_rate" | "latency"
	Description string // human-readable, included in the email body
}

// Run blocks until ctx is cancelled.
func (s *AlertSender) Run(ctx context.Context) {
	if s.Interval == 0 {
		s.Interval = 15 * time.Minute
	}
	if s.Cooldown == 0 {
		s.Cooldown = 1 * time.Hour
	}
	if s.From == "" {
		s.From = "Moosewave Alerts <alerts@moosewave.com>"
	}
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	s.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *AlertSender) tick(ctx context.Context) {
	if s.Pool == nil || s.Repo == nil || s.Mailer == nil {
		return
	}
	recipients, err := s.dueRecipients(ctx)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("webhook alert sender: list recipients", "err", err)
		}
		return
	}
	for _, r := range recipients {
		if ctx.Err() != nil {
			return
		}
		if err := s.evaluateAndSend(ctx, r); err != nil && s.Logger != nil {
			s.Logger.Warn("webhook alert sender: evaluate",
				"user", r.UserID, "tenant", r.TenantID, "err", err)
		}
	}
}

func (s *AlertSender) dueRecipients(ctx context.Context) ([]alertRecipient, error) {
	// Off-cooldown users only. Cooldown is enforced in SQL so a busy
	// tenant doesn't get re-emailed on every tick.
	rows, err := s.Pool.Query(ctx, `
SELECT p.user_id::text, p.tenant_id::text, u.email,
       COALESCE(t.name, ''),
       p.notify_auto_disabled, p.notify_failure_rate, p.failure_rate_pct,
       p.notify_latency, p.latency_ms, p.last_alerted_at
FROM webhook_alert_prefs p
JOIN users   u ON u.id = p.user_id
JOIN tenants t ON t.id = p.tenant_id
WHERE u.email IS NOT NULL AND u.email <> ''
  AND (p.notify_auto_disabled OR p.notify_failure_rate OR p.notify_latency)
  AND (
    p.last_alerted_at IS NULL
    OR p.last_alerted_at < now() - make_interval(secs => $1)
  )
LIMIT 200`, int(s.Cooldown.Seconds()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []alertRecipient{}
	for rows.Next() {
		var r alertRecipient
		if err := rows.Scan(
			&r.UserID, &r.TenantID, &r.Email, &r.TenantName,
			&r.NotifyAutoDisabled, &r.NotifyFailureRate, &r.FailureRatePct,
			&r.NotifyLatency, &r.LatencyMs, &r.LastAlertedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *AlertSender) evaluateAndSend(ctx context.Context, r alertRecipient) error {
	// Pull the tenant's webhooks. We use the existing List repo
	// method — this is the same path the admin UI sees, so the worker
	// observes whatever the admin observes.
	webhooks, err := s.Repo.List(ctx, r.TenantID)
	if err != nil {
		return fmt.Errorf("list webhooks: %w", err)
	}
	hits := []triggered{}
	for _, wh := range webhooks {
		// Pull 24h health for each. Cheap per call (a handful of
		// aggregations); we only do this for users who opted in.
		health, herr := s.Repo.Health(ctx, r.TenantID, wh.ID)
		if herr != nil {
			continue
		}
		if r.NotifyAutoDisabled && health.AutoDisabled {
			hits = append(hits, triggered{
				WebhookID:   wh.ID,
				WebhookURL:  wh.URL,
				Reason:      "auto_disabled",
				Description: fmt.Sprintf("Auto-disabled after %d consecutive failures.", health.ConsecutiveFailures),
			})
			continue // one hit is enough; don't double-report
		}
		denom := health.DeliveriesSucceeded + health.DeliveriesFailed
		if r.NotifyFailureRate && denom > 0 {
			pct := (health.DeliveriesFailed * 100) / denom
			if pct >= r.FailureRatePct {
				hits = append(hits, triggered{
					WebhookID:   wh.ID,
					WebhookURL:  wh.URL,
					Reason:      "failure_rate",
					Description: fmt.Sprintf("Failure rate %d%% over last 24h (threshold %d%%).", pct, r.FailureRatePct),
				})
				continue
			}
		}
		if r.NotifyLatency && health.LatencyP99Ms >= r.LatencyMs {
			hits = append(hits, triggered{
				WebhookID:   wh.ID,
				WebhookURL:  wh.URL,
				Reason:      "latency",
				Description: fmt.Sprintf("p99 latency %dms over last 24h (threshold %dms).", health.LatencyP99Ms, r.LatencyMs),
			})
		}
	}
	if len(hits) == 0 {
		return nil // nothing to alert on; don't burn the cooldown
	}
	subject, plain, html := renderAlert(r, hits)
	if err := s.Mailer.Send(ctx, mailer.Message{
		From:     s.From,
		To:       r.Email,
		Subject:  subject,
		Body:     plain,
		HTMLBody: html,
		Tags: map[string]string{
			"purpose": "webhook_alert",
		},
	}); err != nil {
		return fmt.Errorf("mailer send: %w", err)
	}
	// Mark cooldown.
	tx, err := db.WithTenant(ctx, s.Pool, r.TenantID)
	if err != nil {
		return fmt.Errorf("with tenant: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE webhook_alert_prefs SET last_alerted_at = now()
WHERE user_id = $1::uuid AND tenant_id = $2::uuid`, r.UserID, r.TenantID); err != nil {
		return fmt.Errorf("mark sent: %w", err)
	}
	return tx.Commit(ctx)
}

// renderAlert produces (subject, plain, html). Pure function;
// trivially unit-testable.
func renderAlert(r alertRecipient, hits []triggered) (string, string, string) {
	tenantName := strings.TrimSpace(r.TenantName)
	if tenantName == "" {
		tenantName = "your workspace"
	}
	subject := fmt.Sprintf("⚠ %d webhook%s misbehaving in %s",
		len(hits), pluralRune(len(hits)), tenantName)

	plain := strings.Builder{}
	plain.WriteString(fmt.Sprintf("%s — webhook alert\n\n", tenantName))
	for i, h := range hits {
		plain.WriteString(fmt.Sprintf("%d. %s\n   %s\n", i+1, h.WebhookURL, h.Description))
	}
	plain.WriteString("\n")
	plain.WriteString("Open: https://moosewave.com/webhooks?utm_source=alert&utm_medium=email\n")
	plain.WriteString("\nChange or silence these alerts in Settings → Webhook alerts.\n")

	html := strings.Builder{}
	html.WriteString(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:24px auto;color:#14171f">`)
	html.WriteString(fmt.Sprintf(`<h2 style="margin:0 0 4px 0;font-size:18px">⚠ %d webhook%s misbehaving</h2>`,
		len(hits), pluralRune(len(hits))))
	html.WriteString(fmt.Sprintf(`<div style="color:#6b7280;font-size:12px;margin-bottom:20px">%s</div>`,
		escAlert(tenantName)))
	html.WriteString(`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0">`)
	for _, h := range hits {
		colour := "#ef4444"
		switch h.Reason {
		case "failure_rate":
			colour = "#eab308"
		case "latency":
			colour = "#0ea5e9"
		}
		html.WriteString(fmt.Sprintf(
			`<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb">`+
				`<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#14171f">%s</div>`+
				`<div style="font-size:12px;color:%s;margin-top:2px">%s</div>`+
				`</td></tr>`,
			escAlert(h.WebhookURL), colour, escAlert(h.Description),
		))
	}
	html.WriteString(`</table>`)
	html.WriteString(fmt.Sprintf(`<p style="margin-top:24px"><a href="https://moosewave.com/webhooks?utm_source=alert&utm_medium=email&utm_campaign=%s" style="background:#14b8a6;color:#042f2e;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600">Open webhooks</a></p>`,
		url.QueryEscape("alert")))
	html.WriteString(`<p style="color:#9aa0aa;font-size:11px;margin-top:32px">Change or silence these alerts in Settings → Webhook alerts.</p>`)
	html.WriteString(`</body></html>`)

	return subject, plain.String(), html.String()
}

func pluralRune(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func escAlert(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}
