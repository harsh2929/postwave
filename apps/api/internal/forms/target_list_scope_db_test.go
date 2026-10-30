// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Listmonk is shared by every workspace and forms write to it as a super
// admin, so a list id proves nothing about ownership. A form may only target
// a list that list_id_map maps under its own tenant.
func TestAFormCannotTargetAnotherWorkspacesList(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, status: StatusDraft})
	ownList := h.mapList(7)
	otherTenant := uuid.NewString()
	other := &signupHarness{t: t, pool: h.pool, tenantID: otherTenant}
	other.seedTenant()
	mapListForTenant(t, h.pool, otherTenant, 42)

	patch := func(settings string) (int, string) {
		rec := h.serve(http.MethodPatch, "/api/v1/forms/"+h.formID, `{"settings":`+settings+`}`)
		return rec.Code, rec.Body.String()
	}
	for _, foreign := range []string{`{"targetListId":"42"}`, `{"targetListId":1}`} {
		code, resp := patch(foreign)
		if code != http.StatusBadRequest || !strings.Contains(resp, `"code":"invalid_target_list"`) ||
			!strings.Contains(resp, "That list isn't available in this workspace. Choose one of your lists.") {
			t.Fatalf("PATCH %s = %d %s, want 400 invalid_target_list", foreign, code, resp)
		}
	}
	if n := h.count(`SELECT count(*) FROM forms WHERE id = $1::uuid AND settings ? 'targetListId'`, h.formID); n != 0 {
		t.Fatal("a refused target list was saved")
	}
	if code, resp := patch(`{"targetListId":"7"}`); code != http.StatusOK {
		t.Fatalf("PATCH with the workspace's own list = %d %s", code, resp)
	}
	_ = ownList

	// A form saved before this check could still carry a foreign target;
	// publishing it is refused too.
	h.exec(`UPDATE forms SET settings = '{"targetListId":"42"}'::jsonb WHERE id = $1::uuid`, h.formID)
	rec := h.serve(http.MethodPatch, "/api/v1/forms/"+h.formID, `{"status":"published"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_target_list"`) {
		t.Fatalf("publishing with a foreign target = %d %s, want 400", rec.Code, rec.Body.String())
	}
}

// A published form that already targets a foreign list (saved before the
// check above existed) refuses submissions before anything is written or
// sent anywhere.
func TestAPublishedFormWithAForeignTargetWritesNothingAnywhere(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{"targetListId": "42"}})
	otherTenant := uuid.NewString()
	other := &signupHarness{t: t, pool: h.pool, tenantID: otherTenant}
	other.seedTenant()
	mapListForTenant(t, h.pool, otherTenant, 42)

	rec := h.post(body(consentedBody, "visitor@example.com"))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"code":"invalid_target_list"`) ||
		!strings.Contains(rec.Body.String(), "This form is temporarily misconfigured. Please contact its owner.") {
		t.Fatalf("submit = %d %s, want 422 invalid_target_list", rec.Code, rec.Body.String())
	}
	if n := h.count(`SELECT count(*) FROM form_submissions WHERE form_id = $1::uuid`, h.formID); n != 0 {
		t.Fatalf("form_submissions = %d, want none", n)
	}
	if n := len(h.outbox.appends); n != 0 {
		t.Fatalf("outbox appends = %d, want none", n)
	}
	if n := len(h.engine.Requests()); n != 0 {
		t.Fatalf("Listmonk requests = %d, want none", n)
	}
	if !strings.Contains(h.logs.String(), "target list is not usable") || !strings.Contains(h.logs.String(), h.formID) {
		t.Fatalf("the operator log line is missing:\n%s", h.logs.String())
	}
}
