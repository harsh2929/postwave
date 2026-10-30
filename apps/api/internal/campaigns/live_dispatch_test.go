package campaigns

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

type testSandboxLifecycle struct{}

func (testSandboxLifecycle) SimulateCampaignLifecycle(context.Context, string, string, int, time.Time) error {
	return nil
}

type schedulerFinderProbe struct{ calls int }

func (p *schedulerFinderProbe) FindDueScheduled(context.Context, int) ([]ScheduledCampaign, error) {
	p.calls++
	return nil, nil
}

type transactionalSenderProbe struct{ calls int }

func (p *transactionalSenderProbe) SendTransactional(context.Context, listmonk.SendTransactionalReq) error {
	p.calls++
	return nil
}

type sandboxAuthorityProbe struct {
	setErr    error
	getErr    error
	value     bool
	setCalls  int
	lastValue bool
	getCalls  int
}

func (p *sandboxAuthorityProbe) SetSandboxFlag(_ context.Context, _, _ string, sandbox bool) error {
	p.setCalls++
	p.lastValue = sandbox
	return p.setErr
}

func (p *sandboxAuthorityProbe) GetSandboxFlag(context.Context, string, string) (bool, error) {
	p.getCalls++
	return p.value, p.getErr
}

func TestQueueDispatchGateReturnsStableDisabledAndUnavailableResponses(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		gate dispatchcontrol.Gate
		want int
		code string
	}{
		{name: "missing defaults closed", want: http.StatusLocked, code: "campaign_live_dispatch_disabled"},
		{name: "policy unavailable", gate: dispatchcontrol.GateFunc(func(context.Context, string) error {
			return errors.New("policy backend down")
		}), want: http.StatusServiceUnavailable, code: "campaign_live_dispatch_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			req := campaignTenantRequest(http.MethodPost, "/api/v1/campaigns/c1/queue", "")
			(&Deps{LiveDispatch: tc.gate}).QueueCampaign(rec, req)
			if rec.Code != tc.want || !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("response = (%d, %s), want status=%d code=%s", rec.Code, rec.Body.String(), tc.want, tc.code)
			}
		})
	}
}

func TestSandboxQueueBypassRequiresConfiguredLifecycle(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	if got := (&Deps{LiveDispatch: dispatchcontrol.StaticGate{Enabled: true}}).
		authorizeQueueDispatch(ctx, "tenant-1", false); got != nil {
		t.Fatalf("explicitly enabled non-sandbox dispatch was rejected: %v", got)
	}
	if got := (&Deps{LiveDispatch: dispatchcontrol.StaticGate{Enabled: true}}).
		authorizeQueueDispatch(ctx, "tenant-1", true); got == nil || got.Code != "sandbox_unavailable" {
		t.Fatalf("sandbox without lifecycle = %#v, want sandbox_unavailable", got)
	}
	if got := (&Deps{Sandbox: testSandboxLifecycle{}}).
		authorizeQueueDispatch(ctx, "tenant-1", true); got != nil {
		t.Fatalf("configured sandbox lifecycle did not bypass live gate: %v", got)
	}
	if got := (&Deps{Sandbox: testSandboxLifecycle{}}).
		authorizeQueueDispatch(ctx, "tenant-1", false); got == nil || got.Code != "campaign_live_dispatch_disabled" {
		t.Fatalf("sandbox dependency bypassed a non-sandbox send: %#v", got)
	}

	// sandbox_unavailable is a deliberate public 503 policy contract, not an
	// unknown infrastructure failure that may be sanitized to internal_error.
	req := campaignTenantRequest(http.MethodPost, "/api/v1/campaigns/c1/queue", "")
	req = req.WithContext(sandbox.WithFlag(req.Context()))
	rec := httptest.NewRecorder()
	(&Deps{}).QueueCampaign(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"sandbox_unavailable"`) {
		t.Fatalf("sandbox policy response=(%d,%s), want stable sandbox_unavailable", rec.Code, rec.Body.String())
	}
}

func TestSandboxAuthorityPersistenceFailureIsFatal(t *testing.T) {
	t.Parallel()

	probe := &sandboxAuthorityProbe{setErr: errors.New("database unavailable")}
	deps := &Deps{SandboxAuthority: probe}
	err := deps.persistCampaignSandboxAuthority(context.Background(), "tenant-1", "campaign-1", true)
	if err == nil || !strings.Contains(err.Error(), "persist campaign sandbox authority") {
		t.Fatalf("persistence error=%v, want fatal wrapped error", err)
	}
	if probe.setCalls != 1 || !probe.lastValue {
		t.Fatalf("sandbox authority write calls=%d value=%v, want one true write", probe.setCalls, probe.lastValue)
	}
	if !isPublicQueuePolicyError("sandbox_authority_unavailable") {
		t.Fatal("sandbox authority failure must remain a stable public policy error")
	}
}

func TestSandboxAuthorityReadsUseInjectedDurableStore(t *testing.T) {
	t.Parallel()

	probe := &sandboxAuthorityProbe{value: true}
	got, err := (&Deps{SandboxAuthority: probe}).loadCampaignSandboxAuthority(
		context.Background(), "tenant-1", "campaign-1",
	)
	if err != nil || !got || probe.getCalls != 1 {
		t.Fatalf("authority read=(%v,%v) calls=%d, want true,nil,1", got, err, probe.getCalls)
	}
}

func TestBackgroundQueuePathsFailWhenSandboxAuthorityCannotBeRead(t *testing.T) {
	t.Parallel()

	deps := &Deps{LiveDispatch: dispatchcontrol.StaticGate{Enabled: true}}
	if _, err := deps.QueueScheduledCampaign(context.Background(), "tenant-1", "campaign-1"); err == nil {
		t.Fatal("scheduled queue accepted missing sandbox authority")
	}
	if _, err := deps.QueueApprovedCampaign(context.Background(), "tenant-1", "campaign-1"); err == nil {
		t.Fatal("approval queue accepted missing sandbox authority")
	}
	if _, err := deps.QueueCampaignForAgent(context.Background(), "tenant-1", "campaign-1", "agent"); err == nil {
		t.Fatal("agent queue accepted missing sandbox authority")
	}
}

func TestLegacySchedulerCannotClaimRowsBeforeCompileTimeRecoveryQualification(t *testing.T) {
	t.Parallel()

	if LegacySchedulerDurableClaimRecoveryQualified {
		t.Fatal("test must be replaced with an enabled claim-to-dispatch recovery test before qualifying the scheduler")
	}
	finder := &schedulerFinderProbe{}
	scheduler := &Scheduler{Base: &Deps{}, Pool: finder}
	scheduler.tickOnce(context.Background())
	if finder.calls != 0 {
		t.Fatalf("disabled scheduler claimed due campaigns %d times", finder.calls)
	}

	scheduler.Base.LiveDispatch = dispatchcontrol.StaticGate{Enabled: true}
	scheduler.tickOnce(context.Background())
	if finder.calls != 0 {
		t.Fatalf("live gate bypassed compile-time scheduler lock; finder calls = %d", finder.calls)
	}
}

func TestRecurrenceConfigurationCannotBypassSchedulingQualification(t *testing.T) {
	t.Parallel()

	req := campaignTenantRequest(http.MethodPost, "/api/v1/campaigns/c1/recurrence",
		`{"recurrence_cron":"0 9 * * *"}`)
	rec := httptest.NewRecorder()
	(&Deps{
		LiveDispatch:                    dispatchcontrol.StaticGate{Enabled: true},
		ScheduledMaterializationEnabled: true,
	}).SetRecurrence(rec, req)
	if rec.Code != http.StatusServiceUnavailable ||
		!strings.Contains(rec.Body.String(), `"code":"campaign_scheduling_unqualified"`) {
		t.Fatalf("response=(%d,%s), want compile-time scheduling policy failure before repository access",
			rec.Code, rec.Body.String())
	}
}

func TestCampaignTestSendRequiresLiveGateAndRejectsSandboxTraffic(t *testing.T) {
	t.Parallel()

	validBody := `{"to_email":"reviewer@example.test","subject":"Review","body_html":"<p>Review</p>"}`
	for _, tc := range []struct {
		name    string
		gate    dispatchcontrol.Gate
		sandbox bool
		want    int
		code    string
		calls   int
	}{
		{name: "missing gate defaults closed", want: http.StatusLocked, code: "campaign_live_dispatch_disabled"},
		{name: "policy unavailable", gate: dispatchcontrol.GateFunc(func(context.Context, string) error {
			return errors.New("policy backend down")
		}), want: http.StatusServiceUnavailable, code: "campaign_live_dispatch_unavailable"},
		{name: "sandbox cannot reach real transport", gate: dispatchcontrol.StaticGate{Enabled: true}, sandbox: true,
			want: http.StatusServiceUnavailable, code: "sandbox_unavailable"},
		{name: "explicit live enablement", gate: dispatchcontrol.StaticGate{Enabled: true},
			want: http.StatusAccepted, calls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			sender := &transactionalSenderProbe{}
			req := campaignTenantRequest(http.MethodPost, "/api/v1/campaigns/test-send", validBody)
			if tc.sandbox {
				req = req.WithContext(sandbox.WithFlag(req.Context()))
			}
			rec := httptest.NewRecorder()
			(&Deps{LiveDispatch: tc.gate, Sender: sender}).TestSend(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tc.want, rec.Body.String())
			}
			if tc.code != "" && !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("response lacks code %q: %s", tc.code, rec.Body.String())
			}
			if sender.calls != tc.calls {
				t.Fatalf("transport calls = %d, want %d", sender.calls, tc.calls)
			}
		})
	}
}

func TestCampaignTestSendRoutesRequireWriteAndSendScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountWrite(router, &Deps{})
	for _, path := range []string{
		"/api/v1/campaigns/test-send",
		"/api/v1/campaigns/c1/test-send",
	} {
		for _, partial := range [][]apikeys.Scope{
			{apikeys.ScopeWriteCampaigns},
			{apikeys.ScopeSendTransactional},
		} {
			rec := serveCampaignAPIKeyRoute(router, path, "", partial, true)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s scopes=%v status=%d, want 403; body=%s", path, partial, rec.Code, rec.Body.String())
			}
		}
		rec := serveCampaignAPIKeyRoute(router, path, "", []apikeys.Scope{
			apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional,
		}, true)
		if rec.Code != http.StatusLocked || !strings.Contains(rec.Body.String(), "campaign_live_dispatch_disabled") {
			t.Errorf("%s full scopes did not reach live gate: status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestSendDomainRiskIncreasingRoutesRequireWriteAndSendScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountSendDomain(router, &Deps{})
	routes := []struct {
		path string
		body string
	}{
		{path: "/api/v1/campaigns/c1/resend-to-non-openers", body: `{}`},
		{path: "/api/v1/campaigns/c1/recurrence", body: `{"recurrence_cron":"0 9 * * *"}`},
		{path: "/api/v1/campaigns/c1/resume"},
	}
	for _, route := range routes {
		for _, partial := range [][]apikeys.Scope{
			{apikeys.ScopeWriteCampaigns},
			{apikeys.ScopeSendTransactional},
		} {
			rec := serveCampaignAPIKeyRoute(router, route.path, route.body, partial, true)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s scopes=%v status=%d, want 403; body=%s", route.path, partial, rec.Code, rec.Body.String())
			}
		}
		rec := serveCampaignAPIKeyRoute(router, route.path, route.body, []apikeys.Scope{
			apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional,
		}, true)
		if rec.Code != http.StatusLocked || !strings.Contains(rec.Body.String(), "campaign_live_dispatch_disabled") {
			t.Errorf("%s full scopes did not reach live gate: status=%d body=%s", route.path, rec.Code, rec.Body.String())
		}
	}
}

func TestResendToNonOpenersCannotBypassCampaignAssuranceGate(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountSendDomain(router, &Deps{AssuranceGateEnabled: true})
	rec := serveCampaignAPIKeyRoute(router,
		"/api/v1/campaigns/c1/resend-to-non-openers", `{}`,
		[]apikeys.Scope{apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional}, true)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"campaign_assurance_required_for_resend"`) {
		t.Fatalf("response did not disclose clone-specific assurance requirement: %s", rec.Body.String())
	}
}

func TestResendToNonOpenersDirectEnqueueIsDisabledForEveryActiveRolloutMode(t *testing.T) {
	t.Parallel()
	for _, mode := range []campaignassurancegate.RolloutMode{
		campaignassurancegate.RolloutShadow,
		campaignassurancegate.RolloutWarn,
		campaignassurancegate.RolloutBlock,
	} {
		mode := mode
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()
			router := chi.NewRouter()
			MountSendDomain(router, &Deps{AssuranceGate: &stagedAssuranceGateProbe{
				assuranceGateProbe: &assuranceGateProbe{}, mode: mode,
			}})
			rec := serveCampaignAPIKeyRoute(router,
				"/api/v1/campaigns/c1/resend-to-non-openers", `{}`,
				[]apikeys.Scope{apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional}, true)
			if rec.Code != http.StatusConflict ||
				!strings.Contains(rec.Body.String(), `"code":"campaign_assurance_required_for_resend"`) {
				t.Fatalf("response=(%d,%s), want governed clone workflow", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPauseAndCancelRemainAvailableToWriteCampaignScope(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountSendDomain(router, &Deps{})
	for _, path := range []string{
		"/api/v1/campaigns/c1/pause",
		"/api/v1/campaigns/c1/cancel",
	} {
		if rec := serveCampaignAPIKeyRoute(router, path, "", []apikeys.Scope{apikeys.ScopeSendTransactional}, false); rec.Code != http.StatusForbidden {
			t.Errorf("%s send-only status=%d, want 403", path, rec.Code)
		}
		if rec := serveCampaignAPIKeyRoute(router, path, "", []apikeys.Scope{apikeys.ScopeWriteCampaigns}, false); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s write scope status=%d, want handler-level 401", path, rec.Code)
		}
	}
}

func serveCampaignAPIKeyRoute(router http.Handler, path, body string, scopes []apikeys.Scope, withTenant bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	if withTenant {
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	}
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
