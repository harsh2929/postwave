// SPDX-License-Identifier: AGPL-3.0-only
package stepup

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

// A stale possession proof must not authorise a sensitive action.
//
// `auth_sessions.mfa_satisfied` is set once at login and never expires — the
// codebase says so itself, in recovery_codes.go, and that endpoint solved it by
// bypassing the flag rather than asking it a question. These tests are about
// the question finally being askable.

func TestAFreshProofSatisfiesAndAStaleOneDoesNot(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	req := Requirement{Action: "x", MaxAge: Immediate}

	if !req.Satisfied(now.Add(-time.Minute), now) {
		t.Error("a proof from a minute ago was rejected; the prompt would fire " +
			"mid-flow and people would learn to click through it")
	}
	if !req.Satisfied(now.Add(-Immediate), now) {
		t.Error("a proof exactly at the boundary was rejected; an off-by-one here " +
			"is a prompt that appears a second early, forever")
	}
	if req.Satisfied(now.Add(-Immediate-time.Second), now) {
		t.Error("a proof one second past the window satisfied the requirement")
	}
	// The whole point: yesterday's login must not authorise today's key rotation.
	if req.Satisfied(now.Add(-9*time.Hour), now) {
		t.Fatal("a nine-hour-old login satisfied an immediate step-up. This is the " +
			"borrowed-session case the policy exists for.")
	}
}

// An unknown proof time is STALE, not fresh. Sessions predating migration 1892
// have no record, and inventing one would grant freshness never demonstrated.
func TestAnUnknownProofTimeIsTreatedAsStale(t *testing.T) {
	req := Requirement{Action: "x", MaxAge: Session}
	if req.Satisfied(time.Time{}, time.Now()) {
		t.Fatal("a zero proof time satisfied a step-up. Every session that " +
			"existed before the column did would be permanently trusted.")
	}
	// And a requirement of Never is satisfied by anything, including unknown —
	// otherwise adding the column would have prompted on every route.
	if !Never.Satisfied(time.Time{}, time.Now()) {
		t.Fatal("an unprotected route demanded a step-up")
	}
}

func TestTheTwoTiersAreOrderedAndDistinct(t *testing.T) {
	if Immediate >= Session {
		t.Fatalf("Immediate (%v) is not shorter than Session (%v); the tiers do "+
			"not mean what their names say", Immediate, Session)
	}
	if Immediate < time.Minute {
		t.Errorf("Immediate is %v — short enough that a person cannot finish a "+
			"multi-step flow without re-prompting", Immediate)
	}
	if Session > 24*time.Hour {
		t.Errorf("Session is %v, longer than a working day; a step-up nobody "+
			"encounters is not a control", Session)
	}
}

// The policy is keyed on route TEMPLATES. A concrete path would protect exactly
// one resource and wave through every other id.
func TestThePolicyIsKeyedOnRouteTemplatesNotPaths(t *testing.T) {
	if !For("POST", "/api/v1/api-keys/{id}/rotate").Required() {
		t.Fatal("the rotate template is not protected")
	}
	if For("POST", "/api/v1/api-keys/abc123/rotate").Required() {
		t.Error("a concrete path matched the policy, which means somebody could " +
			"add one and protect a single key while believing they covered all")
	}
	if For("GET", "/api/v1/api-keys/{id}/rotate").Required() {
		t.Error("the method is not part of the key; a read matched a write's policy")
	}
	// Casing and stray whitespace must not defeat it.
	if !For("post", " /api/v1/api-keys/{id}/rotate ").Required() {
		t.Error("a lower-case method or padded pattern missed the policy")
	}
}

func TestSMSInboxWorkflowWritesRequireFreshSessionProof(t *testing.T) {
	cases := []struct {
		method string
		path   string
		action string
	}{
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/snooze", "sms_inbox.snooze"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/unsnooze", "sms_inbox.unsnooze"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/archive", "sms_inbox.archive"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/unarchive", "sms_inbox.unarchive"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/assign", "sms_inbox.assign"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/notes", "sms_inbox.notes"},
		{http.MethodPost, "/api/v1/sms/conversations/{phone}/tags", "sms_inbox.tag_add"},
		{http.MethodDelete, "/api/v1/sms/conversations/{phone}/tags", "sms_inbox.tag_remove"},
		{http.MethodPost, "/api/v1/sms/conversations/bulk", "sms_inbox.bulk_state"},
	}
	for _, tc := range cases {
		requirement := For(tc.method, tc.path)
		if requirement.Action != tc.action || requirement.MaxAge != Session {
			t.Errorf("%s %s requirement = %+v", tc.method, tc.path, requirement)
		}
	}
	if For(http.MethodPost, "/api/v1/sms/conversations/{phone}/mark-read").Required() {
		t.Error("opening a conversation unexpectedly requires step-up")
	}
}

func TestSubscriberProfileWritesRequireProportionateFreshProof(t *testing.T) {
	cases := []struct {
		method string
		path   string
		action string
		tier   time.Duration
	}{
		{http.MethodPatch, "/api/v1/subscribers/{id}", "subscriber.profile_update", Session},
		{http.MethodDelete, "/api/v1/subscribers/{id}", "subscriber.erase", Immediate},
		{http.MethodPost, "/api/v1/subscribers/{id}/suppress", "subscriber.suppress", Session},
		{http.MethodDelete, "/api/v1/deliverability/suppressions/{email}", "subscriber.suppression_remove", Session},
		{http.MethodPost, "/api/v1/suppressions/bulk-action", "subscriber.suppression_bulk_action", Session},
		{http.MethodPost, "/api/v1/suppressions/mirror/{provider}", "subscriber.suppression_provider_sync", Session},
		{http.MethodPost, "/api/v1/subscribers/{id}/aliases", "subscriber.alias_add", Session},
		{http.MethodDelete, "/api/v1/subscribers/{id}/aliases/{alias_id}", "subscriber.alias_delete", Session},
		{http.MethodPost, "/api/v1/subscribers/{id}/emails", "subscriber.email_add", Session},
		{http.MethodPatch, "/api/v1/subscribers/{id}/emails/{email_id}", "subscriber.email_update", Session},
		{http.MethodDelete, "/api/v1/subscribers/{id}/emails/{email_id}", "subscriber.email_delete", Session},
		{http.MethodPatch, "/api/v1/subscribers/{id}/channel-consents/{channel}", "subscriber.consent_update", Immediate},
		{http.MethodPost, "/api/v1/subscribers/bulk/grant-consent", "subscriber.bulk_consent_grant", Immediate},
		{http.MethodPost, "/api/v1/subscribers/bulk/revoke-consent", "subscriber.bulk_consent_revoke", Immediate},
		{http.MethodPut, "/api/v1/subscribers/{id}/lifecycle", "subscriber.lifecycle_update", Session},
		{http.MethodPatch, "/api/v1/subscribers/{id}/account", "subscriber.account_link", Session},
		{http.MethodPost, "/api/v1/accounts", "subscriber.account_create", Session},
		{http.MethodPost, "/api/v1/subscribers/{id}/federated-links", "subscriber.federation_link", Immediate},
		{http.MethodDelete, "/api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}", "subscriber.federation_unlink", Immediate},
		{http.MethodPost, "/api/v1/merge/apply", "subscriber.merge", Immediate},
	}
	for _, tc := range cases {
		requirement := For(tc.method, tc.path)
		if requirement.Action != tc.action || requirement.MaxAge != tc.tier {
			t.Errorf("%s %s requirement = %+v", tc.method, tc.path, requirement)
		}
	}
	if For(http.MethodGet, "/api/v1/subscribers/{id}/timeline").Required() {
		t.Error("reading subscriber activity unexpectedly requires step-up")
	}
}

func TestComplianceProgrammeDecisionsRequireFreshSessionProof(t *testing.T) {
	cases := []struct {
		path   string
		action string
	}{
		{
			"/api/v1/compliance/programs/{framework}/attest",
			"compliance_program.attest",
		},
		{
			"/api/v1/compliance/programs/{framework}/revoke",
			"compliance_program.revoke",
		},
	}
	for _, tc := range cases {
		requirement := For(http.MethodPost, tc.path)
		if requirement.Action != tc.action || requirement.MaxAge != Session {
			t.Errorf("%s requirement = %+v", tc.path, requirement)
		}
	}
	if For(http.MethodGet, "/api/v1/compliance/programs/{framework}/events").Required() {
		t.Error("reading compliance evidence unexpectedly requires step-up")
	}
}

func TestPrivacyIncidentWritesRequireFreshSessionProof(t *testing.T) {
	cases := []struct {
		path   string
		action string
	}{
		{"/api/v1/privacy/incidents", "privacy_incident.create"},
		{"/api/v1/privacy/incidents/{incident_id}/transition", "privacy_incident.transition"},
	}
	for _, tc := range cases {
		requirement := For(http.MethodPost, tc.path)
		if !requirement.Required() || requirement.MaxAge != Session {
			t.Errorf("%s requirement = %+v, want the session freshness tier", tc.path, requirement)
		}
		if requirement.Action != tc.action {
			t.Errorf("%s action = %q, want %q", tc.path, requirement.Action, tc.action)
		}
	}
	if For(http.MethodGet, "/api/v1/privacy/incidents").Required() {
		t.Error("reading the incident register unexpectedly requires step-up")
	}
}

func TestCustomObjectControlPlaneRequiresFreshProof(t *testing.T) {
	cases := []struct {
		method string
		path   string
		action string
		tier   time.Duration
	}{
		{http.MethodPost, "/api/v1/custom-objects/types", "custom_object_type.create", Session},
		{http.MethodPut, "/api/v1/custom-objects/types/{id}", "custom_object_type.update", Session},
		{http.MethodDelete, "/api/v1/custom-objects/types/{id}", "custom_object_type.delete", Immediate},
		{http.MethodPost, "/api/v1/custom-objects/types/{id}/records", "custom_object_record.write", Session},
		{http.MethodDelete, "/api/v1/custom-objects/records/{id}", "custom_object_record.delete", Session},
	}
	for _, tc := range cases {
		requirement := For(tc.method, tc.path)
		if requirement.Action != tc.action || requirement.MaxAge != tc.tier {
			t.Errorf("%s %s requirement = %+v", tc.method, tc.path, requirement)
		}
	}
	if For(http.MethodPost, "/api/v1/custom-objects/types/{id}/records/search").Required() {
		t.Error("the read-only record search unexpectedly requires step-up")
	}
}

// Every protected route must have an action id, a reason a person can read, and
// a real tier. An entry missing any of them produces a prompt nobody can act on.
func TestEveryPolicyEntryIsUsable(t *testing.T) {
	routes := Routes()
	if len(routes) < 5 {
		t.Fatalf("only %d protected routes; this test is measuring almost nothing", len(routes))
	}
	seenActions := map[string]string{}
	for _, route := range routes {
		parts := strings.SplitN(route, " ", 2)
		req := For(parts[0], parts[1])
		if req.Action == "" {
			t.Errorf("%s has no action id, so a client cannot name the prompt", route)
		}
		if req.Reason == "" || !strings.HasSuffix(req.Reason, ".") {
			t.Errorf("%s has no readable reason (%q); the prompt would say nothing",
				route, req.Reason)
		}
		if req.MaxAge != Immediate && req.MaxAge != Session {
			t.Errorf("%s uses an ad-hoc tier %v; two tiers exist so this is not "+
				"argued per endpoint", route, req.MaxAge)
		}
		if prior, dup := seenActions[req.Action]; dup {
			t.Errorf("action %q is used by both %s and %s; telemetry and prompts "+
				"could not tell them apart", req.Action, prior, route)
		}
		seenActions[req.Action] = route
	}
}

func TestTheChallengeBodyTellsAClientWhatToDo(t *testing.T) {
	req := For("POST", "/api/v1/api-keys/{id}/rotate")
	body := req.Body()
	if body.Code != "step_up_required" {
		t.Errorf("code = %q", body.Code)
	}
	if body.Action == "" || body.Message == "" {
		t.Errorf("body = %+v; a client would have to map the URL back to a "+
			"sentence, which is the same rule copied again", body)
	}
	if body.MaxAgeSecs != int(Immediate/time.Second) {
		t.Errorf("max_age_seconds = %d, want %d — without it a client cannot say "+
			"how long the confirmation lasts", body.MaxAgeSecs, int(Immediate/time.Second))
	}
	if StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d; 403 sends somebody to an administrator about a "+
			"permission they already have", StatusCode)
	}
}

// The middleware, driven through a real router so the route pattern resolves
// the way it does in production.
func TestTheMiddlewareChallengesAStaleSessionAndPassesAFreshOne(t *testing.T) {
	cases := []struct {
		name       string
		provenAt   time.Time
		satisfied  bool
		wantStatus int
	}{
		{"a fresh proof passes", time.Now().UTC().Add(-time.Minute), true, http.StatusOK},
		{"a stale proof is challenged", time.Now().UTC().Add(-2 * time.Hour), true, StatusCode},
		{"never proven is challenged", time.Time{}, false, StatusCode},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := chi.NewRouter()
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					ctx := middleware.WithUser(req.Context(), &middleware.User{
						ID: "u1", MFASatisfied: tc.satisfied, MFASatisfiedAt: tc.provenAt,
					})
					next.ServeHTTP(w, req.WithContext(ctx))
				})
			})
			r.Use(Middleware(alwaysEnrolled))
			r.Post("/api/v1/api-keys/{id}/rotate", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/api-keys/k1/rotate", nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantStatus != StatusCode {
				return
			}
			if got := rec.Header().Get("X-Postwave-Step-Up"); got == "" {
				t.Error("no X-Postwave-Step-Up header; a client sees a bare 401 and " +
					"logs the person out instead of prompting")
			}
			var body struct {
				Error ErrorBody `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if body.Error.Code != "step_up_required" || body.Error.Message == "" {
				t.Fatalf("challenge body = %+v", body.Error)
			}
		})
	}
}

// An unprotected route must not be touched. A gate that prompts on ordinary
// traffic is one somebody switches off.
func TestAnUnprotectedRouteIsNotChallenged(t *testing.T) {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithUser(req.Context(), &middleware.User{ID: "u1"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Use(Middleware(alwaysEnrolled))
	r.Get("/api/v1/campaigns", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("an ordinary read was challenged (status %d)", rec.Code)
	}
}

func TestArchiveEmergencyUnpublishRequiresFreshSessionProof(t *testing.T) {
	requirement := For(http.MethodPost, "/api/v1/campaigns/{id}/unpublish-archive")
	if !requirement.Required() {
		t.Fatal("archive emergency unpublish has no step-up requirement")
	}
	if requirement.Action != "archive.issue_unpublish" {
		t.Fatalf("action = %q, want archive.issue_unpublish", requirement.Action)
	}
	if requirement.MaxAge != Session {
		t.Fatalf("max age = %v, want session freshness tier", requirement.MaxAge)
	}
	if !Match(http.MethodPost, "/api/v1/campaigns/00000000-0000-4000-8000-000000000002/unpublish-archive").Required() {
		t.Fatal("concrete archive emergency-unpublish path did not match its protected template")
	}
}

// Over-matching must be impossible.
//
// Written because a mutation making every template segment a wildcard passed
// everything: no test had an unprotected route with the SAME method and segment
// count as a protected one, so `POST /api/v1/campaigns` never collided with
// `POST /api/v1/api-keys`. A policy that over-matches prompts on ordinary
// traffic, and a gate that prompts constantly is one somebody switches off.
func TestAPolicyTemplateDoesNotMatchADifferentRouteOfTheSameShape(t *testing.T) {
	// Same method, same segment count as POST /api/v1/api-keys.
	if For("POST", "/api/v1/campaigns").Required() {
		t.Error("POST /api/v1/campaigns matched a policy entry")
	}
	if Match("POST", "/api/v1/campaigns").Required() {
		t.Fatal("Match treated an unrelated 3-segment POST as protected; every " +
			"segment is being wildcarded and the gate fires on ordinary traffic")
	}
	// Same method and segment count as DELETE /api/v1/workspace/invites/{id}.
	if Match("DELETE", "/api/v1/lists/members/l1").Required() {
		t.Fatal("Match treated an unrelated 5-segment DELETE as protected")
	}
	// And a genuinely protected one still matches, so this test cannot pass by
	// the matcher simply never matching anything.
	//
	// This used to name `DELETE /api/v1/team/members/u1`, a route the API does
	// not serve — so the anti-vacuity check was itself vacuous, asserting that a
	// policy entry for a nonexistent endpoint matched a request that could never
	// arrive.
	if !Match("DELETE", "/api/v1/workspace/invites/i1").Required() {
		t.Fatal("the real protected route stopped matching; this test would then " +
			"pass for the wrong reason")
	}
}

// alwaysEnrolled is the checker the pre-existing tests want: they were written
// before the exemption existed and all describe a user WITH a second factor,
// which is the case the gate is for.
func alwaysEnrolled(context.Context, string) (bool, error) { return true, nil }
