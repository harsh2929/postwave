package views

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type fakeKillSwitch struct {
	gotTenant, gotActor, gotReason string
	gotPaused                      bool
	err                            error
}

func (f *fakeKillSwitch) SetPaused(_ context.Context, tenantID string, paused bool, reason, actor string) error {
	f.gotTenant, f.gotPaused, f.gotReason, f.gotActor = tenantID, paused, reason, actor
	return f.err
}

func reqWithTenant(t *testing.T, id, body string) *http.Request {
	t.Helper()
	r := httptest.NewRequest("POST", "/views/tenants/"+id+"/kill-switch", strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestKillSwitchHandler_PausesTargetTenantAndAudits(t *testing.T) {
	sw := &fakeKillSwitch{}
	var auditedEvent string
	var auditedFields map[string]any
	audit := func(_ context.Context, event string, fields map[string]any) error {
		auditedEvent, auditedFields = event, fields
		return nil
	}
	operator := func(_ context.Context) string { return "ops@moosewave.com" }

	h := KillSwitchHandler(sw, audit, operator)
	w := httptest.NewRecorder()
	h(w, reqWithTenant(t, testIncidentID, `{"paused":true,"reason":"abuse report"}`))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if sw.gotTenant != testIncidentID || !sw.gotPaused || sw.gotReason != "abuse report" {
		t.Fatalf("setter got wrong args: %+v", sw)
	}
	// The operator's identity must reach the mutation (actor) AND the audit lane.
	if sw.gotActor != "ops@moosewave.com" {
		t.Errorf("actor = %q, want the operator email", sw.gotActor)
	}
	if auditedEvent != "ops.tenant.sending_paused" {
		t.Errorf("audit event = %q", auditedEvent)
	}
	if auditedFields["tenant_id"] != testIncidentID || auditedFields["paused"] != true {
		t.Errorf("audit fields incomplete: %+v", auditedFields)
	}
}

func TestKillSwitchHandler_SetterErrorIs500(t *testing.T) {
	h := KillSwitchHandler(&fakeKillSwitch{err: context.DeadlineExceeded},
		func(context.Context, string, map[string]any) error { return nil },
		func(context.Context) string { return "ops@x.com" })
	w := httptest.NewRecorder()
	h(w, reqWithTenant(t, testIncidentID, `{"paused":true,"reason":"containment"}`))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("a failed mutation must be 500, got %d", w.Code)
	}
}

func TestKillSwitchHandler_RejectsMissingTenant(t *testing.T) {
	h := KillSwitchHandler(&fakeKillSwitch{},
		func(context.Context, string, map[string]any) error { return nil },
		func(context.Context) string { return "ops@x.com" })
	w := httptest.NewRecorder()
	h(w, reqWithTenant(t, "", `{"paused":true}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing tenant id must be 400, got %d", w.Code)
	}
}

func TestKillSwitchHandler_StrictBodyAndIdentity(t *testing.T) {
	tests := []struct {
		name string
		id   string
		body string
		want int
	}{
		{name: "malformed uuid", id: "tenant-123", body: `{"paused":true,"reason":"x"}`, want: http.StatusBadRequest},
		{name: "uuid is canonical", id: strings.ToUpper(testIncidentID), body: `{"paused":true,"reason":"x"}`, want: http.StatusBadRequest},
		{name: "paused omitted", id: testIncidentID, body: `{"reason":"x"}`, want: http.StatusBadRequest},
		{name: "reason omitted", id: testIncidentID, body: `{"paused":true}`, want: http.StatusBadRequest},
		{name: "unknown field", id: testIncidentID, body: `{"paused":true,"reason":"x","extra":1}`, want: http.StatusBadRequest},
		{name: "disallowed reason control", id: testIncidentID, body: `{"paused":true,"reason":"x\u0000y"}`, want: http.StatusBadRequest},
		{name: "trailing json", id: testIncidentID, body: `{"paused":true,"reason":"x"}{}`, want: http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sw := &fakeKillSwitch{}
			w := httptest.NewRecorder()
			KillSwitchHandler(sw, noopAudit, fixedOperator)(w, reqWithTenant(t, tc.id, tc.body))
			if w.Code != tc.want || sw.gotTenant != "" {
				t.Fatalf("status=%d want=%d mutation=%q body=%s", w.Code, tc.want, sw.gotTenant, w.Body.String())
			}
			assertViewHeaders(t, w)
		})
	}

	sw := &fakeKillSwitch{}
	w := httptest.NewRecorder()
	KillSwitchHandler(sw, noopAudit, func(context.Context) string { return "" })(w,
		reqWithTenant(t, testIncidentID, `{"paused":true,"reason":"x"}`))
	if w.Code != http.StatusInternalServerError || sw.gotTenant != "" {
		t.Fatalf("missing operator must fail closed: %d %+v", w.Code, sw)
	}
}
