// SPDX-License-Identifier: AGPL-3.0-only
package agentgov

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/budgets"
)

func ptr(i int) *int { return &i }

// fakeBudget implements budgets.Checker.
type fakeBudget struct {
	budget  *budgets.Budget
	usage   *budgets.Usage
	loadErr error
	incs    int
}

func (f *fakeBudget) LoadBudget(context.Context, string) (*budgets.Budget, error) {
	return f.budget, f.loadErr
}
func (f *fakeBudget) LoadUsage(context.Context, string, time.Time) (*budgets.Usage, error) {
	if f.usage == nil {
		return &budgets.Usage{}, nil
	}
	return f.usage, nil
}
func (f *fakeBudget) IncrementUsage(_ context.Context, _ *budgets.Budget, _ budgets.Resource, inc int, _ time.Time) error {
	f.incs += inc
	return nil
}

type fakeQuota struct {
	exceeded bool
	err      error
	calls    *int
}

func (f fakeQuota) CheckQuota(context.Context, string, string) (bool, int, int, error) {
	if f.calls != nil {
		(*f.calls)++
	}
	return f.exceeded, 100, 1, f.err
}

var (
	readTool = &agenttools.ToolSpec{Name: "stats", Category: agenttools.CategoryAnalytics, Annotations: agenttools.Annotations{ReadOnly: true}}
	sendTool = &agenttools.ToolSpec{Name: "campaign_send", Category: agenttools.CategoryCampaigns, WriteTier: true, ChargesSend: true, Annotations: agenttools.Annotations{OpenWorld: true}}
	caller   = agenttools.Caller{TenantID: "t1", APIKeyID: "k1", Surface: agenttools.SurfaceMCP}
)

func TestGovernor_CheckQuota(t *testing.T) {
	ctx := context.Background()
	// Native MCP quota enforcement is structurally held: the HTTP recorder
	// cannot authoritatively attribute the inner tool name, so even a stale
	// configured denial must not masquerade as a security boundary.
	calls := 0
	g := New(Deps{Quotas: fakeQuota{exceeded: true, calls: &calls}})
	if err := g.CheckQuota(ctx, caller, readTool); err != nil {
		t.Fatalf("held native quota must be advisory, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("held native quota consulted legacy rows %d times", calls)
	}

	// A non-MCP surface retains the legacy behavior until it is separately
	// migrated to an authoritative reservation ledger.
	agentCaller := caller
	agentCaller.Surface = agenttools.SurfaceAgent
	// exceeded -> policy denial sentinel
	g = New(Deps{Quotas: fakeQuota{exceeded: true}})
	if err := g.CheckQuota(ctx, agentCaller, readTool); !errors.Is(err, agenttools.ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	// infra error -> NOT the sentinel (Execute classifies as OutcomeError)
	g = New(Deps{Quotas: fakeQuota{err: errors.New("db down")}})
	if err := g.CheckQuota(ctx, agentCaller, readTool); err == nil || errors.Is(err, agenttools.ErrQuotaExceeded) {
		t.Fatalf("infra error must be a non-sentinel error, got %v", err)
	}
	// no checker -> permit
	if err := New(Deps{}).CheckQuota(ctx, caller, readTool); err != nil {
		t.Fatalf("nil quota checker should permit, got %v", err)
	}
}

func TestGovernor_AuthorizeSend(t *testing.T) {
	ctx := context.Background()
	// SendsPerDay=0 with the +1 increment -> exceeded
	g := New(Deps{Budgets: &fakeBudget{budget: &budgets.Budget{SendsPerDay: ptr(0)}}})
	if err := g.AuthorizeSend(ctx, caller, sendTool); !errors.Is(err, agenttools.ErrBudgetExceeded) {
		t.Fatalf("want ErrBudgetExceeded, got %v", err)
	}
	// generous budget -> permit
	g = New(Deps{Budgets: &fakeBudget{budget: &budgets.Budget{SendsPerDay: ptr(1000)}}})
	if err := g.AuthorizeSend(ctx, caller, sendTool); err != nil {
		t.Fatalf("within-budget send should be allowed, got %v", err)
	}
	// no budget repo -> permit
	if err := New(Deps{}).AuthorizeSend(ctx, caller, sendTool); err != nil {
		t.Fatalf("nil budget should permit, got %v", err)
	}
}

func TestGovernor_ScrubResultRemovesSubscriberPII(t *testing.T) {
	g := New(Deps{})
	result, err := g.ScrubResult(context.Background(), caller, readTool, map[string]any{
		"subscriber": map[string]any{
			"id":            "opaque-id",
			"email":         "person@example.test",
			"name":          "Sensitive Person",
			"merge_fields":  map[string]any{"FNAME": "Sensitive"},
			"custom_fields": map[string]any{"home": "1 Private Road"},
		},
		"note": "contact person@example.test or +1 (555) 123-4567",
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, leaked := range []string{"person@example.test", "Sensitive Person", "1 Private Road", "555", "FNAME"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("scrubbed result leaked %q: %s", leaked, text)
		}
	}
	if !strings.Contains(text, "opaque-id") || !strings.Contains(text, redactedLLMValue) {
		t.Fatalf("scrubbed result lost safe identity or redaction marker: %s", text)
	}
}

func TestGovernor_AuditChargesSendOnSuccess(t *testing.T) {
	ctx := context.Background()
	fb := &fakeBudget{budget: &budgets.Budget{SendsPerDay: ptr(1000)}}
	g := New(Deps{Budgets: fb})

	// Successful send tool -> one increment.
	_ = g.Audit(ctx, caller, sendTool, agenttools.OutcomeOK, 5)
	if fb.incs != 1 {
		t.Fatalf("successful send should charge 1, got %d", fb.incs)
	}
	// Failed send tool -> no charge.
	_ = g.Audit(ctx, caller, sendTool, agenttools.OutcomeError, 5)
	if fb.incs != 1 {
		t.Fatalf("failed send must not charge, got %d", fb.incs)
	}
	// Read tool -> no charge ever.
	_ = g.Audit(ctx, caller, readTool, agenttools.OutcomeOK, 5)
	if fb.incs != 1 {
		t.Fatalf("read tool must not charge, got %d", fb.incs)
	}
}

func TestGovernor_RequireApprovalNoServicePermits(t *testing.T) {
	pending, ref, err := New(Deps{}).RequireApproval(context.Background(), caller,
		&agenttools.ToolSpec{Name: "x", WriteTier: true, Annotations: agenttools.Annotations{Destructive: true}}, nil)
	if err != nil || pending || ref != "" {
		t.Fatalf("no approvals service should permit (not pending), got pending=%v ref=%q err=%v", pending, ref, err)
	}
}

func TestGovernor_ScrubResultRedactsDirectPII(t *testing.T) {
	in := map[string]any{"email": "a@b.com"}
	out, err := New(Deps{}).ScrubResult(context.Background(), caller, readTool, in)
	if err != nil {
		t.Fatalf("scrub should not error: %v", err)
	}
	m, _ := out.(map[string]any)
	if m["email"] != redactedLLMValue {
		t.Fatalf("direct email was not redacted; got %v", out)
	}
}

func TestGovernor_SatisfiesInterface(t *testing.T) {
	var _ agenttools.Governor = New(Deps{})
}
