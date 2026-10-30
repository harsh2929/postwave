package campaigns

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenericAuthoringRejectsDispatchOwnedState(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   string
		call   func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{
			name: "create status", method: http.MethodPost, path: "/api/v1/campaigns",
			body: `{"name":"Launch","subject":"Hello","status":"sent"}`,
			call: (*Deps).Create,
		},
		{
			name: "create schedule even null", method: http.MethodPost, path: "/api/v1/campaigns",
			body: `{"name":"Launch","subject":"Hello","scheduled_at":null}`,
			call: (*Deps).Create,
		},
		{
			name: "patch sent truth", method: http.MethodPatch, path: "/api/v1/campaigns/c1",
			body: `{"status":"sent"}`,
			call: (*Deps).Update,
		},
		{
			name: "patch schedule", method: http.MethodPatch, path: "/api/v1/campaigns/c1",
			body: `{"scheduled_at":"2030-01-01T12:00:00Z"}`,
			call: (*Deps).Update,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			tc.call(&Deps{}, rec, campaignTenantRequest(tc.method, tc.path, tc.body))
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if !strings.Contains(rec.Body.String(), `"code":"campaign_dispatch_state_owned"`) {
				t.Fatalf("response lacks stable lifecycle code: %s", rec.Body.String())
			}
		})
	}
}

func TestAuthoringConversionCannotCarryDispatchStateButInternalInputCan(t *testing.T) {
	t.Parallel()

	status := StatusSent
	scheduled := "2030-01-01T12:00:00Z"
	wire := updateAuthoringInput{
		Subject:     &status,
		Status:      json.RawMessage(`"sent"`),
		ScheduledAt: json.RawMessage(`"` + scheduled + `"`),
	}
	got := wire.repositoryInput()
	if got.Status != nil || got.ScheduledAt != nil {
		t.Fatalf("authoring conversion leaked dispatch state: %+v", got)
	}
	if got.Subject == nil || *got.Subject != status {
		t.Fatalf("authoring field was not preserved: %+v", got)
	}

	internal := UpdateInput{Status: &status}
	if err := normalizeUpdate(&internal); err != nil || internal.Status == nil || *internal.Status != StatusSent {
		t.Fatalf("internal transition input stopped accepting valid state: %+v, err=%v", internal, err)
	}
}

func TestGenericPatchRejectsWebhookOwnedSentTruth(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	(&Deps{}).Update(rec, campaignTenantRequest(
		http.MethodPatch,
		"/api/v1/campaigns/c1",
		`{"sent_at":"2030-01-01T12:00:00Z"}`,
	))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"unknown_field"`) {
		t.Fatalf("webhook-owned sent_at response = (%d, %s), want stable 400 unknown_field", rec.Code, rec.Body.String())
	}
}
