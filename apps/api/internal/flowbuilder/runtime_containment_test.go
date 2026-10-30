package flowbuilder

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func flowTenantRequest(method, body string) *http.Request {
	req := httptest.NewRequest(method, "/api/v1/flow-builder/flows/flow-1/runtime", strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func assertFlowRuntimeUnavailable(t *testing.T, recorder *httptest.ResponseRecorder) {
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
	if body.Error.Code != "flow_runtime_unavailable" || body.Error.Capability != "flow_execution" ||
		body.Error.RuntimeStatus != "unavailable" || body.Error.Retryable {
		t.Fatalf("unexpected error contract: %+v", body.Error)
	}
}

func TestActivationAndPromotionFailBeforeRepositoryAccess(t *testing.T) {
	deps := &Deps{} // nil Repo proves no lookup or mutation occurs.
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"activate": deps.ActivateFlow,
		"promote":  deps.PromoteVersion,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			call(recorder, flowTenantRequest(http.MethodPost, ""))
			assertFlowRuntimeUnavailable(t, recorder)
		})
	}
}

func TestOperationalCreateAndExplicitActiveUpdateFailBeforePersistence(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		call func(http.ResponseWriter, *http.Request)
	}{
		"create": {body: `{"name":"live","status":"active"}`, call: (&Deps{}).CreateFlow},
		"update": {body: `{"status":"active"}`, call: (&Deps{}).UpdateFlow},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			tc.call(recorder, flowTenantRequest(http.MethodPost, tc.body))
			assertFlowRuntimeUnavailable(t, recorder)
		})
	}
}

func TestFlowRuntimeMutationRemainsAuthFirst(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{}).ActivateFlow(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/flow-builder/flows/flow-1/activate", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestValidationCanDescribeDraftButNeverClaimsExecutable(t *testing.T) {
	out := Validate(GraphValidateRequest{
		EntryID: "exit",
		Nodes:   []NodeSpec{{ID: "exit", Type: "exit"}},
	})
	if !out.Valid || out.Executable || out.Runtime.ExecutionEnabled || out.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("validation = %+v", out)
	}
	flow := &Flow{Status: "active"}
	annotateFlowRuntime(flow)
	if flow.Runtime == nil || flow.Runtime.ExecutionEnabled || flow.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("active flow projection = %+v", flow.Runtime)
	}
}

func TestRepositoryExecutionSeamsFailBeforePoolAccess(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.CreateFlow(context.Background(), "tenant-1", FlowInput{Name: "live", Status: "active"}); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("CreateFlow error = %v, want runtime unavailable", err)
	}
	if _, err := repo.UpdateFlow(context.Background(), "tenant-1", &Flow{Name: "live", Status: "draft"}, FlowInput{Status: "active"}); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("UpdateFlow error = %v, want runtime unavailable", err)
	}
	if _, err := repo.ActivateFlow(context.Background(), "tenant-1", "flow-1"); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("ActivateFlow error = %v, want runtime unavailable", err)
	}
	if _, err := repo.PromoteVersion(context.Background(), "tenant-1", "flow-1", nil, true); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("PromoteVersion error = %v, want runtime unavailable", err)
	}
	if _, err := repo.EnqueueRun(context.Background(), "tenant-1", RunEnqueueRequest{}); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("EnqueueRun error = %v, want runtime unavailable", err)
	}
	if _, err := repo.MatchFlowsForEvent(context.Background(), "tenant-1", "order.created"); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("MatchFlowsForEvent error = %v, want typed runtime unavailable before pool access", err)
	}
	if _, err := repo.MatchFlowsForTagEventTx(context.Background(), nil, "tenant-1", "added", "vip", "tag-1"); !errors.Is(err, ErrFlowRuntimeUnavailable) {
		t.Fatalf("MatchFlowsForTagEventTx error = %v, want typed runtime unavailable before transaction access", err)
	}
}

func TestRuntimeQualificationIsCompileTimeClosedAndDescriptorMatches(t *testing.T) {
	if flowRuntimeQualified {
		t.Fatal("flow runtime must remain compile-time contained")
	}
	if flowRuntime.ExecutionEnabled != flowRuntimeQualified || flowRuntime.RuntimeStatus != "unavailable" {
		t.Fatalf("descriptor = %+v, gate=%v", flowRuntime, flowRuntimeQualified)
	}
}
