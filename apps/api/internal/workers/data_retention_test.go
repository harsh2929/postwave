// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/accountdeletion"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/partition_rotator"
	"github.com/postwave/postwave/apps/api/internal/retention"
	"github.com/postwave/postwave/apps/api/internal/settings"
)

type retentionMailerStub struct{}

func (*retentionMailerStub) Send(context.Context, mailer.Message) error { return nil }

type retentionTagHistoryStub struct{}

func (*retentionTagHistoryStub) EmitErasureRedaction(context.Context, pgx.Tx, string, string) error {
	return nil
}

func TestDataRetentionSurfacePreservesDependenciesOrderAndConfiguration(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sweeper := &retention.Sweeper{Logger: logger}
	partitionWorker := &partition_rotator.Worker{Pool: pool, Logger: logger}
	tagHistory := &retentionTagHistoryStub{}
	accountMailer := &retentionMailerStub{}
	env := map[string]string{
		"POSTWAVE_AUDIT_TRIM_INTERVAL_SECONDS":            "7",
		"POSTWAVE_AUDIT_TRIM_BATCH_SIZE":                  "13",
		"POSTWAVE_PARTITION_ROTATOR_INTERVAL_SECONDS":     "11",
		"POSTWAVE_RAW_PAYLOAD_RETENTION_INTERVAL_SECONDS": "17",
	}
	surface := NewDataRetentionWorkersSurface(DataRetentionWorkerDeps{
		Pool:                  pool,
		Logger:                logger,
		RetentionSweeper:      sweeper,
		PartitionRotator:      partitionWorker,
		PrivacyTagHistory:     tagHistory,
		AccountDeletionMailer: accountMailer,
		AccountDeletionFrom:   "privacy@example.test",
		Getenv:                func(key string) string { return env[key] },
	})

	if surface.AuditTrimmer == nil || surface.AuditTrimmer.Pool != pool || surface.AuditTrimmer.Logger != logger ||
		surface.AuditTrimmer.Interval != 7*time.Second || surface.AuditTrimmer.BatchSize != 13 {
		t.Fatal("audit trimmer changed its dependency graph or environment overrides")
	}
	privacyRepo, ok := surface.AuditTrimmer.Privacy.(*settings.PrivacyRepo)
	if !ok || privacyRepo.Pool != pool {
		t.Fatal("audit trimmer changed privacy-repository pool identity")
	}
	if surface.PartitionRotator != partitionWorker || surface.PartitionRotator.Pool != pool || surface.PartitionRotator.Logger != logger ||
		surface.PartitionRotator.Interval != 11*time.Second {
		t.Fatal("partition rotator changed its dependency graph or environment override")
	}
	if surface.RetentionSweeper != sweeper || sweeper.Interval != 17*time.Second {
		t.Fatal("shared retention sweeper identity or historical interval override changed")
	}
	if surface.PrivacyOverdue == nil || surface.PrivacyOverdue.Pool != pool || surface.PrivacyOverdue.Logger != logger ||
		surface.PrivacyOverdue.Interval != 5*time.Minute {
		t.Fatal("privacy overdue worker changed its dependency graph or interval")
	}
	if surface.PrivacyIncidentClock == nil || surface.PrivacyIncidentClock.Pool != pool || surface.PrivacyIncidentClock.Logger != logger ||
		surface.PrivacyIncidentClock.Interval != 5*time.Minute {
		t.Fatal("privacy incident clock changed its dependency graph or interval")
	}
	if surface.PrivacyDeletion == nil || surface.PrivacyDeletion.Pool != pool || surface.PrivacyDeletion.Logger != logger ||
		surface.PrivacyDeletion.Interval != time.Minute || surface.PrivacyDeletion.TagHistory != tagHistory {
		t.Fatal("privacy deletion worker changed its dependency graph or interval")
	}
	if surface.AccountDeletion == nil || surface.AccountDeletion.Pool != pool || surface.AccountDeletion.Logger != logger ||
		surface.AccountDeletion.Interval != time.Minute {
		t.Fatal("account deletion worker changed its dependency graph or interval")
	}
	notifier, ok := surface.AccountDeletion.Notifier.(*accountdeletion.EmailNotifier)
	if !ok || notifier.Mailer != accountMailer || notifier.From != "privacy@example.test" {
		t.Fatal("account deletion notifier changed its mailer identity or sender")
	}
}

func TestDataRetentionSurfacePreservesDefaultsAndStructuralNilBehavior(t *testing.T) {
	t.Parallel()

	if got := NewDataRetentionWorkersSurface(DataRetentionWorkerDeps{}); got != (DataRetentionWorkersSurface{}) {
		t.Fatal("nil pool returned a partial data-retention surface")
	}
	pool := &db.Pool{}
	for name, getenv := range map[string]func(string) string{
		"empty":    func(string) string { return "" },
		"invalid":  func(string) string { return "not-an-integer" },
		"zero":     func(string) string { return "0" },
		"negative": func(string) string { return "-9" },
	} {
		t.Run(name, func(t *testing.T) {
			surface := NewDataRetentionWorkersSurface(DataRetentionWorkerDeps{Pool: pool, Getenv: getenv})
			if surface.AuditTrimmer.Interval != audit.DefaultInterval || surface.AuditTrimmer.BatchSize != audit.DefaultBatchSize {
				t.Fatal("audit trimmer defaults changed")
			}
			if surface.PartitionRotator.Interval != partition_rotator.DefaultInterval {
				t.Fatal("partition rotator default changed")
			}
			if surface.RetentionSweeper != nil {
				t.Fatal("nil shared retention sweeper was replaced")
			}
		})
	}
}

func TestDataRetentionLaunchOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	workerBytes, err := os.ReadFile("data_retention.go")
	if err != nil {
		t.Fatalf("read data_retention.go: %v", err)
	}
	assertOperationalSourceOrder(t, string(workerBytes), []string{
		`"audit-trimmer"`,
		`"partition-rotator"`,
		`"retention-sweeper"`,
		`"privacy-overdue-worker"`,
		`"privacy-incident-clock-worker"`,
		`"privacy-deletion-worker"`,
		`"self-account-deletion-worker"`,
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOperationalSourceOrder(t, mainSource, []string{
		"sendGuard.SendCompleteNotifier =",
		"apiworkers.StartDataRetentionWorkers(outboxCtx,",
		"apiworkers.StartOperationalMaintenanceWorkers(outboxCtx,",
	})
	for _, forbidden := range []string{
		"auditTrimmer :=",
		"partitionRotator :=",
		"rawRetentionInterval :=",
		"privacyOverdueWorker :=",
		"privacyIncidentClockWorker :=",
		"privacyDeletionWorker :=",
		"accountDeletionWorker :=",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated data-retention composition %q", forbidden)
		}
	}
}
