// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The refusal has to reach the client as a conflict, not a 500.
//
// A new error in a repo is invisible until the handler maps it. Left unmapped,
// ErrCampaignDispatching falls through to httperror.WriteInternal — the operator
// sees "internal_error", learns nothing, retries, and it happens again.

func TestPatchOnADispatchedCampaignReturns409(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "dispatch-http")
	id := insertQueueableCampaignQ(t, pool, ctx, tenantID, "http-freeze")
	setStatusDirect(t, pool, ctx, tenantID, id, StatusSending, true)

	d := &Deps{Repo: &Repo{Pool: pool}}
	router := chi.NewRouter()
	router.Patch("/api/v1/campaigns/{id}", d.Update)

	req := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodPatch, "/api/v1/campaigns/"+id,
		strings.NewReader(`{"subject":"Corrected subject"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not the standard error envelope: %s", rec.Body.String())
	}
	if env.Error.Code != "campaign_dispatching" {
		t.Fatalf("code=%q body=%s, want a branchable campaign_dispatching", env.Error.Code, rec.Body.String())
	}
	if !strings.Contains(env.Error.Message, "duplicate") {
		t.Errorf("message=%q does not tell the operator what to do instead", env.Error.Message)
	}
}
