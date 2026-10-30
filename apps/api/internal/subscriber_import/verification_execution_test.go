// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

type failingImportVerificationProjector struct {
	err error
}

func (p failingImportVerificationProjector) ProjectImportPreflight(
	context.Context, string, []string,
) (VerificationProjection, error) {
	return VerificationProjection{}, p.err
}

func TestSubscriberImportVerificationLogsNeverExposeRawErrors(t *testing.T) {
	t.Parallel()
	const canary = "secret-person@example.test"
	for _, err := range []error{
		errors.New("duplicate key detail contains " + canary),
		errors.Join(ErrImportVerificationBinding, errors.New(canary)),
		context.Canceled,
		context.DeadlineExceeded,
	} {
		class := subscriberImportLogErrorClass(err)
		if class == "" || strings.Contains(class, canary) {
			t.Fatalf("unsafe error class %q for %v", class, err)
		}
	}

	var log bytes.Buffer
	deps := &Deps{
		Verification: failingImportVerificationProjector{
			err: errors.New("projection failed for " + canary),
		},
		Logger: slog.New(slog.NewJSONHandler(&log, nil)),
	}
	if got := deps.projectVerification(context.Background(), "tenant-id", []string{canary}); got != nil {
		t.Fatalf("failed projection = %+v, want omitted", got)
	}
	logged := log.String()
	if strings.Contains(logged, canary) || strings.Contains(logged, "projection failed for") {
		t.Fatalf("raw verification error escaped into log: %s", logged)
	}
	if !strings.Contains(logged, `"error_class":"internal_or_dependency"`) {
		t.Fatalf("safe error class missing from log: %s", logged)
	}
}

func TestImportVerificationRejectsEveryHardTerminalStatus(t *testing.T) {
	t.Parallel()
	statuses := []string{"invalid", "spamtrap", "abuse", "do_not_mail"}
	batch := preparedBatch{}
	decisions := map[string]ImportVerificationDecision{}
	for i, status := range statuses {
		email := status + "@example.test"
		batch.Accepted = append(batch.Accepted, preparedRow{RowNumber: int64(i + 1), Email: email})
		decisions[email] = ImportVerificationDecision{Status: status}
	}
	for i, status := range []string{"valid", "catch_all", "unknown"} {
		email := status + "@example.test"
		batch.Accepted = append(batch.Accepted, preparedRow{RowNumber: int64(10 + i), Email: email})
		decisions[email] = ImportVerificationDecision{Status: status}
	}

	if got := enforceImportVerification(&batch, decisions); got != int64(len(statuses)) {
		t.Fatalf("rejected=%d want=%d", got, len(statuses))
	}
	if len(batch.Accepted) != 3 || len(batch.Errors) != len(statuses) {
		t.Fatalf("enforced batch=%+v", batch)
	}
	for _, rowErr := range batch.Errors {
		if rowErr.Code != "email_verification_rejected" || strings.Contains(rowErr.Message, "@") {
			t.Fatalf("unsafe or unstable row error=%+v", rowErr)
		}
	}
}

func TestCompletedImportVerificationRequiresExactDecisionCoverage(t *testing.T) {
	t.Parallel()
	emails := []string{"a@example.test", "b@example.test"}
	if err := validateImportVerificationDecisions(emails, map[string]ImportVerificationDecision{
		"a@example.test": {Status: "valid"},
	}); err == nil {
		t.Fatal("incomplete completed decision set was accepted")
	}
	if err := validateImportVerificationDecisions(emails, map[string]ImportVerificationDecision{
		"a@example.test": {Status: "valid"},
		"b@example.test": {Status: "invalid"},
	}); err != nil {
		t.Fatalf("complete decision set rejected: %v", err)
	}
	if err := validateImportVerificationDecisions(emails, map[string]ImportVerificationDecision{
		"a@example.test": {Status: "valid"},
		"b@example.test": {Status: "provider_magic"},
	}); err == nil {
		t.Fatal("unsupported verification status was silently admitted")
	}
}

func TestPreflightFingerprintBindsVerificationMode(t *testing.T) {
	t.Parallel()
	mapping := importMapping()
	opts := importOptions{SourceFingerprintScheme: sourceFingerprintScheme, SourceFingerprintKeyVersion: "v1"}
	local := computePreflightFingerprint(strings.Repeat("a", 64), mapping, "skip", opts, "state", "catalog", ImportVerificationModeLocal)
	full := computePreflightFingerprint(strings.Repeat("a", 64), mapping, "skip", opts, "state", "catalog", ImportVerificationModeFull)
	if local == full {
		t.Fatal("verification policy mode was not frozen into the reviewed preflight")
	}
}

func TestPrivateVerificationLifecycleProjectsToPublicImportStatus(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]string{
		importStatusVerificationQueued:  "queued",
		importStatusVerificationRunning: "running",
		"ready":                         "ready",
	} {
		if got := publicImportStatus(raw); got != want {
			t.Fatalf("publicImportStatus(%q)=%q want=%q", raw, got, want)
		}
	}
}
