// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/accountdeletion"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/partition_rotator"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/retention"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/settings"
)

type DataRetentionWorkerDeps struct {
	Pool                  *db.Pool
	Logger                *slog.Logger
	RetentionSweeper      *retention.Sweeper
	PartitionRotator      *partition_rotator.Worker
	PrivacyTagHistory     privacy.TagHistoryRedactor
	AccountDeletionMailer mailer.Mailer
	AccountDeletionFrom   string
	Getenv                func(string) string
}

type DataRetentionWorkersSurface struct {
	AuditTrimmer         *audit.Trimmer
	PartitionRotator     *partition_rotator.Worker
	RetentionSweeper     *retention.Sweeper
	PrivacyOverdue       *privacy.OverdueWorker
	PrivacyIncidentClock *privacy.IncidentClockWorker
	PrivacyDeletion      *privacy.DeletionFulfillmentWorker
	AccountDeletion      *accountdeletion.Worker
}

func NewDataRetentionWorkersSurface(deps DataRetentionWorkerDeps) DataRetentionWorkersSurface {
	if deps.Pool == nil {
		return DataRetentionWorkersSurface{}
	}
	getenv := deps.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	auditTrimInterval := positiveDurationSeconds(getenv("POSTWAVE_AUDIT_TRIM_INTERVAL_SECONDS"), 24*time.Hour)
	auditTrimBatch := positiveInt(getenv("POSTWAVE_AUDIT_TRIM_BATCH_SIZE"), audit.DefaultBatchSize)
	partitionInterval := positiveDurationSeconds(
		getenv("POSTWAVE_PARTITION_ROTATOR_INTERVAL_SECONDS"),
		partition_rotator.DefaultInterval,
	)
	retentionInterval := positiveDurationSeconds(
		getenv("POSTWAVE_RAW_PAYLOAD_RETENTION_INTERVAL_SECONDS"),
		24*time.Hour,
	)

	partitionWorker := deps.PartitionRotator
	if partitionWorker == nil {
		partitionWorker = &partition_rotator.Worker{Pool: deps.Pool, Logger: deps.Logger}
	}
	partitionWorker.Interval = partitionInterval
	surface := DataRetentionWorkersSurface{
		AuditTrimmer: &audit.Trimmer{
			Pool:      deps.Pool,
			Privacy:   &settings.PrivacyRepo{Pool: deps.Pool},
			Interval:  auditTrimInterval,
			BatchSize: auditTrimBatch,
			Logger:    deps.Logger,
		},
		PartitionRotator: partitionWorker,
		RetentionSweeper: deps.RetentionSweeper,
		PrivacyOverdue: &privacy.OverdueWorker{
			Pool: deps.Pool, Interval: 5 * time.Minute, Logger: deps.Logger,
		},
		PrivacyIncidentClock: &privacy.IncidentClockWorker{
			Pool: deps.Pool, Interval: 5 * time.Minute, Logger: deps.Logger,
		},
		PrivacyDeletion: &privacy.DeletionFulfillmentWorker{
			Pool: deps.Pool, Interval: time.Minute, Logger: deps.Logger, TagHistory: deps.PrivacyTagHistory,
		},
		AccountDeletion: &accountdeletion.Worker{
			Pool: deps.Pool, Interval: time.Minute, Logger: deps.Logger,
			Notifier: &accountdeletion.EmailNotifier{
				Mailer: deps.AccountDeletionMailer,
				From:   deps.AccountDeletionFrom,
			},
		},
	}
	if surface.RetentionSweeper != nil {
		surface.RetentionSweeper.Interval = retentionInterval
	}
	return surface
}

func StartDataRetentionWorkers(ctx context.Context, deps DataRetentionWorkerDeps) DataRetentionWorkersSurface {
	surface := NewDataRetentionWorkersSurface(deps)
	if surface.AuditTrimmer != nil {
		safego.Go(deps.Logger, "audit-trimmer", func() { surface.AuditTrimmer.Run(ctx) })
	}
	if surface.PartitionRotator != nil {
		safego.Go(deps.Logger, "partition-rotator", func() { surface.PartitionRotator.Run(ctx) })
	}
	if surface.RetentionSweeper != nil {
		safego.Go(deps.Logger, "retention-sweeper", func() { surface.RetentionSweeper.Run(ctx) })
	}
	if surface.PrivacyOverdue != nil {
		safego.Go(deps.Logger, "privacy-overdue-worker", func() { surface.PrivacyOverdue.Run(ctx) })
	}
	if surface.PrivacyIncidentClock != nil {
		safego.Go(deps.Logger, "privacy-incident-clock-worker", func() { surface.PrivacyIncidentClock.Run(ctx) })
	}
	if surface.PrivacyDeletion != nil {
		safego.Go(deps.Logger, "privacy-deletion-worker", func() { surface.PrivacyDeletion.Run(ctx) })
	}
	if surface.AccountDeletion != nil {
		safego.Go(deps.Logger, "self-account-deletion-worker", func() { surface.AccountDeletion.Run(ctx) })
	}
	return surface
}

func positiveDurationSeconds(raw string, fallback time.Duration) time.Duration {
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func positiveInt(raw string, fallback int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
