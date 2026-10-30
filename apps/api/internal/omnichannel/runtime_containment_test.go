package omnichannel

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

func omnichannelTenantRequest(method, body string) *http.Request {
	req := httptest.NewRequest(method, "/api/v1/omnichannel/campaigns/campaign-1/runtime", strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func assertOmnichannelRuntimeUnavailable(t *testing.T, recorder *httptest.ResponseRecorder) {
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
	if body.Error.Code != "omnichannel_runtime_unavailable" ||
		body.Error.Capability != "omnichannel_campaign_execution" ||
		body.Error.RuntimeStatus != "unavailable" || body.Error.Retryable {
		t.Fatalf("unexpected error contract: %+v", body.Error)
	}
}

func TestRuntimeMutationHandlersFailBeforeRepositoryAccess(t *testing.T) {
	deps := &Deps{} // nil Repo proves the boundary returns before persistence.
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"materialize": deps.Materialize,
		"evaluate":    deps.Evaluate,
		"dispatch":    deps.Dispatch,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			call(recorder, omnichannelTenantRequest(http.MethodPost, ""))
			assertOmnichannelRuntimeUnavailable(t, recorder)
		})
	}
}

func TestRuntimeMutationHandlersRemainAuthFirst(t *testing.T) {
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/omnichannel/campaigns/campaign-1/dispatch", nil)
	(&Deps{}).Dispatch(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestCreateCampaignRejectsOperationalStateBeforePersistence(t *testing.T) {
	cases := []string{
		`{"name":"scheduled","status":"scheduled","paths":[{"channel":"email","name":"Email"}]}`,
		`{"name":"ready path","status":"draft","paths":[{"channel":"email","name":"Email","status":"ready"}]}`,
		`{"name":"paused path","status":"draft","paths":[{"channel":"email","name":"Email","status":"paused"}]}`,
		`{"name":"cancelled path","status":"draft","paths":[{"channel":"email","name":"Email","status":"cancelled"}]}`,
		`{"name":"blocked path","status":"draft","paths":[{"channel":"email","name":"Email","status":"blocked"}]}`,
	}
	for _, body := range cases {
		recorder := httptest.NewRecorder()
		(&Deps{}).CreateCampaign(recorder, omnichannelTenantRequest(http.MethodPost, body))
		assertOmnichannelRuntimeUnavailable(t, recorder)
	}
}

func TestRequestsRuntimeStateAllowsOnlyNonOperationalDraftPaths(t *testing.T) {
	if requestsRuntimeState(OmniCampaign{Status: "draft", Paths: []CampaignPath{{Channel: "email", Status: "draft"}}}) {
		t.Fatal("draft authoring should remain available")
	}
	if !requestsRuntimeState(OmniCampaign{Status: "draft", Paths: []CampaignPath{{Channel: "email", Status: "sending"}}}) {
		t.Fatal("sending path must be contained")
	}
	for _, status := range []string{"ready", "scheduled", "sending", "sent", "paused", "cancelled", "blocked"} {
		if !requestsRuntimeState(OmniCampaign{Status: "draft", Paths: []CampaignPath{{Channel: "email", Status: status}}}) {
			t.Errorf("%s path must be contained", status)
		}
	}
}

func TestAnnotateCampaignRuntimeMakesExistingActiveRecordTruthful(t *testing.T) {
	campaign := &OmniCampaign{Status: "sending"}
	annotateCampaignRuntime(campaign)
	if campaign.Runtime == nil || campaign.Runtime.ExecutionEnabled || campaign.Runtime.RuntimeStatus != "unavailable" {
		t.Fatalf("runtime = %+v, want unavailable execution descriptor", campaign.Runtime)
	}
}

func TestRepositoryAndRuntimeSeamsFailBeforePoolAccess(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.CreateCampaign(context.Background(), "tenant-1", OmniCampaign{
		Name: "paused path", Status: "draft", Paths: []CampaignPath{{Channel: "email", Name: "Email", Status: "paused"}},
	}); !errors.Is(err, ErrOmnichannelRuntimeUnavailable) {
		t.Fatalf("CreateCampaign error = %v, want runtime unavailable", err)
	}
	for name, call := range map[string]func() error{
		"materialize": func() error {
			_, err := repo.Materialize(context.Background(), "tenant-1", "campaign-1")
			return err
		},
		"evaluate": func() error {
			_, err := repo.Evaluate(context.Background(), "tenant-1", "campaign-1")
			return err
		},
		"dispatch": func() error {
			_, err := repo.Dispatch(context.Background(), "tenant-1", "campaign-1", nil, 100)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := call(); !errors.Is(err, ErrOmnichannelRuntimeUnavailable) {
				t.Fatalf("error = %v, want runtime unavailable before pool access", err)
			}
		})
	}
}

func TestRuntimeQualificationIsCompileTimeClosedAndDescriptorMatches(t *testing.T) {
	if omnichannelRuntimeQualified {
		t.Fatal("omnichannel runtime must remain compile-time contained")
	}
	if omnichannelRuntime.ExecutionEnabled != omnichannelRuntimeQualified || omnichannelRuntime.RuntimeStatus != "unavailable" {
		t.Fatalf("descriptor = %+v, gate=%v", omnichannelRuntime, omnichannelRuntimeQualified)
	}
}
