package zerocopy_triggers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func zeroCopyTenantRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func assertZeroCopyRuntimeUnavailable(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Error struct {
			Code          string `json:"code"`
			Capability    string `json:"capability"`
			RuntimeStatus string `json:"runtime_status"`
			Retryable     bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != "zero_copy_runtime_unavailable" ||
		body.Error.Capability != "zero_copy_trigger_execution" ||
		body.Error.RuntimeStatus != "unavailable" || body.Error.Retryable {
		t.Fatalf("unexpected error contract: %+v", body.Error)
	}
}

func TestExecutionHandlersFailBeforeRepositoryOrQueueAccess(t *testing.T) {
	deps := &Deps{} // nil stores prove the capability boundary runs first.
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"poll":      deps.PollNow,
		"dlq retry": deps.RetryDLQ,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			call(recorder, zeroCopyTenantRequest(http.MethodPost, "/api/v1/zero-copy-triggers/trigger-1/runtime", ""))
			assertZeroCopyRuntimeUnavailable(t, recorder)
		})
	}
}

func TestExecutionHandlersRemainAuthFirst(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{}).PollNow(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/zero-copy-triggers/trigger-1/poll", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestCreateAndUpdateRejectActiveRuntimeBeforePersistence(t *testing.T) {
	body := `{"name":"warehouse event","status":"active","provider":"postgres"}`
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"create": (&Deps{}).Create,
		"update": (&Deps{}).Update,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			call(recorder, zeroCopyTenantRequest(http.MethodPost, "/api/v1/zero-copy-triggers/trigger-1", body))
			assertZeroCopyRuntimeUnavailable(t, recorder)
		})
	}
}

func TestValidationAndResourceProjectionReportRuntimeUnavailable(t *testing.T) {
	result := ValidateTrigger(Trigger{
		Name: "warehouse event", Status: "active", Provider: "postgres",
		Query: "SELECT updated_at, email FROM contacts", CursorColumn: "updated_at",
		JourneyID: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", PollingIntervalSeconds: 60, MaxRowsPerTick: 100,
	})
	if !result.Valid {
		t.Fatalf("shape should remain valid for authoring analysis: %v", result.Errors)
	}
	if result.Runtime.ExecutionEnabled || result.Runtime.RuntimeStatus != "unavailable" || len(result.Warnings) == 0 {
		t.Fatalf("validation runtime = %+v warnings=%v", result.Runtime, result.Warnings)
	}
	trigger := &Trigger{}
	annotateRuntime(trigger)
	if trigger.Runtime == nil || trigger.Runtime.ExecutionEnabled || trigger.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("resource runtime = %+v", trigger.Runtime)
	}
}

type containmentEnqueuer struct{}

func (containmentEnqueuer) EnqueueRun(context.Context, string, EnqueueRequest) (string, error) {
	return "should-not-run", nil
}

type containmentNotifier struct {
	called bool
}

func (n *containmentNotifier) Notify(context.Context, string, AlertKind, string) error {
	n.called = true
	return nil
}

func TestPollOnceRequiresExecutionDependenciesBeforeWarehouseAccess(t *testing.T) {
	trigger := &Trigger{Status: "active", Provider: "not-registered", JourneyID: "journey-1"}
	if _, err := pollOnceQualified(context.Background(), &Repo{}, nil, "tenant-1", trigger, time.Now()); err == nil || !strings.Contains(err.Error(), "enqueuer") {
		t.Fatalf("missing enqueuer error = %v", err)
	}
	if _, err := pollOnceQualified(context.Background(), &Repo{}, containmentEnqueuer{}, "tenant-1", trigger, time.Now()); err == nil || !strings.Contains(err.Error(), "consent gate") {
		t.Fatalf("missing consent gate error = %v", err)
	}
}

func TestExportedWorkerSeamsFailBeforeRepositoryOrWarehouseAccess(t *testing.T) {
	if _, err := PollOnce(context.Background(), nil, nil, "", nil, time.Now()); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("PollOnce error = %v, want runtime unavailable before dependency access", err)
	}
	if _, err := (&Repo{}).ListDue(context.Background(), time.Now(), 10); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("ListDue error = %v, want runtime unavailable before pool access", err)
	}
	repo := &Repo{}
	if err := repo.RecordTick(context.Background(), "tenant-1", "trigger-1", "cursor", 1, "", time.Now()); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("RecordTick error = %v, want runtime unavailable before pool access", err)
	}
	if _, err := repo.RecordFire(context.Background(), "tenant-1", Fire{TriggerID: "trigger-1"}); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("RecordFire error = %v, want runtime unavailable before pool access", err)
	}
	if _, err := repo.ResolveSubscriberID(context.Background(), "tenant-1", "person@example.test"); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("ResolveSubscriberID error = %v, want runtime unavailable before pool access", err)
	}
	dlq := &DLQRepo{}
	if _, err := dlq.Enqueue(context.Background(), "tenant-1", DLQEntry{TriggerID: "trigger-1"}); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("DLQ Enqueue error = %v, want runtime unavailable before pool access", err)
	}
	if _, err := dlq.ListReconcilable(context.Background(), time.Now(), time.Minute, 10); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("ListReconcilable error = %v, want runtime unavailable before pool access", err)
	}
	if err := dlq.Resolve(context.Background(), "tenant-1", 1); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("DLQ Resolve error = %v, want runtime unavailable before pool access", err)
	}
	if err := dlq.Abandon(context.Background(), "tenant-1", 1, "reason"); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("DLQ Abandon error = %v, want runtime unavailable before pool access", err)
	}
	if err := dlq.IncrementRetry(context.Background(), "tenant-1", 1, "reason", time.Now()); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("DLQ IncrementRetry error = %v, want runtime unavailable before pool access", err)
	}
	if _, err := ReconcileDLQ(context.Background(), nil, nil, nil, time.Minute, 10, 3); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("ReconcileDLQ error = %v, want runtime unavailable before dependency access", err)
	}
	notifier := &containmentNotifier{}
	if err := EvaluateAndMaybeAlert(context.Background(), &AlertRepo{}, notifier, "tenant-1", "trigger-1", TickOutcome{ConsecutiveFailures: 10}, time.Now()); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("EvaluateAndMaybeAlert error = %v, want runtime unavailable before alert or notifier access", err)
	}
	if notifier.called {
		t.Fatal("contained alert evaluator invoked notifier")
	}
	// Run must return synchronously even with a live context and no repository.
	(&Worker{}).Run(context.Background())
}

func TestRepositoryRejectsActiveConfigurationBeforePoolAccess(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.Create(context.Background(), "tenant-1", Trigger{Status: "active"}); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("Create error = %v, want runtime unavailable", err)
	}
	if _, err := repo.Update(context.Background(), "tenant-1", Trigger{ID: "trigger-1", Status: "active"}); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("Update error = %v, want runtime unavailable", err)
	}
}

// The gate was `const zeroCopyRuntimeQualified = false`, and this test pinned
// that it stayed a compile-time constant. It is now a runtime value, because
// the two prerequisites it named — distributed leasing and durable execution
// receipts — have been built and the remaining blocker is a release decision
// rather than missing infrastructure.
//
// A settable gate is a weaker guarantee than a constant, so these assert the
// stronger properties a constant gave for free and a variable does not: it
// starts closed, the descriptor never disagrees with it, and every fail-closed
// call site reads the live value rather than a boot-time copy.
func TestExecutionGateDefaultsClosed(t *testing.T) {
	if ExecutionEnabled() {
		t.Fatal("zero-copy execution must default OFF; enabling it starts warehouse polling and journey enrolment")
	}
	d := zeroCopyRuntimeDescriptor()
	if d.ExecutionEnabled || d.RuntimeStatus != "unavailable" {
		t.Fatalf("descriptor = %+v, want an unavailable runtime while the gate is closed", d)
	}
}

func TestDescriptorTracksTheGateRatherThanBootState(t *testing.T) {
	// A descriptor computed once at init would keep reporting "unavailable"
	// after an operator enabled execution — clients would render an honest-
	// looking unavailable state for a capability that was live.
	t.Cleanup(func() { SetExecutionEnabled(false) })
	if previous := SetExecutionEnabled(true); previous {
		t.Fatal("SetExecutionEnabled must report the PREVIOUS value")
	}
	d := zeroCopyRuntimeDescriptor()
	if !d.ExecutionEnabled || d.RuntimeStatus != "available" {
		t.Fatalf("descriptor = %+v, want an available runtime once the gate is open", d)
	}
	if len(d.Prerequisites) != 0 {
		t.Fatalf("an available runtime must not list prerequisites, got %v", d.Prerequisites)
	}
	SetExecutionEnabled(false)
	if zeroCopyRuntimeDescriptor().ExecutionEnabled {
		t.Fatal("closing the gate must close the descriptor with it")
	}
}

func TestClosedGateStillNamesAnOutstandingPrerequisite(t *testing.T) {
	// Naming infrastructure that already exists would send an operator to build
	// something that is built. The remaining blocker is the release decision.
	d := zeroCopyRuntimeDescriptor()
	if len(d.Prerequisites) == 0 {
		t.Fatal("a contained runtime must say what is outstanding")
	}
	for _, p := range d.Prerequisites {
		if p == "distributed_trigger_leasing" || p == "durable_execution_receipts" {
			t.Fatalf("prerequisite %q is built (leader.Run + Repo.ClaimFire); listing it is now false", p)
		}
	}
}

func TestAlertMutationFailsBeforeDecodeOrPoolAccess(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{}).PutAlerts(recorder, zeroCopyTenantRequest(
		http.MethodPut,
		"/api/v1/zero-copy-triggers/trigger-1/alerts",
		`{"notify_webhook_url":`, // deliberately malformed; gate precedes decode.
	))
	assertZeroCopyRuntimeUnavailable(t, recorder)

	repo := &AlertRepo{}
	if _, err := repo.Upsert(context.Background(), "tenant-1", AlertConfig{TriggerID: "trigger-1"}); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("Upsert error = %v, want runtime unavailable", err)
	}
	if err := repo.RecordFired(context.Background(), "tenant-1", "trigger-1", AlertKindFailures, "secret", time.Now()); !errors.Is(err, ErrZeroCopyRuntimeUnavailable) {
		t.Fatalf("RecordFired error = %v, want runtime unavailable", err)
	}
}

func TestReadViewsDoNotSerializeCustomerOrEndpointSecrets(t *testing.T) {
	alert := alertConfigView(AlertConfig{
		TriggerID:        "trigger-1",
		NotifyWebhookURL: "https://169.254.169.254/latest/meta-data",
		LastAlertMessage: "provider token secret",
	})
	fire := fireView(Fire{
		ID: 1, TriggerID: "trigger-1", CursorValue: "cursor-secret",
		ProfileKey: "person@example.com", SubscriberID: "subscriber-secret",
		FlowRunID: "run-secret", Payload: map[string]any{"card": "4111111111111111"},
		Error: "provider-token-secret", Status: "error",
	})
	dlq := dlqEntryView(DLQEntry{
		ID: 2, TriggerID: "trigger-1", CursorValue: "dlq-cursor-secret",
		ProfileKey: "dlq@example.com", Payload: map[string]any{"ssn": "secret"},
		LastError: "warehouse-password-secret", Reason: DLQReasonEnqueueFailed,
	})
	raw, err := json.Marshal(map[string]any{"alert": alert, "fire": fire, "dlq": dlq})
	if err != nil {
		t.Fatalf("marshal read views: %v", err)
	}
	for _, secret := range []string{
		"169.254.169.254", "provider token secret", "cursor-secret",
		"person@example.com", "subscriber-secret", "run-secret",
		"4111111111111111", "provider-token-secret", "dlq@example.com",
		"warehouse-password-secret",
	} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("read DTO leaked %q: %s", secret, raw)
		}
	}
	if alert.Runtime.ExecutionEnabled || alert.Runtime.RuntimeStatus != "unavailable" ||
		!alert.WebhookConfigured || !alert.HasLastAlertMessage || !fire.HasPayload || !fire.HasProfileKey || !dlq.HasPayload || !dlq.HasProfileKey {
		t.Fatalf("redacted evidence flags missing: alert=%+v fire=%+v dlq=%+v", alert, fire, dlq)
	}
}

func TestRawTriggerDefinitionsRequireAdminScope(t *testing.T) {
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Repo: &Repo{}})
	for _, path := range []string{
		"/api/v1/zero-copy-triggers",
		"/api/v1/zero-copy-triggers/trigger-1",
	} {
		t.Run(path, func(t *testing.T) {
			for name, tc := range map[string]struct {
				scopes []apikeys.Scope
				want   int
			}{
				"reports reader denied": {scopes: []apikeys.Scope{apikeys.ScopeReadReports}, want: http.StatusForbidden},
				"admin reaches handler": {scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusUnauthorized},
			} {
				t.Run(name, func(t *testing.T) {
					req := httptest.NewRequest(http.MethodGet, path, nil)
					ctx := middleware.WithAPIKeyAuth(req.Context())
					ctx = apikeys.WithScopes(ctx, tc.scopes)
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, req.WithContext(ctx))
					if recorder.Code != tc.want {
						t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.want, recorder.Body.String())
					}
				})
			}
		})
	}
}
