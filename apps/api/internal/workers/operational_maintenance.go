// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit/ueba"
	"github.com/postwave/postwave/apps/api/internal/audit_alerts"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/exports"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/landingpages"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/scheduled_reports"
	"github.com/postwave/postwave/apps/api/internal/scoring"
	"github.com/postwave/postwave/apps/api/internal/subscriber_import"
)

type OperationalAssetStorage interface {
	subscriber_import.Storage
}

type OperationalMaintenanceCipher interface {
	auditsink.Cipher
	auditsink.Encrypter
}

type OperationalMaintenanceWorkerDeps struct {
	Pool                         *db.Pool
	Logger                       *slog.Logger
	Storage                      OperationalAssetStorage
	ExportStorage                exports.Storage
	ScheduledReportsMailer       scheduled_reports.MailSender
	AuditScheduleMailer          handlers.ScheduleMailSender
	AuditPublicBaseURL           string
	AuditAlertsSlack             audit_alerts.SlackNotifier
	Cipher                       OperationalMaintenanceCipher
	SubscriberImportVerification subscriber_import.ImportExecutionVerifier

	EnableScoring          bool
	EnableSubscriberImport bool
	EnablePredictive       bool
	EnableScheduledReports bool
	EnableAuditExport      bool
	EnableAuditAlerts      bool
	EnableAuditUEBA        bool
	EnableExports          bool
	EnableAuditSinks       bool
	// AuditSinkCircuitNotifier raises the operator alert when a sink's circuit
	// breaker opens (GOVERNANCE#48). Until it was wired, a breaker that stopped
	// shipping a tenant's audit trail was discoverable only by opening the
	// audit-sinks screen. nil keeps the historical silence.
	AuditSinkCircuitNotifier auditsink.CircuitNotifier
	EnableLandingScheduler   bool
}

type OperationalMaintenanceWorkersSurface struct {
	Scoring             *scoring.Worker
	SubscriberImport    *subscriber_import.Worker
	Predictive          *predictive.Repo
	ScheduledReports    *scheduled_reports.Worker
	AuditExport         *handlers.AuditExportWorker
	AuditExportSchedule *handlers.AuditExportScheduleWorker
	AuditAlerts         *audit_alerts.Worker
	AuditUEBA           *ueba.Worker
	Exports             *exports.Worker
	AuditSinkDelivery   *auditsink.Deps
	AuditSinkMerkle     *auditsink.MerkleWorker
	AuditSinkKeyRotator *auditsink.KeyRotator
	LandingScheduler    *landingpages.SchedulerWorker
}

func NewOperationalMaintenanceWorkersSurface(deps OperationalMaintenanceWorkerDeps) OperationalMaintenanceWorkersSurface {
	if deps.Pool == nil {
		return OperationalMaintenanceWorkersSurface{}
	}
	surface := OperationalMaintenanceWorkersSurface{}
	if deps.EnableScoring {
		surface.Scoring = &scoring.Worker{Pool: deps.Pool, Logger: deps.Logger, Interval: 15 * time.Minute}
	}
	if deps.EnableSubscriberImport {
		surface.SubscriberImport = &subscriber_import.Worker{
			Pool: deps.Pool, Storage: deps.Storage, Logger: deps.Logger,
			Verification: deps.SubscriberImportVerification, Interval: 5 * time.Second,
		}
	}
	if deps.EnablePredictive {
		surface.Predictive = &predictive.Repo{Pool: deps.Pool}
	}
	if deps.EnableScheduledReports && deps.ScheduledReportsMailer != nil {
		surface.ScheduledReports = &scheduled_reports.Worker{
			Pool: deps.Pool, Logger: deps.Logger, Interval: 60 * time.Second, Mailer: deps.ScheduledReportsMailer,
		}
	}
	if deps.EnableAuditExport {
		surface.AuditExport = handlers.NewAuditExportWorker(deps.Pool, deps.Logger)
		surface.AuditExportSchedule = &handlers.AuditExportScheduleWorker{
			Pool:          deps.Pool,
			Logger:        deps.Logger,
			Mailer:        deps.AuditScheduleMailer,
			Interval:      5 * time.Minute,
			PublicBaseURL: deps.AuditPublicBaseURL,
		}
	}
	if deps.EnableAuditAlerts {
		surface.AuditAlerts = &audit_alerts.Worker{
			Pool: deps.Pool, Logger: deps.Logger, Interval: 30 * time.Second, Slack: deps.AuditAlertsSlack,
		}
	}
	if deps.EnableAuditUEBA {
		surface.AuditUEBA = ueba.Default(deps.Pool, deps.Logger)
	}
	if deps.EnableExports && deps.ExportStorage != nil {
		surface.Exports = &exports.Worker{
			Pool: deps.Pool, Storage: deps.ExportStorage, Logger: deps.Logger, Interval: 10 * time.Second,
		}
	}
	if deps.EnableAuditSinks {
		surface.AuditSinkDelivery = auditsink.New(deps.Pool, deps.Cipher, deps.Logger)
		surface.AuditSinkDelivery.Encrypter = deps.Cipher
		surface.AuditSinkDelivery.CircuitNotifier = deps.AuditSinkCircuitNotifier
		surface.AuditSinkMerkle = &auditsink.MerkleWorker{
			Pool: deps.Pool, Logger: deps.Logger, Interval: 60 * time.Second,
		}
		surface.AuditSinkKeyRotator = &auditsink.KeyRotator{
			Deps: surface.AuditSinkDelivery, Logger: deps.Logger, Interval: 6 * time.Hour,
		}
	}
	// LAND-038: landing-page publish/auto-unpublish scheduler. Gated like its
	// siblings so a fully-disabled deps yields an empty surface; it needs no
	// external dependency, only the pool.
	if deps.EnableLandingScheduler {
		surface.LandingScheduler = &landingpages.SchedulerWorker{
			Pool: deps.Pool, Logger: deps.Logger, Interval: 60 * time.Second,
		}
	}
	return surface
}

func StartOperationalMaintenanceWorkers(ctx context.Context, deps OperationalMaintenanceWorkerDeps) OperationalMaintenanceWorkersSurface {
	surface := NewOperationalMaintenanceWorkersSurface(deps)
	if surface.Scoring != nil {
		safego.Go(deps.Logger, "scoring-worker", func() {
			if err := surface.Scoring.Run(ctx); err != nil {
				deps.Logger.Warn("scoring worker exited", "err", err.Error())
			}
		})
	}
	if surface.SubscriberImport != nil {
		safego.Go(deps.Logger, "subscriber-import-worker", func() {
			if err := surface.SubscriberImport.Run(ctx); err != nil {
				deps.Logger.Warn("subscriber import worker exited", "err", err.Error())
			}
		})
	}
	if surface.Predictive != nil {
		safego.Go(deps.Logger, "predictive-recompute-daily", func() {
			runPredictiveRecomputeWorker(ctx, deps.Pool, surface.Predictive, deps.Logger)
		})
	}
	if surface.ScheduledReports != nil {
		safego.Go(deps.Logger, "scheduled-reports-worker", func() {
			if err := surface.ScheduledReports.Run(ctx); err != nil {
				deps.Logger.Warn("scheduled_reports worker exited", "err", err.Error())
			}
		})
	}
	if surface.AuditExport != nil {
		safego.Go(deps.Logger, "audit-export-worker", func() {
			if err := surface.AuditExport.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("audit-export worker exited", "err", err.Error())
			}
		})
		safego.Go(deps.Logger, "audit-export-schedule-worker", func() {
			if err := surface.AuditExportSchedule.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("audit-export-schedule worker exited", "err", err.Error())
			}
		})
	}
	if surface.AuditAlerts != nil {
		safego.Go(deps.Logger, "audit-alerts-worker", func() {
			if err := surface.AuditAlerts.Run(ctx); err != nil {
				deps.Logger.Warn("audit_alerts worker exited", "err", err.Error())
			}
		})
	}
	if surface.AuditUEBA != nil {
		safego.Go(deps.Logger, "audit-ueba-worker", func() {
			if err := surface.AuditUEBA.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("audit ueba worker exited", "err", err.Error())
			}
		})
	}
	if surface.Exports != nil {
		safego.Go(deps.Logger, "exports-worker", func() {
			if err := surface.Exports.Run(ctx); err != nil {
				deps.Logger.Warn("exports worker exited", "err", err.Error())
			}
		})
	}
	if surface.AuditSinkDelivery != nil {
		background := context.Background()
		safego.Go(deps.Logger, "auditsink-delivery", func() {
			if err := surface.AuditSinkDelivery.Run(background, 5*time.Second); err != nil {
				deps.Logger.Warn("auditsink delivery worker exited", "err", err.Error())
			}
		})
		safego.Go(deps.Logger, "auditsink-merkle", func() {
			if err := surface.AuditSinkMerkle.Run(background); err != nil {
				deps.Logger.Warn("auditsink merkle worker exited", "err", err.Error())
			}
		})
		safego.Go(deps.Logger, "auditsink-key-rotator", func() {
			if err := surface.AuditSinkKeyRotator.Run(background); err != nil {
				deps.Logger.Warn("auditsink key rotator exited", "err", err.Error())
			}
		})
	}
	if surface.LandingScheduler != nil {
		safego.Go(deps.Logger, "landing-scheduler-worker", func() {
			if err := surface.LandingScheduler.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("landing scheduler worker exited", "err", err.Error())
			}
		})
	}
	return surface
}

// runPredictiveRecomputeWorker is the daily heuristic CLV/churn/RFM worker.
func runPredictiveRecomputeWorker(ctx context.Context, pool *db.Pool, repo *predictive.Repo, logger *slog.Logger) {
	if pool == nil || repo == nil {
		return
	}
	bootDelay := time.NewTimer(2 * time.Minute)
	defer bootDelay.Stop()
	select {
	case <-ctx.Done():
		return
	case <-bootDelay.C:
	}
	tick := func() {
		rows, err := pool.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
		if err != nil {
			logger.Warn("predictive recompute: tenant list failed", "err", err.Error())
			return
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				logger.Warn("predictive recompute: tenant scan failed", "err", err.Error())
				return
			}
			ids = append(ids, id)
		}
		rows.Close()
		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			result, err := repo.Recompute(ctx, id, 365)
			if err != nil {
				logger.Warn("predictive recompute failed", "tenant_id", id, "err", err.Error())
				continue
			}
			if result != nil && result.Predictions > 0 {
				logger.Info("predictive recompute ok", "tenant_id", id, "predictions", result.Predictions, "rfm_scores", result.RFMScores)
			}
		}
	}
	tick()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}
