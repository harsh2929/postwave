// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// CongratsLookup resolves a subscriber id to an email address.
// Wired in main.go from the subscribers repo so this package doesn't
// take a hard dep on subscribers.
type CongratsLookup interface {
	SubscriberEmail(ctx context.Context, tenantID, subscriberID string) (string, bool)
}

// CongratsSender ticks every Interval and fires a transactional
// "🎉 you unlocked X" email to any referrer who has crossed a new
// milestone since the last tick.
//
// Idempotent: each conversion has a congrats_sent_at column. We
// only consider conversions where it's NULL; after sending we set
// it. So a milestone can never fire twice for the same conversion.
//
// PR 3. Wired via safego.Go alongside the other workers.
type CongratsSender struct {
	Pool     *db.Pool
	Repo     *Repo
	Mailer   mailer.Mailer
	From     string
	Interval time.Duration // default 10 minutes
	Logger   *slog.Logger
	Events   EventEmitter
	// Lookup resolves a referrer subscriber id to an email. When nil
	// the sender silently skips (no errors — there's just nobody to
	// email yet).
	Lookup CongratsLookup
}

// Run blocks until ctx is cancelled.
func (s *CongratsSender) Run(ctx context.Context) {
	if s.Interval == 0 {
		s.Interval = 10 * time.Minute
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

func (s *CongratsSender) tick(ctx context.Context) {
	if s.Pool == nil || s.Repo == nil || s.Mailer == nil {
		return
	}
	rows, err := s.dueConversions(ctx)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("congrats sender: list", "err", err)
		}
		return
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return
		}
		// A10: this is the milestone-unlock code path — persist the
		// fulfilment row BEFORE attempting the congrats email so a
		// missing referrer email / mailer hiccup never loses the payout.
		// Idempotent (unique on tenant+referrer+milestone), so retries
		// after a failed send are harmless.
		if err := s.Repo.EnsurePendingPayout(ctx, row.TenantID, row.ReferrerID,
			row.MilestoneCount, row.UnlockedLabel); err != nil && s.Logger != nil {
			s.Logger.Warn("congrats sender: ensure payout",
				"conversion", row.ConversionID, "err", err)
		}
		if err := s.sendOne(ctx, row); err != nil && s.Logger != nil {
			s.Logger.Warn("congrats sender: send",
				"conversion", row.ConversionID, "err", err)
		}
	}
}

type pendingCongrats struct {
	ConversionID   string
	TenantID       string
	ReferrerID     string
	RefereeID      string
	NewCount       int
	MilestoneCount int // the milestone boundary this conversion crossed
	UnlockedKind   string
	UnlockedLabel  string
}

// dueConversionRow is one bare row from the cross-tenant scan, before
// the per-tenant milestone diff enriches it.
type dueConversionRow struct {
	id         string
	tenantID   string
	referrerID string
	refereeID  string
	createdAt  time.Time
}

// scanDueConversions is the cross-tenant part of the tick: list
// not-yet-congratulated conversions for EVERY tenant.
//
// It MUST run under db.WithWorkerScope — referral_conversions is
// FORCE-RLS, and only the referral_conversions_worker_select policy
// (migration 0383, gated on app.outbox_worker = 'true') admits a scan
// with no tenant bound. A bare Pool.Query here binds no GUC at all, so
// RLS silently returns zero rows and the worker never fires (the
// exact regression the 2026-06-10 desktop audit caught).
func (s *CongratsSender) scanDueConversions(ctx context.Context) ([]dueConversionRow, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	// Read-only scan: rollback releases the worker-scoped tx (and its
	// connection) before the per-tenant follow-ups open their own.
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, referrer_subscriber_id, referee_subscriber_id, created_at
FROM referral_conversions
WHERE congrats_sent_at IS NULL
  AND fraud_score < 0.5
  AND COALESCE(credit_status, 'credited') = 'credited'
ORDER BY created_at ASC
LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dueConversionRow{}
	for rows.Next() {
		var b dueConversionRow
		if err := rows.Scan(&b.id, &b.tenantID, &b.referrerID, &b.refereeID, &b.createdAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// dueConversions finds conversions where:
//   - congrats_sent_at IS NULL
//   - fraud_score < 0.5 (don't celebrate likely fraud)
//   - the referrer's running count just crossed a milestone boundary
//
// We do the milestone diff in app code rather than SQL — the
// programs jsonb is awkward to JOIN against and there are only a
// few milestones per tenant. The bare scan is cross-tenant (worker
// scope, see scanDueConversions); everything below re-enters tenant
// scope per row via the Repo's db.WithTenant helpers.
func (s *CongratsSender) dueConversions(ctx context.Context) ([]pendingCongrats, error) {
	bareList, err := s.scanDueConversions(ctx)
	if err != nil {
		return nil, err
	}

	out := []pendingCongrats{}
	tenantPrograms := map[string]*Program{}
	for _, b := range bareList {
		prog, cached := tenantPrograms[b.tenantID]
		if !cached {
			p, perr := s.Repo.GetActiveProgram(ctx, b.tenantID)
			if perr == nil {
				prog = p
			}
			tenantPrograms[b.tenantID] = prog
		}
		if prog == nil {
			continue
		}
		count, cerr := s.Repo.CountReferrals(ctx, b.tenantID, b.referrerID)
		if cerr != nil {
			continue
		}
		// Which milestone did THIS conversion unlock? — the smallest
		// milestone where prev_count < m.count <= count.
		prevCount := count - 1
		var unlocked *Milestone
		for i := range prog.Milestones {
			m := prog.Milestones[i]
			if prevCount < m.Count && m.Count <= count {
				if unlocked == nil || m.Count < unlocked.Count {
					unlocked = &m
				}
			}
		}
		if unlocked == nil {
			_ = s.markSent(ctx, b.tenantID, b.id)
			continue
		}
		out = append(out, pendingCongrats{
			ConversionID:   b.id,
			TenantID:       b.tenantID,
			ReferrerID:     b.referrerID,
			RefereeID:      b.refereeID,
			NewCount:       count,
			MilestoneCount: unlocked.Count,
			UnlockedKind:   unlocked.RewardKind,
			UnlockedLabel:  unlocked.RewardLabel,
		})
	}
	return out, nil
}

func (s *CongratsSender) sendOne(ctx context.Context, p pendingCongrats) error {
	email := ""
	if s.Lookup != nil {
		if e, ok := s.Lookup.SubscriberEmail(ctx, p.TenantID, p.ReferrerID); ok {
			email = e
		}
	}
	if email == "" {
		// Without an email we can't send; mark sent so we don't churn.
		return s.markSent(ctx, p.TenantID, p.ConversionID)
	}
	if strings.TrimSpace(s.From) == "" {
		if s.Logger != nil {
			s.Logger.Warn("referrals congrats sender: from address not configured",
				"tenant", p.TenantID, "conversion", p.ConversionID)
		}
		return s.markSent(ctx, p.TenantID, p.ConversionID)
	}
	subj, plain, html := renderCongrats(p)
	if err := s.Mailer.Send(ctx, mailer.Message{
		From:     s.From,
		To:       email,
		Subject:  subj,
		Body:     plain,
		HTMLBody: html,
		Tags:     map[string]string{"purpose": "referral_congrats"},
	}); err != nil {
		return err
	}
	s.Events.emit(ctx, p.TenantID, EventReferralMilestoneUnlocked, map[string]any{
		"conversion_id": p.ConversionID,
		"referrer_id":   p.ReferrerID,
		"referee_id":    p.RefereeID,
		"count":         p.NewCount,
		"reward_kind":   p.UnlockedKind,
		"reward_label":  p.UnlockedLabel,
	})
	s.Events.emit(ctx, p.TenantID, EventReferralPayoutPending, map[string]any{
		"conversion_id": p.ConversionID,
		"referrer_id":   p.ReferrerID,
		"referee_id":    p.RefereeID,
		"reward_kind":   p.UnlockedKind,
		"reward_label":  p.UnlockedLabel,
	})
	return s.markSent(ctx, p.TenantID, p.ConversionID)
}

func (s *CongratsSender) markSent(ctx context.Context, tenantID, conversionID string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE referral_conversions SET congrats_sent_at = now() WHERE id::text = $1`,
		conversionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// renderCongrats produces (subject, plain, html). Kept tiny and
// deterministic so it's easy to unit-test.
func renderCongrats(p pendingCongrats) (string, string, string) {
	rewardName := p.UnlockedLabel
	if rewardName == "" {
		rewardName = "your reward"
	}
	subj := fmt.Sprintf("🎉 You unlocked %s", rewardName)
	plain := strings.Builder{}
	plain.WriteString(fmt.Sprintf("You referred %d friend%s — you've unlocked %s!\n\n",
		p.NewCount, plural(p.NewCount), rewardName))
	plain.WriteString("We'll follow up with the details. Thanks for sharing.\n")
	html := fmt.Sprintf(
		`<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;color:#14171f">`+
			`<h2 style="margin:0 0 8px 0">🎉 You unlocked %s</h2>`+
			`<p style="font-size:14px;color:#485160">You've referred <strong>%d</strong> friend%s — thanks for sharing.</p>`+
			`<p style="font-size:13px;color:#6b7280;margin-top:16px">We'll follow up with the details.</p>`+
			`</body></html>`,
		htmlEscapeRef(rewardName), p.NewCount, plural(p.NewCount),
	)
	return subj, plain.String(), html
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func htmlEscapeRef(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}
