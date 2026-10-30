// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/checks"
	"github.com/postwave/postwave/apps/api/internal/ops/views"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/readiness"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
)

// mountOpsRoutes keeps the privileged surface's middleware order and complete
// route inventory in one reviewable place. The distributed limiter runs
// before authentication to bound expensive operator/database reads, then the
// session+TOTP+IP gate and explicit write-CSRF gate fail closed.
func mountOpsRoutes(
	router chi.Router,
	appPool, opsPool *db.Pool,
	session ops.SessionResolver,
	store *ops.Store,
	audit ops.AuditSink,
	executor *ops.ActionExecutor,
	reader *views.Reader,
	readiness http.HandlerFunc,
	rateStore middleware.FixedWindowStore,
	trustForwardedIPHeaders bool,
) {
	rateOptions := middleware.RateLimitOptions{
		TrustForwardedIPHeaders: trustForwardedIPHeaders,
		Store:                   rateStore,
		Namespace:               "ops-console",
	}
	rateLimit := middleware.NewRateLimitWithOptions(300, time.Minute, rateOptions)
	incidents := &views.IncidentRepo{Pool: opsPool}
	operator := func(ctx context.Context) string {
		if value, ok := ops.OperatorFromContext(ctx); ok {
			return value.Email
		}
		return ""
	}

	router.Route("/api/internal/ops", func(r chi.Router) {
		r.Use(opsNoStoreHeaders)
		r.Use(rateLimit.Middleware)
		r.Use(ops.RequirePlatformOperator(opsPool, session))
		r.Use(ops.RequireWriteCSRF)
		r.Get("/board", ops.BoardHandler(store))
		r.Get("/checks/{id}", ops.CheckDetailHandler(store))
		r.Post("/checks/{id}/action", executor.Handler())
		r.Post("/checks/{id}/snooze", ops.SnoozeHandler(store, audit))
		r.Get("/readiness", readiness)
		r.Route("/views", func(r chi.Router) {
			r.Get("/tenants", views.TenantsHandler(reader))
			r.Get("/send/queue-depth", views.QueueDepthHandler(reader))
			r.Get("/send/dead-letters", views.DeadLettersHandler(reader))
			r.Get("/deliverability/by-tenant", views.DeliverabilityHandler(reader))
			r.Get("/billing/by-tenant", views.BillingHandler(reader))
			r.Get("/campaign-assurance/runs", views.CampaignAssuranceRunsHandler(reader))
			r.Get("/campaign-assurance/runs/{id}", views.CampaignAssuranceRunDetailHandler(reader))
			r.Get("/campaign-assurance/runs/{id}/timeline", views.CampaignAssuranceRunTimelineHandler(reader))
			r.Post("/tenants/{id}/kill-switch", views.KillSwitchHandler(
				views.KillSwitchFunc(func(ctx context.Context, tenantID string, paused bool, reason, actor string) error {
					_, err := (&tenantcontrols.Repo{Pool: appPool}).SetEmailSendingPaused(ctx, tenantID, paused, reason, actor)
					return err
				}),
				views.ActionAudit(audit), operator,
			))
			r.Get("/incidents", views.IncidentsHandler(reader))
			r.Get("/incidents/{id}", views.IncidentTimelineHandler(reader))
			r.Post("/incidents", views.OpenIncidentHandler(incidents, views.ActionAudit(audit), operator))
			r.Post("/incidents/{id}/updates", views.AppendUpdateHandler(incidents, views.ActionAudit(audit), operator))
		})
	})
}

func opsNoStoreHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func opsAlertChannels(logger *slog.Logger, alertMailer mailer.Mailer) []ops.Channel {
	var channels []ops.Channel
	if url := strings.TrimSpace(os.Getenv("OPS_SLACK_WEBHOOK_URL")); url != "" {
		channels = append(channels, ops.NewSlackWebhookChannel(url, &http.Client{Timeout: 10 * time.Second}))
	}
	if to := strings.TrimSpace(os.Getenv("OPS_ALERT_EMAIL")); to != "" {
		from := strings.TrimSpace(os.Getenv("POSTWAVE_REPORT_FROM_EMAIL"))
		if from == "" {
			from = strings.TrimSpace(os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"))
		}
		channels = append(channels, ops.NewEmailChannel(&opsAlertMailerAdapter{Mailer: alertMailer, From: from}, to))
	}
	if len(channels) == 0 && isProductionEnv() {
		logger.Error("ops push has no channels configured — alerts will not reach anyone; the push canary will go red")
	}
	return channels
}

func opsDigestSchedule(logger *slog.Logger) (int, *time.Location) {
	hour := 8
	if raw := strings.TrimSpace(os.Getenv("OPS_DIGEST_HOUR")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err == nil && parsed >= 0 && parsed <= 23 {
			hour = parsed
		} else {
			logger.Warn("OPS_DIGEST_HOUR is not an hour (0-23); using default", "value", raw, "default", 8)
		}
	}
	location := time.UTC
	if raw := strings.TrimSpace(os.Getenv("OPS_TZ")); raw != "" {
		parsed, err := time.LoadLocation(raw)
		if err == nil {
			location = parsed
		} else {
			logger.Warn("OPS_TZ is not a loadable IANA zone; using UTC", "value", raw, "err", err)
		}
	}
	return hour, location
}

// startOpsConsoleWorkersDeps carries the dependencies startOpsConsoleWorkers needs.
type startOpsConsoleWorkersDeps struct {
	logger       *slog.Logger
	authMailer   mailer.Mailer
	opsPool      *db.Pool
	opsFleet     *ops.Fleet
	opsStore     *ops.Store
	cfg          config.Config
	opsEnv       *ops.Env
	outboxWorker *outbox.Worker
	outboxCtx    context.Context
}

// startOpsConsoleWorkers binds the ops push canary, worker fleet, manual
// ticks and launch-readiness probes, validates the check registry, and starts
// the reconciler and push/digest tickers. Moved verbatim from run().
func startOpsConsoleWorkers(d startOpsConsoleWorkersDeps) error {
	logger := d.logger
	authMailer := d.authMailer
	opsPool := d.opsPool
	opsFleet := d.opsFleet
	opsStore := d.opsStore
	cfg := d.cfg
	opsEnv := d.opsEnv
	outboxWorker := d.outboxWorker
	outboxCtx := d.outboxCtx
	opsChannels := opsAlertChannels(logger, authMailer)

	opsPushState := ops.NewPushStateStore(opsPool)

	// Registered BEFORE the reconciler worker starts (below), so the
	// canary is in the registry for the reconciler's boot-time first
	// evaluation pass rather than the tick 60s later.
	checks.BindPushCanaryProbe(opsChannels, opsPushState)

	// The canary's button: one message through the SAME channel slice the
	// pusher and the digester use, on demand. Bound here because that
	// slice only exists here. BindAction panics on an unregistered check,
	// so it must follow RegisterPushCanary — the panic is the point: a
	// button whose runner never got bound would 404 at the worst possible
	// moment.
	ops.BindAction("ops.push-canary", checks.SendTestPushRunner(opsChannels))

	// The worker-fleet check, like the push canary, needs a runtime handle
	// (the Fleet installed as safego's observer at boot) that no init()
	// closure can hold.
	checks.BindWorkerFleetProbe(opsFleet)

	// Every manual chore's "Mark done" button. Bound from the chore list
	// itself rather than a second hand-written list of ids, so a chore
	// added to chores.go can never ship with a dead button.
	checks.BindManualTicks(opsStore)

	// The production readiness report, on the board. It has been served at
	// /api/internal/ops/readiness behind this same gate since the console
	// was built with nothing reading it; the console's Launch page renders
	// the detail, and this row is what makes a failing required gate show
	// up without anyone thinking to look.
	checks.BindLaunchReadinessProbe(func(context.Context) (checks.LaunchReadiness, error) {
		report := readiness.Evaluate(cfg, os.Getenv)
		out := checks.LaunchReadiness{Status: report.Status, Environment: report.Environment}
		for _, group := range report.Groups {
			for _, check := range group.Checks {
				out.Total++
				if check.Status != "fail" {
					continue
				}
				out.Failing++
				if check.Severity == "required" {
					out.Blocking++
				}
			}
		}
		return out, nil
	})

	// Whole-registry invariants Register cannot see from one check: every
	// check must name a DECLARED domain, or that surface silently drops
	// out of the coverage arithmetic while the check itself keeps working.
	// Fail the boot rather than serve a board whose denominator is wrong.
	if err := ops.ValidateRegistry(); err != nil {
		return fmt.Errorf("ops check registry: %w", err)
	}

	opsDigestHour, opsTZ := opsDigestSchedule(logger)

	opsPusher := &ops.Pusher{
		Store: opsStore, State: opsPushState, Channels: opsChannels, Logger: logger,
	}
	opsDigester := &ops.Digester{
		Store: opsStore, State: opsPushState, Channels: opsChannels,
		Hour: opsDigestHour, TZ: opsTZ, Logger: logger,
	}

	opsReconciler := &ops.Reconciler{
		Store: opsStore, Env: opsEnv, Logger: logger,
		Heartbeat: opsStore.NewHeartbeat(checks.HeartbeatReconciler, 2*time.Minute),
	}

	// The outbox drain reports for itself. Assigned here rather than at
	// construction because the ops store does not exist until this block;
	// the worker starts long before and simply runs with a nil Heartbeat
	// until this lands, which is a no-op rather than a panic.
	outboxWorker.SetHeartbeat(opsStore.NewHeartbeat(checks.HeartbeatOutboxWorker, 2*time.Minute))
	safego.Go(logger, "ops-reconciler", func() { opsReconciler.Run(outboxCtx) })
	safego.Go(logger, "ops-push", func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			opsPusher.Tick(outboxCtx)
			opsDigester.Tick(outboxCtx)
			select {
			case <-outboxCtx.Done():
				return
			case <-t.C:
			}
		}
	})

	return nil
}

// newOpsAuditSink adapts the canonical audit_log insert for the
// platform-operator lane. Moved verbatim from run().
func newOpsAuditSink(opsPool *db.Pool) ops.AuditSink {
	opsAuditSink := ops.AuditSink(func(ctx context.Context, event string, fields map[string]any) error {
		operatorEmail := ""
		if op, ok := ops.OperatorFromContext(ctx); ok {
			operatorEmail = op.Email
		}
		metadata, err := json.Marshal(fields)
		if err != nil {
			return fmt.Errorf("ops audit sink: marshal fields: %w", err)
		}
		_, err = opsPool.Exec(ctx, `
				INSERT INTO audit_log (tenant_id, action, metadata, actor_type, actor_label, event_id)
				VALUES (NULL, $1, $2::jsonb, 'platform_operator', NULLIF($3, ''), gen_random_uuid())`,
			event, metadata, operatorEmail)
		return err
	})

	return opsAuditSink
}

// buildOpsStoreAndEnv builds the ops store and probe environment. Moved
// verbatim from run().
func buildOpsStoreAndEnv(opsPool *db.Pool) (*ops.Store, *ops.Env) {
	opsStore := ops.NewStore(opsPool)
	opsEnv := &ops.Env{Pool: opsPool, HTTP: &http.Client{Timeout: 10 * time.Second}}

	// The ops AuditSink: the canonical audit_log insert (db.Audit's
	// column shape) adapted for the platform-operator lane that
	// migration 1703 opened — tenant_id NULL (RLS keeps these rows out
	// of every tenant's view), actor_type 'platform_operator', actor
	// label = the operator email RequirePlatformOperator authenticated.
	// It writes through the OPS pool: postwave_ops holds INSERT-only on
	// audit_log plus a policy that admits exactly this row shape, so a
	// compromised console can append its own trail but never read or
	// forge tenant rows.

	return opsStore, opsEnv
}

// newOpsSessionResolver projects the cookie session onto the operator gate.
// Moved verbatim from run().
func newOpsSessionResolver(authResolver *auth.Resolver) ops.SessionResolver {
	devOperatorEmail := strings.TrimSpace(os.Getenv("POSTWAVE_DEV_OPS_OPERATOR_EMAIL"))
	opsSessionResolver := ops.SessionResolver(func(r *http.Request) (ops.OperatorSession, bool) {
		if devOperatorEmail != "" {
			return ops.OperatorSession{Email: devOperatorEmail, TOTPVerified: true}, true
		}
		resolved, err := authResolver.ResolveSession(r)
		if err != nil || resolved == nil {
			return ops.OperatorSession{}, false
		}
		return ops.OperatorSession{
			Email:        resolved.UserEmail,
			TOTPVerified: resolved.MFAOK,
		}, true
	})

	return opsSessionResolver
}
