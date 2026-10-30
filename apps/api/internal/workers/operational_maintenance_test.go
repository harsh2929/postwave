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

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/subscriber_import"
)

type operationalStorageStub struct{}

func (*operationalStorageStub) Put(context.Context, string, string, []byte) (string, error) {
	return "", nil
}

func (*operationalStorageStub) Open(context.Context, string) (io.ReadCloser, string, error) {
	return io.NopCloser(strings.NewReader("")), "", nil
}

func (*operationalStorageStub) Delete(context.Context, string) error { return nil }

type operationalExportStorageStub struct{}

func (*operationalExportStorageStub) Put(context.Context, string, string, io.Reader, int64, string) error {
	return nil
}

func (*operationalExportStorageStub) Open(context.Context, string) (io.ReadCloser, string, int64, string, error) {
	return io.NopCloser(strings.NewReader("")), "application/zip", 0, "", nil
}

func (*operationalExportStorageStub) Stat(context.Context, string) (string, int64, string, error) {
	return "application/zip", 0, "", nil
}

func (*operationalExportStorageStub) Delete(context.Context, string) error { return nil }

type operationalCipherStub struct{}

func (*operationalCipherStub) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	return plaintext, nil
}

func (*operationalCipherStub) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	return blob, nil
}

type operationalMailerStub struct{}

func (*operationalMailerStub) Send(context.Context, string, string, string) error { return nil }

type operationalSlackStub struct{}

func (*operationalSlackStub) Fire(context.Context, pgx.Tx, string, string, any) (int, error) {
	return 0, nil
}

type operationalImportVerificationStub struct{}

func (*operationalImportVerificationStub) CurrentImportVerificationMode(context.Context, string) (string, error) {
	return subscriber_import.ImportVerificationModeOff, nil
}
func (*operationalImportVerificationStub) EnsureImportVerification(context.Context, string, string, string, []string) (subscriber_import.ImportVerificationRun, error) {
	return subscriber_import.ImportVerificationRun{}, nil
}
func (*operationalImportVerificationStub) GetImportVerification(context.Context, string, string, string, string) (subscriber_import.ImportVerificationRun, error) {
	return subscriber_import.ImportVerificationRun{}, nil
}
func (*operationalImportVerificationStub) ActivateImportVerification(context.Context, string, string, string, string) error {
	return nil
}
func (*operationalImportVerificationStub) CancelImportVerification(context.Context, string, string) error {
	return nil
}

func TestOperationalMaintenanceSurfacePreservesDependenciesAndDefaults(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	storage := &operationalStorageStub{}
	exportStorage := &operationalExportStorageStub{}
	cipher := &operationalCipherStub{}
	reportsMailer := &operationalMailerStub{}
	auditMailer := &operationalMailerStub{}
	slack := &operationalSlackStub{}
	importVerification := &operationalImportVerificationStub{}
	deps := OperationalMaintenanceWorkerDeps{
		Pool:                         pool,
		Logger:                       logger,
		Storage:                      storage,
		ExportStorage:                exportStorage,
		ScheduledReportsMailer:       reportsMailer,
		AuditScheduleMailer:          auditMailer,
		AuditPublicBaseURL:           "https://api.example.test",
		AuditAlertsSlack:             slack,
		Cipher:                       cipher,
		SubscriberImportVerification: importVerification,
		EnableScoring:                true,
		EnableSubscriberImport:       true,
		EnablePredictive:             true,
		EnableScheduledReports:       true,
		EnableAuditExport:            true,
		EnableAuditAlerts:            true,
		EnableAuditUEBA:              true,
		EnableExports:                true,
		EnableAuditSinks:             true,
	}
	surface := NewOperationalMaintenanceWorkersSurface(deps)

	if surface.Scoring == nil || surface.Scoring.Pool != pool || surface.Scoring.Logger != logger || surface.Scoring.Interval != 15*time.Minute {
		t.Fatal("scoring worker changed its dependency graph or interval")
	}
	if surface.SubscriberImport == nil || surface.SubscriberImport.Pool != pool || surface.SubscriberImport.Storage != storage ||
		surface.SubscriberImport.Logger != logger || surface.SubscriberImport.Interval != 5*time.Second ||
		surface.SubscriberImport.Verification != importVerification {
		t.Fatal("subscriber-import worker changed its dependency graph or interval")
	}
	if surface.Predictive == nil || surface.Predictive.Pool != pool {
		t.Fatal("predictive repository changed pool identity")
	}
	if surface.ScheduledReports == nil || surface.ScheduledReports.Pool != pool || surface.ScheduledReports.Logger != logger ||
		surface.ScheduledReports.Mailer != reportsMailer || surface.ScheduledReports.Interval != 60*time.Second {
		t.Fatal("scheduled-reports worker changed its dependency graph or interval")
	}
	if surface.AuditExport == nil || surface.AuditExport.Pool != pool || surface.AuditExport.Logger != logger || surface.AuditExport.Interval != 10*time.Second {
		t.Fatal("audit-export worker changed its dependency graph or interval")
	}
	if surface.AuditExportSchedule == nil || surface.AuditExportSchedule.Pool != pool || surface.AuditExportSchedule.Logger != logger ||
		surface.AuditExportSchedule.Mailer != auditMailer || surface.AuditExportSchedule.Interval != 5*time.Minute ||
		surface.AuditExportSchedule.PublicBaseURL != deps.AuditPublicBaseURL {
		t.Fatal("audit-export schedule worker changed its dependency graph or defaults")
	}
	if surface.AuditAlerts == nil || surface.AuditAlerts.Pool != pool || surface.AuditAlerts.Logger != logger ||
		surface.AuditAlerts.Slack != slack || surface.AuditAlerts.Interval != 30*time.Second {
		t.Fatal("audit-alerts worker changed its dependency graph or interval")
	}
	if surface.AuditUEBA == nil || surface.AuditUEBA.Pool != pool || surface.AuditUEBA.Logger != logger {
		t.Fatal("audit UEBA worker changed its dependency graph")
	}
	if surface.Exports == nil || surface.Exports.Pool != pool || surface.Exports.Storage != exportStorage ||
		surface.Exports.Logger != logger || surface.Exports.Interval != 10*time.Second {
		t.Fatal("exports worker changed its dependency graph or interval")
	}
	if surface.AuditSinkDelivery == nil || surface.AuditSinkDelivery.Pool != pool || surface.AuditSinkDelivery.Cipher != cipher ||
		surface.AuditSinkDelivery.Encrypter != cipher || surface.AuditSinkDelivery.Logger != logger || surface.AuditSinkDelivery.HTTP == nil {
		t.Fatal("audit-sink delivery changed its dependency graph")
	}
	if surface.AuditSinkMerkle == nil || surface.AuditSinkMerkle.Pool != pool || surface.AuditSinkMerkle.Logger != logger ||
		surface.AuditSinkMerkle.Interval != 60*time.Second {
		t.Fatal("audit-sink Merkle worker changed its dependency graph or interval")
	}
	if surface.AuditSinkKeyRotator == nil || surface.AuditSinkKeyRotator.Deps != surface.AuditSinkDelivery ||
		surface.AuditSinkKeyRotator.Logger != logger || surface.AuditSinkKeyRotator.Interval != 6*time.Hour {
		t.Fatal("audit-sink key rotator changed its dependency graph or interval")
	}
}

func TestOperationalMaintenanceSurfaceHonorsStructuralAndFeatureGates(t *testing.T) {
	t.Parallel()

	if got := NewOperationalMaintenanceWorkersSurface(OperationalMaintenanceWorkerDeps{}); got != (OperationalMaintenanceWorkersSurface{}) {
		t.Fatal("nil pool returned a partial operational worker surface")
	}
	pool := &db.Pool{}
	if got := NewOperationalMaintenanceWorkersSurface(OperationalMaintenanceWorkerDeps{Pool: pool}); got != (OperationalMaintenanceWorkersSurface{}) {
		t.Fatal("disabled feature gates returned operational workers")
	}
	surface := NewOperationalMaintenanceWorkersSurface(OperationalMaintenanceWorkerDeps{
		Pool:                   pool,
		EnableScheduledReports: true,
		EnableExports:          true,
	})
	if surface.ScheduledReports != nil || surface.Exports != nil {
		t.Fatal("workers requiring optional dependencies were constructed without them")
	}
	withNilCipher := NewOperationalMaintenanceWorkersSurface(OperationalMaintenanceWorkerDeps{Pool: pool, EnableAuditSinks: true})
	if withNilCipher.AuditSinkDelivery == nil || withNilCipher.AuditSinkDelivery.Cipher != nil || withNilCipher.AuditSinkDelivery.Encrypter != nil {
		t.Fatal("audit-sink dev-mode nil-cipher behavior changed")
	}
}

func TestOperationalMaintenanceLaunchOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	workerBytes, err := os.ReadFile("operational_maintenance.go")
	if err != nil {
		t.Fatalf("read operational_maintenance.go: %v", err)
	}
	assertOperationalSourceOrder(t, string(workerBytes), []string{
		`"scoring-worker"`,
		`"subscriber-import-worker"`,
		`"predictive-recompute-daily"`,
		`"scheduled-reports-worker"`,
		`"audit-export-worker"`,
		`"audit-export-schedule-worker"`,
		`"audit-alerts-worker"`,
		`"audit-ueba-worker"`,
		`"exports-worker"`,
		`"auditsink-delivery"`,
		`"auditsink-merkle"`,
		`"auditsink-key-rotator"`,
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOperationalSourceOrder(t, mainSource, []string{
		"apiworkers.StartDataRetentionWorkers(outboxCtx,",
		"apiworkers.StartOperationalMaintenanceWorkers(outboxCtx,",
		"apiserver.MountAdminKMSRoutes(",
	})
	for _, forbidden := range []string{
		"scoringWorker :=",
		"subscriberImportWorker :=",
		"reportsWorker :=",
		"auditExportWorker :=",
		"audDeliveryDeps :=",
		"runPredictiveRecomputeWorker(",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated operational-worker composition %q", forbidden)
		}
	}
	compositionBytes, err := os.ReadFile("../../composition_adapters.go")
	if err != nil {
		t.Fatalf("read composition_adapters.go: %v", err)
	}
	if strings.Contains(string(compositionBytes), "runPredictiveRecomputeWorker(") {
		t.Fatal("composition_adapters.go retained the migrated predictive worker")
	}
}

func assertOperationalSourceOrder(t *testing.T, source string, markers []string) {
	t.Helper()
	position := -1
	for _, marker := range markers {
		next := strings.Index(source[position+1:], marker)
		if next < 0 {
			t.Fatalf("source is missing marker %q", marker)
		}
		position += next + 1
	}
}
