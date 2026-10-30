package trigger_delay

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

func triggerDelayTenantRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func assertTriggerDelayError(t *testing.T, recorder *httptest.ResponseRecorder, code string) {
	t.Helper()
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != code {
		t.Fatalf("error code = %q, want %q", body.Error.Code, code)
	}
}

func TestHandlersRejectNonUUIDSubscriberBeforeRepositoryAccess(t *testing.T) {
	deps := &Deps{Repo: &Repo{}}
	getRecorder := httptest.NewRecorder()
	deps.get(getRecorder, triggerDelayTenantRequest(
		http.MethodGet,
		"/api/v1/trigger-delay/preferences?subscriber_id=sub_demo&event_name=cart.abandoned",
		"",
	))
	assertTriggerDelayError(t, getRecorder, "invalid_subscriber_id")

	putRecorder := httptest.NewRecorder()
	deps.put(putRecorder, triggerDelayTenantRequest(
		http.MethodPut,
		"/api/v1/trigger-delay/preferences",
		`{"subscriber_id":"sub_demo","event_name":"cart.abandoned","optimal_delay_seconds":120}`,
	))
	assertTriggerDelayError(t, putRecorder, "invalid_subscriber_id")
}

func TestPublicOverrideRejectsForgedLearningMetadata(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Deps{Repo: &Repo{}}).put(recorder, triggerDelayTenantRequest(
		http.MethodPut,
		"/api/v1/trigger-delay/preferences",
		`{"subscriber_id":"550e8400-e29b-41d4-a716-446655440000","event_name":"cart.abandoned","optimal_delay_seconds":120,"confidence":0.99}`,
	))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want strict 400; body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPublicOverrideBoundsOperatorStringsBeforeRepositoryAccess(t *testing.T) {
	for name, body := range map[string]string{
		"event":  `{"subscriber_id":"550e8400-e29b-41d4-a716-446655440000","event_name":"` + strings.Repeat("e", maxTriggerDelayEventNameBytes+1) + `","optimal_delay_seconds":120}`,
		"reason": `{"subscriber_id":"550e8400-e29b-41d4-a716-446655440000","event_name":"cart.abandoned","optimal_delay_seconds":120,"reason":"` + strings.Repeat("r", maxTriggerDelayReasonBytes+1) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			(&Deps{Repo: &Repo{}}).put(recorder, triggerDelayTenantRequest(
				http.MethodPut,
				"/api/v1/trigger-delay/preferences",
				body,
			))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestRepositoryRejectsNonUUIDSubscriberBeforePoolAccess(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.GetPreference(context.Background(), "tenant-1", "sub_demo", "cart.abandoned"); !errors.Is(err, errInvalidSubscriberID) {
		t.Fatalf("GetPreference error = %v, want invalid subscriber id", err)
	}
	if _, err := repo.UpsertPreference(context.Background(), "tenant-1", upsertInput{SubscriberID: "sub_demo"}); !errors.Is(err, errInvalidSubscriberID) {
		t.Fatalf("UpsertPreference error = %v, want invalid subscriber id", err)
	}
}

func TestCanonicalSubscriberID(t *testing.T) {
	got, ok := canonicalSubscriberID(" 550E8400-E29B-41D4-A716-446655440000 ")
	if !ok || got != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("canonicalSubscriberID = %q, %v", got, ok)
	}
}

func TestPreferenceViewOmitsTenantIdentity(t *testing.T) {
	raw, err := json.Marshal(preferenceView(&Preference{
		TenantID:     "tenant-secret",
		SubscriberID: "550e8400-e29b-41d4-a716-446655440000",
		EventName:    "cart.abandoned",
	}))
	if err != nil {
		t.Fatalf("marshal preference view: %v", err)
	}
	if strings.Contains(string(raw), "tenant-secret") || strings.Contains(string(raw), "tenant_id") {
		t.Fatalf("preference view leaked tenant identity: %s", raw)
	}
}
