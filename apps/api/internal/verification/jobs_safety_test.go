// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExplicitUnbilledProviderRejectionsDoNotGuessOrRetry(t *testing.T) {
	t.Parallel()
	for _, err := range []error{ErrNoCredits, ErrUnauthorized, ErrProviderAccountRejected, ErrNotConfigured} {
		if !isExplicitUnbilledProviderRejection(err) {
			t.Errorf("%v was not classified as an explicit unbilled rejection", err)
		}
	}
	partial := errors.Join(ErrProviderPartialOutcome, ErrProviderAccountRejected)
	if isExplicitUnbilledProviderRejection(partial) {
		t.Fatal("a later account rejection erased an earlier chunk's ambiguous spend")
	}
	if code := jobFailureCode(ErrProviderAccountRejected); code != "verification_provider_account_rejected" {
		t.Fatalf("jobFailureCode=%q", code)
	}
	if !isProviderOperationalError(ErrProviderAccountRejected) {
		t.Fatal("account rejection would not update provider health")
	}
}

func TestNormalizeJobIdempotencyKey(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "surrounding whitespace", input: "  bulk-run-42  ", wantErr: true},
		{name: "unicode", input: "verify-顧客-42", want: "verify-顧客-42"},
		{name: "blank", input: "   ", wantErr: true},
		{name: "control", input: "run\n42", wantErr: true},
		{name: "bidi override", input: "run\u202e42", wantErr: true},
		{name: "private use", input: "run\ue00042", wantErr: true},
		{name: "line separator", input: "run\u202842", wantErr: true},
		{name: "too long", input: strings.Repeat("a", 256), wantErr: true},
		{name: "invalid utf8", input: string([]byte{0xff}), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeJobIdempotencyKey(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("normalizeJobIdempotencyKey(%q) succeeded, want error", tc.input)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("normalizeJobIdempotencyKey(%q) = %q, %v; want %q, nil", tc.input, got, err, tc.want)
			}
		})
	}
}

func TestStoredJobHeaderRejectsLegacyMetadataSpoofingAndImpossibleState(t *testing.T) {
	now := time.Now().UTC()
	valid := Job{
		Status: JobStatusPending, Source: JobSourceInline,
		ExecutionMode: JobExecutionModeFull, ExecutionClass: jobExecutionClassBulk,
		Total: 1, NextAttemptAt: now, CreatedAt: now,
	}
	if err := validateStoredJobHeader(valid); err != nil {
		t.Fatalf("valid stored job rejected: %v", err)
	}
	for _, mutate := range []func(*Job){
		func(j *Job) { j.SourceRef = "customers\u202e" },
		func(j *Job) { j.FailureCode = "safe\ue000" },
		func(j *Job) { j.Error = "forged\u2028line" },
		func(j *Job) { j.IdempotencyKey = " retry" },
		func(j *Job) { j.RequestFingerprint = strings.Repeat("A", 64) },
		func(j *Job) { j.Provider = "foreign" },
		func(j *Job) { j.Processed = 2 },
		func(j *Job) { j.VendorVerified = 1; j.CreditsSpent = 2 },
		func(j *Job) { j.Status = JobStatusCompleted; j.CompletedAt = &now },
		func(j *Job) { j.Status = JobStatusRunning },
	} {
		job := valid
		mutate(&job)
		if err := validateStoredJobHeader(job); !errors.Is(err, errInvalidStoredJob) {
			t.Errorf("legacy malformed job %+v error=%v, want integrity sentinel", job, err)
		}
	}
}

func TestResolveJobAddressesRejectsRawControlsOnSubscriberImportBoundary(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, control string
	}{
		{"nul", "\x00"}, {"tab", "\t"}, {"newline", "\n"},
		{"vertical-tab", "\v"}, {"form-feed", "\f"}, {"carriage-return", "\r"},
		{"unicode-next-line", "\u0085"}, {"unicode-control", "\u009f"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := resolveJobAddresses(context.Background(), nil, "", JobSpec{
				Source: JobSourceUpload,
				Emails: []string{"person@example.com" + tc.control},
			})
			if err == nil {
				t.Fatalf("subscriber-import job boundary accepted control %q", tc.control)
			}
		})
	}
}

func TestJobRequestFingerprintBindsResolvedWork(t *testing.T) {
	t.Parallel()
	base := jobRequestFingerprint(JobSourceInline, "", []string{"a@example.com", "b@example.com"})
	if len(base) != 64 {
		t.Fatalf("fingerprint length = %d, want 64", len(base))
	}
	if base != jobRequestFingerprint(JobSourceInline, "", []string{"a@example.com", "b@example.com"}) {
		t.Fatal("same normalized work did not produce a stable fingerprint")
	}
	for name, changed := range map[string]string{
		"source":     jobRequestFingerprint(JobSourceUpload, "", []string{"a@example.com", "b@example.com"}),
		"source ref": jobRequestFingerprint(JobSourceInline, "ref", []string{"a@example.com", "b@example.com"}),
		"address":    jobRequestFingerprint(JobSourceInline, "", []string{"a@example.com", "c@example.com"}),
		"order":      jobRequestFingerprint(JobSourceInline, "", []string{"b@example.com", "a@example.com"}),
		"mode":       jobRequestFingerprint(JobSourceInline, "", []string{"a@example.com", "b@example.com"}, JobExecutionModeLocal),
	} {
		if changed == base {
			t.Fatalf("%s change did not alter fingerprint", name)
		}
	}
}

func TestDynamicJobQueriesAreDeterministicallyBounded(t *testing.T) {
	t.Parallel()
	for name, query := range map[string]string{
		"tag": tagJobAddressesQuery, "all": allSubscriberJobAddressesQuery,
	} {
		normalized := strings.Join(strings.Fields(query), " ")
		if !strings.Contains(normalized, "ORDER BY email ASC, id ASC LIMIT") {
			t.Fatalf("%s selector is not deterministically bounded: %s", name, normalized)
		}
	}
}

func TestSafeJobLogErrorClassNeverReturnsRawCause(t *testing.T) {
	t.Parallel()
	const canary = "duplicate row reader@example.com SQLSTATE 23505"
	if got := safeJobLogErrorClass(errors.New(canary)); got != "persistence_or_internal" || strings.Contains(got, canary) {
		t.Fatalf("safe job log class=%q", got)
	}
	if got := safeJobLogErrorClass(ErrProviderUnavailable); got != "provider_unavailable" {
		t.Fatalf("provider log class=%q", got)
	}
}

func TestNormalizeJobExecutionModeDefaultsFullAndRejectsOff(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{
		"": JobExecutionModeFull, " FULL ": JobExecutionModeFull, "Local": JobExecutionModeLocal,
	} {
		got, err := normalizeJobExecutionMode(input)
		if err != nil || got != want {
			t.Fatalf("normalizeJobExecutionMode(%q)=%q,%v want %q,nil", input, got, err, want)
		}
	}
	if _, err := normalizeJobExecutionMode(ModeOff); err == nil {
		t.Fatal("off is a policy mode and must not create executable verification work")
	}
}

func TestRunnerCapsKickboxDurableDispatchReceiptToOneFanoutWindow(t *testing.T) {
	t.Parallel()
	runner := &Runner{BatchSize: DefaultJobBatchSize}
	kickboxChain := &Chain{Vendor: &fakeVerifier{name: ProviderKickbox}}
	if got := runner.batchSizeForChain(kickboxChain); got != kickboxBatchConcurrency {
		t.Fatalf("Kickbox claim size = %d, want %d", got, kickboxBatchConcurrency)
	}

	runner.BatchSize = 4
	if got := runner.batchSizeForChain(kickboxChain); got != 4 {
		t.Fatalf("explicit smaller Kickbox claim size = %d, want 4", got)
	}
	runner.BatchSize = DefaultJobBatchSize
	zeroBounceChain := &Chain{Vendor: &fakeVerifier{name: ProviderZeroBounce}}
	if got := runner.batchSizeForChain(zeroBounceChain); got != DefaultJobBatchSize {
		t.Fatalf("ZeroBounce claim size = %d, want %d", got, DefaultJobBatchSize)
	}
	runner.BatchSize = 1000
	if got := runner.batchSizeForChain(zeroBounceChain); got != zeroBounceMaxBatch {
		t.Fatalf("oversized ZeroBounce claim = %d, want one %d-address provider chunk",
			got, zeroBounceMaxBatch)
	}
}

func TestClaimedJobAddressesMustAlreadyMatchTheDurableCanonicalContract(t *testing.T) {
	t.Parallel()
	for _, emails := range [][]string{
		{" Person@example.com"},
		{"person@EXAMPLE.com"},
		{"person@example.com\n"},
		{"person@example.com", "person@example.com"},
		{strings.Repeat("x", maxJobEmailBytes+1) + "@example.com"},
	} {
		if err := validateClaimedJobEmails(emails); err == nil {
			t.Errorf("validateClaimedJobEmails(%q) succeeded", emails)
		}
	}
	if err := validateClaimedJobEmails([]string{"person@example.com"}); err != nil {
		t.Fatalf("canonical durable address rejected: %v", err)
	}
}

func TestBulkSafetyMigrationPinsDurableOwnershipContract(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1953_verification_bulk_job_safety.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read bulk safety migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"idempotency_key",
		"request_fingerprint",
		"lease_owner",
		"lease_expires_at",
		"attempt_token",
		"request_started_at",
		"attempt_state IN ('pending', 'leased', 'succeeded', 'ambiguous')",
		"verification_jobs_worker_select",
		"verification_jobs_worker_update",
		"verification_cache_worker_delete",
		"verification_cache_worker_select",
		"app.outbox_worker",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing %q", required)
		}
	}
}

func TestImportEnforcementMigrationPinsFrozenModeAndJobBinding(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1956_subscriber_import_verification_enforcement.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read import verification migration: %v", err)
	}
	for _, required := range []string{
		"execution_mode", "preflight_verification_mode", "verification_mode",
		"verification_state", "verification_job_id", "rows_verification_rejected",
		"FOREIGN KEY (tenant_id, verification_job_id)",
	} {
		if !strings.Contains(string(raw), required) {
			t.Errorf("import enforcement migration missing %q", required)
		}
	}
}

func TestJobWorkerUsesWorkerScopeAndLeasedClaims(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("jobs.go")
	if err != nil {
		t.Fatalf("read jobs.go: %v", err)
	}
	// The worker (claim/lease/batch/complete) lives in jobs_runner.go; the job
	// model, creation, and read surfaces stay in jobs.go. Both are in scope.
	source := string(raw) + string(mustReadTestFile(t, "jobs_runner.go"))
	for _, required := range []string{
		"db.WithWorkerScope(ctx, s.Pool)",
		"db.WithTenantWorker(ctx, s.Pool, tenantID)",
		"FOR UPDATE SKIP LOCKED",
		"markBatchRequestStarted",
		"markBatchAmbiguous",
		"idempotency_key_request_mismatch",
	} {
		if !strings.Contains(source, required) && !strings.Contains(string(mustReadTestFile(t, "handlers.go")), required) {
			t.Errorf("worker/handler safety contract missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"s.Pool.QueryRow(ctx,\n\t\t`SELECT tenant_id::text, id::text FROM verification_jobs",
		"WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND NOT processed",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("legacy unsafe claim remains: %q", forbidden)
		}
	}
}

func mustReadTestFile(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return raw
}
