// SPDX-License-Identifier: AGPL-3.0-only
package onboarding_progress

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// An onboarding decision belongs to a person, not to a device.
//
// `GET /api/v1/onboarding-progress` derives done-ness server-side, which is
// already shared. Everything a human DECIDED — dismissed, snoozed, skipped —
// lived in per-device keys (`postwave_onboarding_checklist_dismissed` and
// friends). So dismissing the checklist on desktop, opening web, and seeing it
// again was the designed behaviour: the product re-asked on every device until
// the answer was given on every device.

func newStepStatePool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedStepStateTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'onboarding', 'studio')`,
		tenantID, "onb-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		c, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(context.Background()) }()
		for _, q := range []string{
			`DELETE FROM onboarding_step_state WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(context.Background(), q, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(context.Background())
	})
	return tenantID
}

func stepStateRequest(t *testing.T, method, tenantID, userID, body string) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/v1/onboarding/steps", nil)
	} else {
		r = httptest.NewRequest(method, "/api/v1/onboarding/steps", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID, Slug: "acme", Tier: "studio"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: userID})
	return r.WithContext(ctx)
}

func TestADismissalSurvivesAcrossDevices(t *testing.T) {
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	userID := uuid.NewString()
	d := &Deps{Pool: pool}

	// "Desktop" dismisses.
	rec := httptest.NewRecorder()
	d.PutStepState(rec, stepStateRequest(t, http.MethodPut, tenantID, userID,
		`{"step_key":"connect_domain","state":"dismissed"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("dismiss returned %d: %s", rec.Code, rec.Body.String())
	}

	// "Web", a different client entirely, asks the server.
	rec = httptest.NewRecorder()
	d.GetStepStates(rec, stepStateRequest(t, http.MethodGet, tenantID, userID, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("get returned %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Steps map[string]struct {
			State  string `json:"state"`
			Reason string `json:"reason,omitempty"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v (%s)", err, rec.Body.String())
	}
	if body.Steps["connect_domain"].State != "dismissed" {
		t.Fatalf("the second device sees %q. A decision made on one device must "+
			"not be re-asked on the next — that is the whole defect.",
			body.Steps["connect_domain"].State)
	}
}

func TestOneUsersDismissalDoesNotHideTheStepFromAColleague(t *testing.T) {
	// Per-user, not per-tenant. Making it tenant-wide would let the first admin
	// to click "dismiss" decide for everyone — a different and worse bug than
	// the one being fixed.
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	alice, bob := uuid.NewString(), uuid.NewString()
	d := &Deps{Pool: pool}

	rec := httptest.NewRecorder()
	d.PutStepState(rec, stepStateRequest(t, http.MethodPut, tenantID, alice,
		`{"step_key":"connect_domain","state":"dismissed"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("alice dismiss: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	d.GetStepStates(rec, stepStateRequest(t, http.MethodGet, tenantID, bob, ""))
	var body struct {
		Steps map[string]any `json:"steps"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if _, hidden := body.Steps["connect_domain"]; hidden {
		t.Fatal("one user's dismissal hid the step from a colleague who has never " +
			"seen it")
	}
}

func TestASkipCarriesItsReason(t *testing.T) {
	// "not now" and "not us" are different answers, and only the second should
	// stay gone. The reason is what lets a later prompt know which it was.
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	userID := uuid.NewString()
	d := &Deps{Pool: pool}

	rec := httptest.NewRecorder()
	d.PutStepState(rec, stepStateRequest(t, http.MethodPut, tenantID, userID,
		`{"step_key":"import_contacts","state":"skipped","reason":"we use Salesforce for this"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("skip: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	d.GetStepStates(rec, stepStateRequest(t, http.MethodGet, tenantID, userID, ""))
	var body struct {
		Steps map[string]struct {
			State  string `json:"state"`
			Reason string `json:"reason,omitempty"`
		} `json:"steps"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if got := body.Steps["import_contacts"]; got.State != "skipped" || got.Reason == "" {
		t.Fatalf("skip lost its reason: %+v", got)
	}
}

func TestAnUnknownStateIsRefused(t *testing.T) {
	// The vocabulary is closed so a client cannot invent a state the other two
	// surfaces will not understand — which is how one shared fact becomes three.
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	d := &Deps{Pool: pool}

	rec := httptest.NewRecorder()
	d.PutStepState(rec, stepStateRequest(t, http.MethodPut, tenantID, uuid.NewString(),
		`{"step_key":"connect_domain","state":"snoozed_until_tuesday"}`))
	// The exact status and code, not merely "not 200".
	//
	// The DB CHECK also rejects an unknown state, so a handler with no
	// validation still refuses — with a 500 "an internal error occurred" instead
	// of a 400 naming the permitted values. A mutation removing the handler
	// check passed until this distinguished them, and the difference is what a
	// client integrator actually sees.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400. A database CHECK refusing this produces a "+
			"500 that tells an integrator nothing. body=%s", rec.Code, rec.Body.String())
	}
	var errBody struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &errBody)
	if errBody.Error.Code != "invalid_state" {
		t.Errorf("code = %q, want invalid_state", errBody.Error.Code)
	}
	if !strings.Contains(errBody.Error.Message, "dismissed") {
		t.Errorf("the refusal does not name the permitted values: %q", errBody.Error.Message)
	}
}
