// SPDX-License-Identifier: AGPL-3.0-only

package ai_regression

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRunnerExecuteClaimedPersistsEveryBatchThenFinalizes(t *testing.T) {
	claimed := testClaimedRun("example-1", "example-2", "example-3", "example-4", "example-5")
	store := &runnerStoreFake{}
	voice := &runnerVoiceFake{replay: func(_ context.Context, _ string, request VoiceReplayRequest) (VoiceReplayBatch, error) {
		// The runner must persist the receipt order, rather than assume request
		// order. The strict client has already proved this is a complete, valid
		// receipt; preserving it makes the evidence trail independently auditable.
		results := make([]VoiceReplayResult, 0, len(request.Examples))
		for index := len(request.Examples) - 1; index >= 0; index-- {
			example := request.Examples[index]
			if example.ID == "example-2" {
				results = append(results, VoiceReplayResult{
					ExampleID: example.ID, SurfaceKind: example.SurfaceKind,
					Severity: "error", ErrorCode: "scoring_unavailable",
				})
				continue
			}
			score := 91.5
			results = append(results, VoiceReplayResult{
				ExampleID: example.ID, SurfaceKind: example.SurfaceKind,
				ReplayedOutput: "replayed " + example.ID, FidelityScore: &score, Severity: "ok",
				Breakdown: &VoiceFidelityBreakdown{
					EmbeddingSimilarity: .92, StylisticDistance: .08, VocabularyOverlap: .89,
					StructuralMatch: .95, Combined: score,
				},
			})
		}
		return VoiceReplayBatch{Results: results}, nil
	}}
	runner := &Runner{Store: store, Voice: voice, BatchSize: 2, HeartbeatEvery: time.Hour}

	if err := runner.ExecuteClaimed(context.Background(), claimed); err != nil {
		t.Fatalf("ExecuteClaimed() error = %v", err)
	}
	if got, want := voice.batchSizes(), []int{2, 2, 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("voice batch sizes = %v, want %v", got, want)
	}
	if got, want := store.upsertIDs(), []string{"example-2", "example-1", "example-4", "example-3", "example-5"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("upsert order = %v, want receipt order %v", got, want)
	}
	upserts := store.upsertInputs()
	if got := upserts[0]; got.FidelityScore != nil || got.Breakdown != nil || got.ErrorCode == nil || *got.ErrorCode != "scoring_unavailable" || got.ErrorMessage == nil || *got.ErrorMessage != "the fidelity evaluator was unavailable for this reference" {
		t.Fatalf("closed error mapping = %#v", got)
	}
	if got := upserts[1]; got.ReplayedOutput == nil || *got.ReplayedOutput != "replayed example-1" || got.FidelityScore == nil || *got.FidelityScore != 91.5 || got.Breakdown == nil || got.Breakdown["combined"] != 91.5 || got.ErrorCode != nil {
		t.Fatalf("typed scored mapping = %#v", got)
	}
	if store.finalizeCount() != 1 || store.retryCount() != 0 || store.failCount() != 0 {
		t.Fatalf("terminal calls: finalize=%d retry=%d fail=%d", store.finalizeCount(), store.retryCount(), store.failCount())
	}
	if got := store.callsSnapshot(); got[len(got)-1] != "finalize" {
		t.Fatalf("final call = %q, want finalize; calls=%v", got[len(got)-1], got)
	}
}

func TestRunnerHeartbeatRenewsAndStopsBeforeFinalization(t *testing.T) {
	claimed := testClaimedRun("example-1")
	renewed := make(chan struct{})
	releaseVoice := make(chan struct{})
	voiceStarted := make(chan struct{})
	var renewOnce sync.Once
	store := &runnerStoreFake{renew: func(context.Context, string, string, string, int, time.Duration) (*RegressionRun, error) {
		renewOnce.Do(func() { close(renewed) })
		return &RegressionRun{}, nil
	}}
	voice := &runnerVoiceFake{replay: func(_ context.Context, _ string, request VoiceReplayRequest) (VoiceReplayBatch, error) {
		close(voiceStarted)
		<-releaseVoice
		return VoiceReplayBatch{Results: []VoiceReplayResult{scoredVoiceResult(request.Examples[0])}}, nil
	}}
	runner := &Runner{Store: store, Voice: voice, LeaseTTL: 30 * time.Millisecond, HeartbeatEvery: time.Millisecond}
	errCh := make(chan error, 1)
	go func() { errCh <- runner.ExecuteClaimed(context.Background(), claimed) }()
	<-voiceStarted
	select {
	case <-renewed:
	case <-time.After(time.Second):
		t.Fatal("heartbeat never renewed the lease")
	}
	close(releaseVoice)
	if err := <-errCh; err != nil {
		t.Fatalf("ExecuteClaimed() error = %v", err)
	}
	callsAtFinalize := store.callsSnapshot()
	if len(callsAtFinalize) < 3 || callsAtFinalize[len(callsAtFinalize)-1] != "finalize" {
		t.Fatalf("unexpected lifecycle ordering: %v", callsAtFinalize)
	}
	time.Sleep(5 * time.Millisecond)
	if got := store.callsSnapshot(); !reflect.DeepEqual(got, callsAtFinalize) {
		t.Fatalf("heartbeat wrote after finalization: before=%v after=%v", callsAtFinalize, got)
	}
}

func TestRunnerHeartbeatLeaseLossCancelsWorkWithoutFurtherMutation(t *testing.T) {
	claimed := testClaimedRun("example-1")
	store := &runnerStoreFake{renew: func(context.Context, string, string, string, int, time.Duration) (*RegressionRun, error) {
		return nil, ErrLeaseLost
	}}
	voice := &runnerVoiceFake{replay: func(ctx context.Context, _ string, _ VoiceReplayRequest) (VoiceReplayBatch, error) {
		<-ctx.Done()
		return VoiceReplayBatch{}, ctx.Err()
	}}
	runner := &Runner{Store: store, Voice: voice, LeaseTTL: 20 * time.Millisecond, HeartbeatEvery: time.Millisecond}
	err := runner.ExecuteClaimed(context.Background(), claimed)
	if !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("ExecuteClaimed() error = %v, want ErrLeaseLost", err)
	}
	if store.upsertCount() != 0 || store.finalizeCount() != 0 || store.retryCount() != 0 || store.failCount() != 0 {
		t.Fatalf("lost lease mutated durable state: calls=%v", store.callsSnapshot())
	}
}

func TestRunnerRetriesTransientAndQuotaFailuresWithDeterministicSchedule(t *testing.T) {
	now := time.Date(2026, time.August, 9, 10, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name      string
		cause     error
		attempt   int
		wantCode  string
		wantDelay time.Duration
	}{
		{"transient retry", ErrVoiceUnavailable, 2, "voice_unavailable", time.Minute},
		{"quota cooling off", ErrVoiceQuotaExceeded, 1, "voice_quota_exceeded", time.Hour},
		{"unknown dependency retry", errors.New("dial failed"), 3, "worker_dependency_unavailable", 2 * time.Minute},
	} {
		t.Run(test.name, func(t *testing.T) {
			claimed := testClaimedRun("example-1")
			claimed.Run.AttemptCount = test.attempt
			store := &runnerStoreFake{}
			voice := &runnerVoiceFake{replay: func(context.Context, string, VoiceReplayRequest) (VoiceReplayBatch, error) {
				return VoiceReplayBatch{}, test.cause
			}}
			runner := &Runner{Store: store, Voice: voice, Now: func() time.Time { return now }, HeartbeatEvery: time.Hour}
			err := runner.ExecuteClaimed(context.Background(), claimed)
			if !errors.Is(err, test.cause) {
				t.Fatalf("ExecuteClaimed() error = %v, want cause %v", err, test.cause)
			}
			retries := store.retriesSnapshot()
			if len(retries) != 1 || retries[0].failure.Code != test.wantCode || !retries[0].notBefore.Equal(now.Add(test.wantDelay)) {
				t.Fatalf("retry = %#v, want code=%q at %s", retries, test.wantCode, now.Add(test.wantDelay))
			}
			if store.failCount() != 0 || store.finalizeCount() != 0 {
				t.Fatalf("retry incorrectly terminalized: calls=%v", store.callsSnapshot())
			}
		})
	}
}

func TestRunnerAcceptsStoreRetryExhaustionTerminalContract(t *testing.T) {
	claimed := testClaimedRun("example-1")
	claimed.Run.AttemptCount = DefaultRunMaxAttempts
	store := &runnerStoreFake{retry: func(_ context.Context, _ string, _ string, _ string, _ int, _ time.Time, _ RunFailure) (*RegressionRun, error) {
		// RetryRun owns the atomically fenced max-attempts transition. A runner
		// must not issue a second, unfenced FailRun after the store reports it.
		return &RegressionRun{Status: RunStatusFailed}, nil
	}}
	runner := &Runner{Store: store, Voice: &runnerVoiceFake{replay: func(context.Context, string, VoiceReplayRequest) (VoiceReplayBatch, error) {
		return VoiceReplayBatch{}, ErrVoiceUnavailable
	}}, Now: func() time.Time { return time.Unix(0, 0) }, HeartbeatEvery: time.Hour}
	if err := runner.ExecuteClaimed(context.Background(), claimed); !errors.Is(err, ErrVoiceUnavailable) {
		t.Fatalf("ExecuteClaimed() error = %v", err)
	}
	if store.retryCount() != 1 || store.failCount() != 0 || store.finalizeCount() != 0 {
		t.Fatalf("retry exhaustion lifecycle calls=%v", store.callsSnapshot())
	}
}

func TestRunnerTerminatesNonRetryableEvidenceFailures(t *testing.T) {
	tests := []struct {
		name string
		run  func(*runnerStoreFake) *runnerVoiceFake
		want string
	}{
		{"voice authentication", func(_ *runnerStoreFake) *runnerVoiceFake { return failingVoice(ErrVoiceAuthenticationUnavailable) }, "voice_auth_unavailable"},
		{"runtime mismatch", func(_ *runnerStoreFake) *runnerVoiceFake { return failingVoice(ErrVoiceRuntimeMismatch) }, "runtime_mismatch"},
		{"missing prerequisite", func(_ *runnerStoreFake) *runnerVoiceFake { return failingVoice(ErrVoicePrerequisiteUnavailable) }, "replay_prerequisite_unavailable"},
		{"invalid receipt", func(_ *runnerStoreFake) *runnerVoiceFake { return failingVoice(ErrVoiceInvalidResponse) }, "invalid_replay_receipt"},
		{"snapshot incomplete at finalize", func(store *runnerStoreFake) *runnerVoiceFake {
			store.finalize = func(context.Context, string, string, string, int) (*RegressionRun, error) {
				return nil, ErrSnapshotIncomplete
			}
			return passingVoice()
		}, "snapshot_incomplete"},
		{"invalid persisted result", func(store *runnerStoreFake) *runnerVoiceFake {
			store.upsert = func(context.Context, string, string, string, int, UpsertRegressionResultInput) (*RegressionResult, error) {
				return nil, ErrInvalidResult
			}
			return passingVoice()
		}, "evidence_contract_invalid"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &runnerStoreFake{}
			runner := &Runner{Store: store, Voice: test.run(store), HeartbeatEvery: time.Hour}
			err := runner.ExecuteClaimed(context.Background(), testClaimedRun("example-1"))
			if err == nil {
				t.Fatal("ExecuteClaimed() error = nil, want terminal failure")
			}
			failures := store.failuresSnapshot()
			if len(failures) != 1 || failures[0].Code != test.want {
				t.Fatalf("failures = %#v, want code %q", failures, test.want)
			}
			if store.retryCount() != 0 || store.finalizeCount() > 1 {
				t.Fatalf("non-retryable failure had wrong lifecycle calls=%v", store.callsSnapshot())
			}
		})
	}
}

func TestRunnerCancellationUsesDetachedSafeRetryContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var retryContextErr error
	store := &runnerStoreFake{retry: func(got context.Context, _ string, _ string, _ string, _ int, _ time.Time, _ RunFailure) (*RegressionRun, error) {
		retryContextErr = got.Err()
		return &RegressionRun{}, nil
	}}
	runner := &Runner{Store: store, Voice: passingVoice(), Now: func() time.Time { return time.Unix(0, 0) }}
	err := runner.ExecuteClaimed(ctx, testClaimedRun("example-1"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ExecuteClaimed() error = %v, want context.Canceled", err)
	}
	if retryContextErr != nil || store.retryCount() != 1 || store.failCount() != 0 {
		t.Fatalf("detached retry context=%v calls=%v", retryContextErr, store.callsSnapshot())
	}
}

func TestRunnerRecoversPanicWithSafeTerminalFailure(t *testing.T) {
	store := &runnerStoreFake{}
	runner := &Runner{Store: store, Voice: &runnerVoiceFake{replay: func(context.Context, string, VoiceReplayRequest) (VoiceReplayBatch, error) {
		panic("provider secret must not become an operator payload")
	}}, HeartbeatEvery: time.Hour}
	err := runner.ExecuteClaimed(context.Background(), testClaimedRun("example-1"))
	if err == nil || !strings.Contains(err.Error(), "regression worker panicked") || strings.Contains(err.Error(), "provider secret") {
		t.Fatalf("unsafe panic result = %v", err)
	}
	failures := store.failuresSnapshot()
	if len(failures) != 1 || failures[0] != (RunFailure{Code: "worker_panic", Message: "the regression worker stopped unexpectedly and the attempt was closed safely"}) {
		t.Fatalf("panic failure = %#v", failures)
	}
}

func TestRunnerDoesNotFinalizeAfterPartialBatchFailure(t *testing.T) {
	claimed := testClaimedRun("example-1", "example-2", "example-3", "example-4")
	voice := &runnerVoiceFake{replay: func(_ context.Context, _ string, request VoiceReplayRequest) (VoiceReplayBatch, error) {
		if request.Examples[0].ID == "example-3" {
			return VoiceReplayBatch{}, ErrVoiceUnavailable
		}
		return VoiceReplayBatch{Results: []VoiceReplayResult{scoredVoiceResult(request.Examples[0]), scoredVoiceResult(request.Examples[1])}}, nil
	}}
	store := &runnerStoreFake{}
	runner := &Runner{Store: store, Voice: voice, BatchSize: 2, HeartbeatEvery: time.Hour}
	err := runner.ExecuteClaimed(context.Background(), claimed)
	if !errors.Is(err, ErrVoiceUnavailable) {
		t.Fatalf("ExecuteClaimed() error = %v", err)
	}
	if got, want := store.upsertIDs(), []string{"example-1", "example-2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("persisted partial evidence = %v, want %v", got, want)
	}
	if store.finalizeCount() != 0 || store.retryCount() != 1 || store.failCount() != 0 {
		t.Fatalf("partial failure lifecycle calls=%v", store.callsSnapshot())
	}
}

func TestRunnerRejectsInvalidClaimAndSafelyDefaultsInvalidConfiguration(t *testing.T) {
	valid := testClaimedRun("example-1")
	if err := (&Runner{}).ExecuteClaimed(context.Background(), valid); err == nil {
		t.Fatal("unconfigured runner unexpectedly executed")
	}
	for _, invalid := range []*ClaimedRegressionRun{
		nil,
		func() *ClaimedRegressionRun {
			c := testClaimedRun("example-1")
			c.Run.Status = RunStatusPending
			return c
		}(),
		func() *ClaimedRegressionRun { c := testClaimedRun("example-1"); c.Run.ClaimToken = nil; return c }(),
		func() *ClaimedRegressionRun { c := testClaimedRun("example-1"); c.Examples = nil; return c }(),
		func() *ClaimedRegressionRun { c := testClaimedRun("example-1"); c.Run.TotalExamples = 2; return c }(),
	} {
		err := (&Runner{Store: &runnerStoreFake{}, Voice: passingVoice()}).ExecuteClaimed(context.Background(), invalid)
		if err == nil || !strings.Contains(err.Error(), "invalid claimed run") {
			t.Fatalf("invalid claim error = %v", err)
		}
	}
	runner := &Runner{LeaseTTL: 3 * time.Millisecond, HeartbeatEvery: time.Hour, BatchSize: voiceReplayMaxExamples + 1}
	lease, heartbeat := runner.leasePolicy()
	if lease != 3*time.Millisecond || heartbeat <= 0 || heartbeat >= lease {
		t.Fatalf("invalid lease configuration not normalized: lease=%s heartbeat=%s", lease, heartbeat)
	}
	ids := make([]string, voiceReplayMaxExamples+1)
	for index := range ids {
		ids[index] = "example-batch-" + string(rune('a'+index))
	}
	store := &runnerStoreFake{}
	voice := passingVoice()
	runner = &Runner{Store: store, Voice: voice, BatchSize: voiceReplayMaxExamples + 1, HeartbeatEvery: time.Hour}
	if err := runner.ExecuteClaimed(context.Background(), testClaimedRun(ids...)); err != nil {
		t.Fatalf("invalid batch configuration execution error = %v", err)
	}
	if got, want := voice.batchSizes(), []int{
		defaultRegressionBatchSize,
		defaultRegressionBatchSize,
		defaultRegressionBatchSize,
		defaultRegressionBatchSize,
		defaultRegressionBatchSize,
		1,
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("invalid batch size did not use safe default: got %v, want %v", got, want)
	}
}

func testClaimedRun(ids ...string) *ClaimedRegressionRun {
	token := "claim-token"
	examples := make([]RunExampleSnapshot, 0, len(ids))
	for ordinal, id := range ids {
		examples = append(examples, RunExampleSnapshot{
			RunID: "run-1", ExampleID: id, Ordinal: ordinal + 1, SurfaceKind: SurfaceCampaignDraft,
			Brief: "A concise campaign brief", ApprovedOutput: "Approved output for " + id,
		})
	}
	return &ClaimedRegressionRun{Run: RegressionRun{
		ID: "run-1", TenantID: "tenant-1", ClaimToken: &token, AttemptCount: 1, Status: RunStatusRunning,
		TotalExamples: len(examples), RuntimeProvider: "google", ModelID: "gemini-test", PromptVersionTag: "replay-v2",
		WarnThreshold: DefaultWarnThreshold,
	}, Examples: examples, Settings: DefaultSettings()}
}

func scoredVoiceResult(example VoiceReplayExample) VoiceReplayResult {
	score := 90.0
	return VoiceReplayResult{ExampleID: example.ID, SurfaceKind: example.SurfaceKind, ReplayedOutput: "replayed", FidelityScore: &score, Severity: "ok", Breakdown: &VoiceFidelityBreakdown{EmbeddingSimilarity: .9, StylisticDistance: .1, VocabularyOverlap: .9, StructuralMatch: .9, Combined: 90}}
}

func passingVoice() *runnerVoiceFake {
	return &runnerVoiceFake{replay: func(_ context.Context, _ string, request VoiceReplayRequest) (VoiceReplayBatch, error) {
		results := make([]VoiceReplayResult, 0, len(request.Examples))
		for _, example := range request.Examples {
			results = append(results, scoredVoiceResult(example))
		}
		return VoiceReplayBatch{Results: results}, nil
	}}
}

func failingVoice(err error) *runnerVoiceFake {
	return &runnerVoiceFake{replay: func(context.Context, string, VoiceReplayRequest) (VoiceReplayBatch, error) {
		return VoiceReplayBatch{}, err
	}}
}

type runnerVoiceFake struct {
	mu       sync.Mutex
	requests []VoiceReplayRequest
	replay   func(context.Context, string, VoiceReplayRequest) (VoiceReplayBatch, error)
}

func (fake *runnerVoiceFake) ReplayBatch(ctx context.Context, tenantID string, request VoiceReplayRequest) (VoiceReplayBatch, error) {
	fake.mu.Lock()
	fake.requests = append(fake.requests, request)
	fake.mu.Unlock()
	return fake.replay(ctx, tenantID, request)
}

func (fake *runnerVoiceFake) batchSizes() []int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	sizes := make([]int, len(fake.requests))
	for index, request := range fake.requests {
		sizes[index] = len(request.Examples)
	}
	return sizes
}

type retryCall struct {
	notBefore time.Time
	failure   RunFailure
}

type runnerStoreFake struct {
	mu        sync.Mutex
	calls     []string
	upserts   []UpsertRegressionResultInput
	retries   []retryCall
	failures  []RunFailure
	finalizeN int
	renew     func(context.Context, string, string, string, int, time.Duration) (*RegressionRun, error)
	retry     func(context.Context, string, string, string, int, time.Time, RunFailure) (*RegressionRun, error)
	finalize  func(context.Context, string, string, string, int) (*RegressionRun, error)
	fail      func(context.Context, string, string, string, int, RunFailure) (*RegressionRun, error)
	upsert    func(context.Context, string, string, string, int, UpsertRegressionResultInput) (*RegressionResult, error)
}

func (fake *runnerStoreFake) RenewRunLease(ctx context.Context, tenantID, runID, token string, attempt int, ttl time.Duration) (*RegressionRun, error) {
	fake.record("renew")
	if fake.renew != nil {
		return fake.renew(ctx, tenantID, runID, token, attempt, ttl)
	}
	return &RegressionRun{}, nil
}

func (fake *runnerStoreFake) RetryRun(ctx context.Context, tenantID, runID, token string, attempt int, notBefore time.Time, failure RunFailure) (*RegressionRun, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, "retry")
	fake.retries = append(fake.retries, retryCall{notBefore: notBefore, failure: failure})
	callback := fake.retry
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, tenantID, runID, token, attempt, notBefore, failure)
	}
	return &RegressionRun{}, nil
}

func (fake *runnerStoreFake) FinalizeRun(ctx context.Context, tenantID, runID, token string, attempt int) (*RegressionRun, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, "finalize")
	fake.finalizeN++
	callback := fake.finalize
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, tenantID, runID, token, attempt)
	}
	return &RegressionRun{}, nil
}

func (fake *runnerStoreFake) FailRun(ctx context.Context, tenantID, runID, token string, attempt int, failure RunFailure) (*RegressionRun, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, "fail")
	fake.failures = append(fake.failures, failure)
	callback := fake.fail
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, tenantID, runID, token, attempt, failure)
	}
	return &RegressionRun{}, nil
}

func (fake *runnerStoreFake) UpsertResult(ctx context.Context, tenantID, runID, token string, attempt int, input UpsertRegressionResultInput) (*RegressionResult, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, "upsert:"+input.ExampleID)
	fake.upserts = append(fake.upserts, input)
	callback := fake.upsert
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, tenantID, runID, token, attempt, input)
	}
	return &RegressionResult{}, nil
}

func (fake *runnerStoreFake) record(call string) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, call)
	fake.mu.Unlock()
}
func (fake *runnerStoreFake) callsSnapshot() []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]string(nil), fake.calls...)
}
func (fake *runnerStoreFake) upsertInputs() []UpsertRegressionResultInput {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]UpsertRegressionResultInput(nil), fake.upserts...)
}
func (fake *runnerStoreFake) upsertIDs() []string {
	inputs := fake.upsertInputs()
	ids := make([]string, len(inputs))
	for i, input := range inputs {
		ids[i] = input.ExampleID
	}
	return ids
}
func (fake *runnerStoreFake) upsertCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return len(fake.upserts)
}
func (fake *runnerStoreFake) retriesSnapshot() []retryCall {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]retryCall(nil), fake.retries...)
}
func (fake *runnerStoreFake) retryCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return len(fake.retries)
}
func (fake *runnerStoreFake) failuresSnapshot() []RunFailure {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]RunFailure(nil), fake.failures...)
}
func (fake *runnerStoreFake) failCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return len(fake.failures)
}
func (fake *runnerStoreFake) finalizeCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.finalizeN
}
