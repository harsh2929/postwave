// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A malformed ?source_template_id must be rejected with 400 BEFORE the repo
// is touched (TMPL-026), so a bad value can never reach the ::uuid cast and
// surface as a 500. Deps has a nil Repo here precisely to prove the guard
// short-circuits ahead of any DB call.
func TestList_RejectsMalformedSourceTemplateID(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.List(rec, campaignTenantRequest(http.MethodGet,
		"/api/v1/campaigns?source_template_id=not-a-uuid", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_source_template_id") {
		t.Errorf("body = %s, want invalid_source_template_id code", rec.Body.String())
	}
}
