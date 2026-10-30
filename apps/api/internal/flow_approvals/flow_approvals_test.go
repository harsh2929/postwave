// SPDX-License-Identifier: AGPL-3.0-only

package flow_approvals

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlers_RequireTenant(t *testing.T) {
	d := &Deps{}
	for _, h := range []struct {
		name string
		fn   http.HandlerFunc
	}{
		{"list", d.List},
		{"approve", d.Approve},
		{"reject", d.Reject},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/flow-builder/approvals", nil)
		h.fn(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: want 401 without tenant, got %d", h.name, rec.Code)
		}
	}
}
