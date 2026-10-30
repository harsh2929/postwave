// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// DigestRecipient is a single (user, tenant, frequency) entry the
// sender will process on its next tick. Loaded from the
// dashboard_digest_prefs table joined against users for the email.
type DigestRecipient struct {
	UserID     string
	TenantID   string
	Email      string
	Frequency  string // "daily" | "weekly"
	LastSentAt *time.Time
	TenantName string
}

const dashboardDigestBatchLimit = 500

type dueDigestRecipient struct {
	DigestRecipient
	preferenceUpdatedAt time.Time
}

type tenantDigestQueue struct {
	tenantID   string
	recipients []dueDigestRecipient
	next       int
}

// DigestSender ticks every Interval, finds users whose digest is due
// (based on frequency + last_sent_at), pulls fresh stats for their
// tenant, renders + sends an HTML email, and updates last_sent_at.
//
// Failures per-recipient are logged and skipped — one user with a
// broken email shouldn't stall the whole queue.
type DigestSender struct {
	Pool     *db.Pool
	Repo     *Repo
	Mailer   mailer.Mailer
	From     string        // e.g. "Moosewave Digest <digest@moosewave.com>"
	Interval time.Duration // default 1 hour
	Logger   *slog.Logger
}

// Run blocks until ctx is cancelled, sweeping the recipients table every
// Interval. last_sent_at suppresses ordinary re-runs, but delivery is
// intentionally at-least-once: a process crash after Mailer.Send succeeds and
// before last_sent_at commits can produce a duplicate.
func (s *DigestSender) Run(ctx context.Context) {
	if s.Interval == 0 {
		s.Interval = time.Hour
	}
	if s.From == "" {
		s.From = "Moosewave Digest <digest@moosewave.com>"
	}
	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()
	s.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *DigestSender) tick(ctx context.Context) {
	if s.Pool == nil || s.Repo == nil || s.Mailer == nil {
		return
	}
	recipients, err := s.dueRecipients(ctx)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("digest sender: list recipients", "err", err)
		}
		return
	}
	for _, r := range recipients {
		if ctx.Err() != nil {
			return
		}
		if err := s.sendOne(ctx, r); err != nil && s.Logger != nil {
			s.Logger.Warn("digest sender: send failed",
				"user", r.UserID, "tenant", r.TenantID, "err", err)
		}
	}
}

// dueRecipients returns the set of (user, tenant) rows whose digest
// is currently due. "Daily" digests are due if last_sent_at is more
// than 22h ago (gives a little slop so a slightly-late tick still
// hits the right hour); "weekly" if more than 6.5 days ago. Never
// returns "off" rows.
//
// The only cross-tenant operation is tenant ID enumeration through the narrow
// worker policy. Preference, user, and workspace data are read under
// db.WithTenant. scheduleDigestRecipients enforces one global cap and
// round-robins tenant queues so a large workspace cannot consume the batch.
func (s *DigestSender) dueRecipients(ctx context.Context) ([]DigestRecipient, error) {
	tenantIDs, err := dashboardWorkerTenantIDs(ctx, s.Pool)
	if err != nil {
		return nil, err
	}

	queues := make([]tenantDigestQueue, 0, len(tenantIDs))
	for _, tenantID := range tenantIDs {
		recipients, err := s.dueRecipientsForTenant(ctx, tenantID, dashboardDigestBatchLimit)
		if err != nil {
			return nil, err
		}
		if len(recipients) == 0 {
			continue
		}
		queues = append(queues, tenantDigestQueue{
			tenantID:   tenantID,
			recipients: recipients,
		})
	}
	return scheduleDigestRecipients(queues, dashboardDigestBatchLimit), nil
}

func (s *DigestSender) dueRecipientsForTenant(
	ctx context.Context,
	tenantID string,
	limit int,
) ([]dueDigestRecipient, error) {
	if limit <= 0 {
		return []dueDigestRecipient{}, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("scope digest tenant %s: %w", tenantID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT p.user_id::text, p.tenant_id::text, u.email, p.frequency,
       p.last_sent_at, COALESCE(t.name, '') AS tenant_name, p.updated_at
FROM dashboard_digest_prefs p
JOIN users u ON u.id = p.user_id
JOIN tenants t ON t.id = p.tenant_id
WHERE p.tenant_id = $1::uuid
  AND p.frequency IN ('daily', 'weekly')
  AND u.email IS NOT NULL
  AND u.email <> ''
  AND (
    p.last_sent_at IS NULL
    OR (p.frequency = 'daily'  AND p.last_sent_at < now() - interval '22 hours')
    OR (p.frequency = 'weekly' AND p.last_sent_at < now() - interval '6 days 12 hours')
  )
ORDER BY p.last_sent_at NULLS FIRST, p.updated_at, p.user_id
LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, fmt.Errorf("list digest recipients for tenant %s: %w", tenantID, err)
	}
	defer rows.Close()
	out := make([]dueDigestRecipient, 0)
	for rows.Next() {
		var r dueDigestRecipient
		if err := rows.Scan(
			&r.UserID, &r.TenantID, &r.Email, &r.Frequency,
			&r.LastSentAt, &r.TenantName, &r.preferenceUpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan digest recipient for tenant %s: %w", tenantID, err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate digest recipients for tenant %s: %w", tenantID, err)
	}
	return out, nil
}

func scheduleDigestRecipients(
	queues []tenantDigestQueue,
	limit int,
) []DigestRecipient {
	if limit <= 0 || len(queues) == 0 {
		return []DigestRecipient{}
	}
	nonEmpty := queues[:0]
	for _, queue := range queues {
		if queue.next >= 0 && queue.next < len(queue.recipients) {
			nonEmpty = append(nonEmpty, queue)
		}
	}
	queues = nonEmpty
	if len(queues) == 0 {
		return []DigestRecipient{}
	}
	effectiveLimit := min(limit, dashboardDigestBatchLimit)

	// When more tenant queues exist than fit in one batch, tenants with the
	// oldest due head are selected first. The round-robin below then gives
	// every selected tenant one slot before any tenant receives another.
	sort.SliceStable(queues, func(i, j int) bool {
		left := queues[i].recipients[queues[i].next]
		right := queues[j].recipients[queues[j].next]
		if left.LastSentAt == nil && right.LastSentAt != nil {
			return true
		}
		if left.LastSentAt != nil && right.LastSentAt == nil {
			return false
		}
		if left.LastSentAt != nil && right.LastSentAt != nil &&
			!left.LastSentAt.Equal(*right.LastSentAt) {
			return left.LastSentAt.Before(*right.LastSentAt)
		}
		if !left.preferenceUpdatedAt.Equal(right.preferenceUpdatedAt) {
			return left.preferenceUpdatedAt.Before(right.preferenceUpdatedAt)
		}
		return queues[i].tenantID < queues[j].tenantID
	})

	out := make([]DigestRecipient, 0, effectiveLimit)
	for len(out) < effectiveLimit {
		added := false
		for i := range queues {
			if queues[i].next >= len(queues[i].recipients) {
				continue
			}
			out = append(out, queues[i].recipients[queues[i].next].DigestRecipient)
			queues[i].next++
			added = true
			if len(out) == effectiveLimit {
				break
			}
		}
		if !added {
			break
		}
	}
	return out
}

func (s *DigestSender) sendOne(ctx context.Context, r DigestRecipient) error {
	// Pull fresh stats for the tenant. Use 7d for daily digests, 30d
	// for weekly — matches the timeframe the email is summarising.
	rng := "7d"
	if r.Frequency == "weekly" {
		rng = "30d"
	}
	stats, err := s.Repo.DashboardStatsWithOptions(ctx, r.TenantID,
		DashboardStatsOptions{Range: rng, Compare: true, Sparklines: false})
	if err != nil {
		return fmt.Errorf("fetch stats: %w", err)
	}
	subject, text, html := renderDigest(r, stats)
	msg := mailer.Message{
		From:     s.From,
		To:       r.Email,
		Subject:  subject,
		Body:     text,
		HTMLBody: html,
		Tags: map[string]string{
			"purpose":   "dashboard_digest",
			"frequency": r.Frequency,
			"range":     rng,
		},
	}
	if err := s.Mailer.Send(ctx, msg); err != nil {
		return fmt.Errorf("mailer send: %w", err)
	}
	// Mark sent. Done in a tenant-scoped tx so RLS is happy.
	tx, err := db.WithTenant(ctx, s.Pool, r.TenantID)
	if err != nil {
		return fmt.Errorf("with tenant: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE dashboard_digest_prefs SET last_sent_at = now()
WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
		r.UserID, r.TenantID); err != nil {
		return fmt.Errorf("mark sent: %w", err)
	}
	return tx.Commit(ctx)
}

// renderDigest formats the digest email in three forms (subject, plain
// text, html). Plain text is the source of truth — html is a
// minimally-styled reformulation so accessibility / dark-mode mail
// clients render cleanly.
func renderDigest(r DigestRecipient, s *DashboardStats) (string, string, string) {
	periodLabel := "the last 7 days"
	if r.Frequency == "weekly" {
		periodLabel = "the last 30 days"
	}
	subject := fmt.Sprintf("Your %s Moosewave digest", r.Frequency)

	var prevSubs, prevOpens, prevClicks, prevBounces int
	if s.Previous != nil {
		prevSubs = s.Previous.SubscribersAdded
		prevOpens = s.Previous.OpensTotal
		prevClicks = s.Previous.ClicksTotal
		prevBounces = s.Previous.BouncesTotal
	}

	tenantName := strings.TrimSpace(r.TenantName)
	if tenantName == "" {
		tenantName = "Your workspace"
	}

	plain := strings.Builder{}
	plain.WriteString(fmt.Sprintf("%s — Moosewave summary\n", tenantName))
	plain.WriteString(fmt.Sprintf("Window: %s\n\n", periodLabel))
	plain.WriteString(metricLine("Subscribers (total)", s.SubscribersTotal, -1))
	plain.WriteString(metricLine("New subscribers", s.SubscribersAdded30d, prevSubs))
	plain.WriteString(metricLine("Opens", s.OpensTotal30d, prevOpens))
	plain.WriteString(metricLine("Clicks", s.ClicksTotal30d, prevClicks))
	plain.WriteString(metricLine("Bounces", s.BouncesTotal30d, prevBounces))
	plain.WriteString("\n")
	plain.WriteString(fmt.Sprintf("Open your dashboard: https://moosewave.com/dashboard?utm_source=digest&utm_medium=email&utm_campaign=%s\n",
		url.QueryEscape(r.Frequency)))
	plain.WriteString("\n")
	plain.WriteString("You're receiving this because you opted into the Moosewave dashboard digest. Change your preference in Settings.\n")

	html := strings.Builder{}
	html.WriteString(`<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:24px auto;color:#14171f">`)
	html.WriteString(fmt.Sprintf(`<h2 style="margin:0 0 4px 0;font-size:18px">%s</h2>`, htmlEscape(tenantName)))
	html.WriteString(fmt.Sprintf(`<div style="color:#6b7280;font-size:12px;margin-bottom:20px">Moosewave summary · %s</div>`, htmlEscape(periodLabel)))
	html.WriteString(`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0">`)
	html.WriteString(metricRowHTML("Subscribers (total)", s.SubscribersTotal, -1))
	html.WriteString(metricRowHTML("New subscribers", s.SubscribersAdded30d, prevSubs))
	html.WriteString(metricRowHTML("Opens", s.OpensTotal30d, prevOpens))
	html.WriteString(metricRowHTML("Clicks", s.ClicksTotal30d, prevClicks))
	html.WriteString(metricRowHTML("Bounces", s.BouncesTotal30d, prevBounces))
	html.WriteString(`</table>`)
	html.WriteString(fmt.Sprintf(`<p style="margin-top:24px"><a href="https://moosewave.com/dashboard?utm_source=digest&utm_medium=email&utm_campaign=%s" style="background:#14b8a6;color:#042f2e;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600">Open your dashboard</a></p>`,
		url.QueryEscape(r.Frequency)))
	html.WriteString(`<p style="color:#9aa0aa;font-size:11px;margin-top:32px">You're receiving this because you opted into the Moosewave dashboard digest. Change your preference in Settings.</p>`)
	html.WriteString(`</body></html>`)

	return subject, plain.String(), html.String()
}

func metricLine(label string, val, prev int) string {
	if prev < 0 {
		return fmt.Sprintf("%-25s  %s\n", label+":", formatInt(val))
	}
	delta := val - prev
	sign := "+"
	if delta < 0 {
		sign = ""
	}
	return fmt.Sprintf("%-25s  %s  (%s%s vs prev)\n",
		label+":", formatInt(val), sign, formatInt(delta))
}

func metricRowHTML(label string, val, prev int) string {
	var deltaCell string
	if prev >= 0 {
		delta := val - prev
		colour := "#10b981"
		if delta < 0 {
			colour = "#ef4444"
		}
		if delta == 0 {
			colour = "#6b7280"
		}
		sign := "+"
		if delta < 0 {
			sign = ""
		}
		deltaCell = fmt.Sprintf(
			`<td align="right" style="padding:6px 0;color:%s;font-variant-numeric:tabular-nums">%s%s</td>`,
			colour, sign, formatInt(delta))
	} else {
		deltaCell = `<td></td>`
	}
	return fmt.Sprintf(
		`<tr><td style="padding:6px 0;color:#485160;font-size:13px">%s</td>`+
			`<td align="right" style="padding:6px 12px 6px 0;font-weight:600;font-variant-numeric:tabular-nums">%s</td>`+
			`%s</tr>`,
		htmlEscape(label), formatInt(val), deltaCell,
	)
}

func formatInt(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	parts := []string{}
	for n > 0 {
		if n >= 1000 {
			parts = append([]string{fmt.Sprintf("%03d", n%1000)}, parts...)
			n /= 1000
		} else {
			parts = append([]string{fmt.Sprintf("%d", n)}, parts...)
			n = 0
		}
	}
	out := strings.Join(parts, ",")
	if neg {
		out = "-" + out
	}
	return out
}

func htmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}
