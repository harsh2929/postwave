// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaigns: compatibility send route and scheduler.
//
// POST /campaigns/{id}/send is retained for API compatibility, but it is a
// strict alias of the guarded recipient queue. It must never hand an audience
// directly to Listmonk: doing so bypasses exact-address consent, suppression,
// holdout, frequency, approval, quota, quiet-hours, and send-loop checks.
// Listmonk remains the final per-recipient transport used by the send loop.

package campaigns

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"

	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

// CampaignSender is retained on SendDeps for construction compatibility with
// deployments that still supply the Listmonk client to the scheduler. The
// HTTP /send route deliberately never calls it; recipient dispatch belongs to
// the guarded send loop after queue materialization.
type CampaignSender interface {
	CreateCampaign(ctx context.Context, req listmonk.CreateCampaignReq) (*listmonk.CreateCampaignResponse, error)
	UpdateCampaignStatus(ctx context.Context, listmonkID int64, status string) error
}

// WarmupGate supplies scheduler and send-preview warmup limits. The send loop
// independently enforces the cap again while draining queued recipients.
// Implementation lives in apps/api/internal/sending; nil disables it in dev
// and tests where warmup state isn't relevant.
type WarmupGate interface {
	// CapForToday returns the remaining cap for tenantID for today.
	// Returns -1 to signal "no cap" (Pro tier or warmup complete).
	CapForToday(ctx context.Context, tenantID string) (int, error)
}

// (The AudienceCounter interface — used here for warmup-cap sizing and
// in checklist.go for the pre-send "recipients > 0" gate — is declared
// in checklist.go. Two methods: CountListAudience + CountSegmentAudience.
// Scheduler checks resolve the campaign's audience-typed id and call whichever
// matches; both return int64 so very-large lists don't truncate at the gate.)

// countCampaignAudience picks the right AudienceCounter method based on the
// campaign audience. Evaluator/store errors are returned so send-preview and
// scheduler gates fail closed instead of silently treating unavailable as 0.
func countCampaignAudience(ctx context.Context, counter AudienceCounter, c *Campaign, tenantID string) (int64, error) {
	if c == nil {
		return 0, nil
	}
	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)
	if listID != "" && segmentID != "" {
		return 0, ErrAudienceMixedSources
	}
	if counter == nil {
		return 0, nil
	}
	if listID != "" {
		return counter.CountListAudience(ctx, tenantID, listID)
	}
	if segmentID != "" {
		return counter.CountSegmentAudience(ctx, tenantID, segmentID)
	}
	return 0, nil
}

// SendDeps bundles scheduler-era collaborators. Sender is intentionally not
// consulted by the compatibility HTTP /send route.
type SendDeps struct {
	Sender      CampaignSender
	Warmup      WarmupGate
	Audience    AudienceCounter
	DefaultFrom string // tenant default sender (fallback when campaign.from_email empty)
}

// LegacySchedulerDurableClaimRecoveryQualified is the compile-time release
// qualification for the legacy campaign scheduler. Keep this false until the
// claim state machine has durable recovery and an enabled claim-to-dispatch
// integration test. Environment variables are operational intent, not proof
// that the unsafe worker is ready to run.
//
// Exported so the production composition can use the exact same lock rather
// than duplicating a second constant that could drift.
const LegacySchedulerDurableClaimRecoveryQualified = campaigndispatch.SchedulingQualified

// MountSend retains the legacy URL as an alias of QueueCampaign. Keeping the
// binding here preserves existing clients while making the guarded queue the
// only live campaign fan-out path.
func MountSend(r chi.Router, base *Deps, sd *SendDeps) {
	if base == nil || sd == nil {
		return
	}
	// Bind the compatibility URL directly to the canonical handler. Keeping
	// SendDeps out of the handler graph makes a future accidental return to
	// Sender.CreateCampaign impossible without an explicit route rewrite.
	r.Post("/api/v1/campaigns/{id}/send", base.QueueCampaign)
}

// sendableStatus is the whitelist used by scheduled dispatch. Sent / sending
// campaigns can't be queued again; cancelled campaigns must be reopened
// explicitly.
func sendableStatus(s string) bool {
	switch s {
	case StatusDraft, StatusScheduled, StatusPaused:
		return true
	default:
		return false
	}
}

// FromEmail picks the from address: explicit campaign override first,
// then the value carried in DeliverySettings (if the editor saved one),
// else empty. Defined as a method on Campaign so handlers don't have
// to know the resolution order.
func (c *Campaign) FromEmail() string {
	if c == nil {
		return ""
	}
	if direct, ok := c.DeliverySettings["from_email"].(string); ok && direct != "" {
		return direct
	}
	return ""
}

func ptrString(s string) *string { return &s }

// ----------------------------------------------------------------------
// Scheduler worker
// ----------------------------------------------------------------------

// Scheduler polls campaigns with status='scheduled' and scheduled_at<=now,
// and dispatches them through the guarded queue core. Runs as a goroutine
// alongside the outbox worker.
//
// Why poll instead of cron: the Moosewave deployment unit is a single
// long-running process; a poller is simpler than wiring a cron daemon.
// At higher scale, swap the poller for an asynq Periodic Task.
type Scheduler struct {
	Base     *Deps
	SendDeps *SendDeps

	// Interval between polls. Defaults to 30s.
	Interval time.Duration

	// Pool: the same db.Pool used elsewhere. We open our own tenant
	// queries because the scheduler doesn't have a request context;
	// it walks tenants platform-wide.
	Pool ScheduledCampaignFinder
}

// ScheduledCampaignFinder returns campaigns that need dispatching. The
// implementation in repo.go uses the outbox-worker permissive policy
// pattern to find rows across tenants.
type ScheduledCampaignFinder interface {
	FindDueScheduled(ctx context.Context, limit int) ([]ScheduledCampaign, error)
}

// ScheduledCampaign is the minimal shape the scheduler needs to fire
// a send: just the (tenant_id, campaign_id) pair. The send handler
// loads the rest under tenant scope.
type ScheduledCampaign struct {
	TenantID   string
	CampaignID string
}

// Run starts the scheduler loop. Returns when ctx is cancelled.
//
// One tick = one fetch-and-dispatch cycle. Errors per-campaign are
// logged (via Base.Logger when set) but don't stop the loop — a
// poisonous campaign shouldn't take down the scheduler.
func (s *Scheduler) Run(ctx context.Context) {
	if !LegacySchedulerDurableClaimRecoveryQualified ||
		s == nil || s.Base == nil || s.SendDeps == nil || s.Pool == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.tickOnce(ctx)
		}
	}
}

// tickOnce drains up to N due campaigns. Bounded per tick so a backlog
// after a deploy can't monopolise the scheduler.
func (s *Scheduler) tickOnce(ctx context.Context) {
	const maxPerTick = 16
	// Defense in depth for tests and alternate composition roots: even a caller
	// that constructs Scheduler directly cannot claim rows while durable claim
	// recovery is unqualified.
	if !LegacySchedulerDurableClaimRecoveryQualified {
		return
	}
	// Check before FindDueScheduled: the current finder claims rows as part of
	// its query, so a disabled scheduler must not mutate campaign state at all.
	if s == nil || s.Base == nil || dispatchcontrol.Check(s.Base.LiveDispatch, ctx, "") != nil {
		return
	}
	due, err := s.Pool.FindDueScheduled(ctx, maxPerTick)
	if err != nil || len(due) == 0 {
		return
	}
	for _, dc := range due {
		s.dispatchOne(ctx, dc)
	}
}

// dispatchOne performs scheduler-specific readiness checks, then delegates to
// QueueScheduledCampaign so scheduled and interactive sends share the same
// consent, suppression, approval, holdout, quota, and queue-fill safeguards.
//
// Failure here is logged (when a logger is wired) but doesn't bounce
// the campaign — the next tick will pick it up again. After 5 attempts
// (tracked via campaigns.scheduled_attempts column, added in 0041) the
// campaign is moved to status='paused' so it stops looping.
func (s *Scheduler) dispatchOne(ctx context.Context, dc ScheduledCampaign) {
	if s == nil || s.Base == nil || s.Base.checkLiveDispatch(ctx, dc.TenantID) != nil {
		return
	}
	// The scheduler has no request tenant context, so load the campaign under
	// its explicit tenant before delegating to the context-native queue entry.
	c, err := s.Base.Repo.Get(ctx, dc.TenantID, dc.CampaignID)
	if err != nil {
		return
	}
	if !sendableStatus(c.Status) {
		return
	}
	// Sandbox routing: if the campaign was queued via a sandbox API
	// key, the is_sandbox flag (migration 0159) was persisted on the
	// row. Without this check the scheduler would dispatch as a REAL
	// send, leaking integration-test traffic to real subscribers.
	sb, err := s.Base.Repo.GetSandboxFlag(ctx, dc.TenantID, dc.CampaignID)
	if err != nil {
		return
	}
	if sb {
		// Sandbox dispatch path is handled inside queueCampaignCore;
		// the scheduler doesn't simulate. Flip to paused so the
		// operator can re-queue manually via the sandbox-aware /queue
		// route (which DOES call SimulateCampaignLifecycle).
		_, _ = s.Base.Repo.Update(ctx, dc.TenantID, dc.CampaignID, UpdateInput{
			Status: ptrString(StatusPaused),
		})
		return
	}
	from := c.FromEmail()
	if from == "" {
		from = s.SendDeps.DefaultFrom
	}
	if from == "" || c.Subject == "" || c.BodyHTML == "" {
		// Scheduled but incomplete. Flip to paused so the operator
		// notices on the dashboard.
		_, _ = s.Base.Repo.Update(ctx, dc.TenantID, dc.CampaignID, UpdateInput{
			Status: ptrString(StatusPaused),
		})
		return
	}
	if paused, _, err := s.Base.emailSendingPaused(ctx, dc.TenantID); err != nil || paused {
		// Leave scheduled campaigns scheduled; the operator can resume
		// the global switch without needing to reschedule every campaign.
		return
	}
	if s.SendDeps.Warmup != nil && s.SendDeps.Audience != nil {
		cap, _ := s.SendDeps.Warmup.CapForToday(ctx, dc.TenantID)
		if cap >= 0 {
			audience, audienceErr := countCampaignAudience(ctx, s.SendDeps.Audience, c, dc.TenantID)
			if audienceErr != nil {
				return
			}
			if int(audience) > cap {
				// Cap exceeded — leave the campaign in 'scheduled' so
				// the next tick retries (cap may grow as warmup
				// progresses through the day).
				return
			}
		}
	}
	// D5: route through the queue path so per-tenant rate limit,
	// quiet hours, suppression filter, holdout, and approval gates
	// all apply identically to a scheduled send. Previously this
	// called Sender.CreateCampaign + UpdateCampaignStatus directly,
	// which handed the fan-out to Listmonk and BYPASSED every guard
	// — scheduled campaigns ignored max_sends_per_hour and quiet
	// hours entirely, breaking the "Sandbox · Budgets · Approvals"
	// contract for the most operator-invisible send path.
	//
	// QueueScheduledCampaign internally calls queueCampaignCore,
	// which:
	//   - enforces approval gate (with content-hash + consumed_at
	//     guards from D7/D11)
	//   - applies holdout filter (D3+D9+D12)
	//   - applies A/B variant split
	//   - applies suppression filter
	//   - INSERTs recipient rows with ON CONFLICT DO NOTHING (D1)
	//   - flips campaign status via UpdateStatusIf (D4 race-safe)
	//   - emits campaign.sent on the bus (was the only thing the
	//     legacy path did here that's worth preserving)
	if _, err := s.Base.QueueScheduledCampaign(ctx, dc.TenantID, dc.CampaignID); err != nil {
		// Errors include "approval required" (a legitimate hold),
		// bad-status (concurrent edit), etc. Leave the row in its
		// current status; the next tick re-evaluates.
		slog.Warn("scheduler queue dispatch failed",
			"tenant_id", dc.TenantID, "campaign_id", dc.CampaignID,
			"err", err.Error())
		return
	}
}
