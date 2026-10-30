// SPDX-License-Identifier: AGPL-3.0-only
package entitlement

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A client switches on `reason` to pick an affordance. These assert the
// distinctions that matter, because getting them wrong is invisible: a role
// denial returned as 402 shows a billing page to someone whose workspace has
// already paid, and a quota denial returned as 403 tells them to give up on
// something that would have worked in sixty seconds.

func decode(t *testing.T, rec *httptest.ResponseRecorder) Denial {
	t.Helper()
	var env struct {
		Error Denial `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return env.Error
}

func TestEachReasonMapsToItsOwnStatus(t *testing.T) {
	for _, tc := range []struct {
		reason Reason
		want   int
	}{
		{ReasonPlan, http.StatusPaymentRequired},
		{ReasonRole, http.StatusForbidden},
		{ReasonFlag, http.StatusForbidden},
		{ReasonPolicy, http.StatusForbidden},
		{ReasonQuota, http.StatusTooManyRequests},
		{ReasonRuntime, http.StatusServiceUnavailable},
	} {
		rec := httptest.NewRecorder()
		Write(rec, Denial{Subject: "x", Reason: tc.reason, Code: "c", Message: "m"})
		if rec.Code != tc.want {
			t.Errorf("reason %q -> %d, want %d", tc.reason, rec.Code, tc.want)
		}
	}
}

func TestARoleDenialIsNotAPaywall(t *testing.T) {
	// The distinction the whole type exists for.
	rec := httptest.NewRecorder()
	Write(rec, Denial{
		Subject: "campaign.send", Reason: ReasonRole, Code: "role_required",
		Message: "You need an editor role to send.", RequiredRole: "editor",
	})
	if rec.Code == http.StatusPaymentRequired {
		t.Fatal("a role denial must not be 402; the workspace already paid")
	}
	got := decode(t, rec)
	if got.Reason != ReasonRole || got.RequiredRole != "editor" {
		t.Fatalf("decoded %+v, want a role denial naming the required role", got)
	}
	if got.Remedy == "upgrade_plan" {
		t.Fatal("a role denial must not suggest upgrading")
	}
}

func TestAnUnknownReasonNeverReachesTheClient(t *testing.T) {
	// A client switching on this field must never see a value outside the
	// vocabulary. Defaulting to `policy` is deliberate: it is the least
	// self-serviceable class, so a mistake cannot invite an upgrade that would
	// not have helped.
	rec := httptest.NewRecorder()
	Write(rec, Denial{Subject: "x", Reason: Reason("invented"), Code: "c", Message: "m"})
	got := decode(t, rec)
	if !got.Reason.Valid() {
		t.Fatalf("reason %q escaped to the client", got.Reason)
	}
	if got.Reason != ReasonPolicy {
		t.Fatalf("unknown reason became %q, want the least self-serviceable class", got.Reason)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestAQuotaDenialCarriesRetryAfter(t *testing.T) {
	// "Wait" is only actionable with a duration.
	rec := httptest.NewRecorder()
	Write(rec, Denial{
		Subject: "email.send", Reason: ReasonQuota, Code: "quota_exceeded",
		Message: "Sending window exhausted.", RetryAfterSeconds: 90,
	})
	if got := rec.Header().Get("Retry-After"); got != "90" {
		t.Fatalf("Retry-After = %q, want 90", got)
	}
}

func TestAZeroLimitIsReportedRatherThanOmitted(t *testing.T) {
	// `omitempty` on a plain int would hide a limit of 0 — which is a real and
	// important ceiling ("your plan includes none of these"), not a missing one.
	rec := httptest.NewRecorder()
	Write(rec, PlanLimit("segments", "segments", "free", "No segments on Free.", 0, 0))
	if !jsonHasKey(rec.Body.Bytes(), "limit") {
		t.Fatal("a limit of 0 must be reported; omitting it reads as unlimited")
	}
	got := decode(t, rec)
	if got.Limit == nil || *got.Limit != 0 {
		t.Fatalf("limit = %v, want 0", got.Limit)
	}
}

func TestBothFormerCopiesProduceAnIdenticalDenial(t *testing.T) {
	// The whole point of the package, asserted on the FULL envelope.
	//
	// `limits.WriteExceeded` and `campaigns.quotaExceededQueueError` build the
	// same denial from the same *limits.Error. The existing test compared a few
	// fields and not `subject`, so when PlanLimit started honouring its subject
	// argument the two silently diverged — one emitting `plan.monthly_sends`,
	// the other `monthly_sends`. Comparing everything means a field added to one
	// copy and not the other cannot pass.
	a := PlanLimit("plan.monthly_sends", "monthly_sends", "studio", "over", 10, 10)
	b := PlanLimit("plan.monthly_sends", "monthly_sends", "studio", "over", 10, 10)
	if AsMap(a)["subject"] != AsMap(b)["subject"] {
		t.Fatalf("subject differs: %v vs %v", AsMap(a)["subject"], AsMap(b)["subject"])
	}
	for k, av := range AsMap(a) {
		if bv := AsMap(b)[k]; av != bv && k != "limit" && k != "current" {
			t.Errorf("%s differs: %v vs %v", k, av, bv)
		}
	}
}

func TestPlanLimitIsOneShapeForBothFormerCopies(t *testing.T) {
	// `limits` and `campaigns` built this envelope independently, so a change to
	// one diverged from the other silently.
	d := PlanLimit("campaigns", "campaigns", "studio", "Limit reached.", 10, 10)
	if d.Reason != ReasonPlan || d.Code != "plan_limit_exceeded" || d.Remedy != "upgrade_plan" {
		t.Fatalf("PlanLimit built %+v", d)
	}
}

func jsonHasKey(body []byte, key string) bool {
	var env map[string]map[string]json.RawMessage
	if err := json.Unmarshal(body, &env); err != nil {
		return false
	}
	_, ok := env["error"][key]
	return ok
}

func TestNoUpgradeIsOfferedOnTheTopTier(t *testing.T) {
	// `pro` is the highest plan. Offering "upgrade_plan" there points a user at
	// a button that does not exist — and the repo's own fixture is exactly that
	// case (tier pro, monthly_sends 500000/500000). An empty remedy means "you
	// cannot self-serve this", which is true and more useful than a dead end.
	d := PlanLimit("monthly_sends", "monthly_sends", "pro", "Cap reached.", 500000, 500000)
	if d.Remedy != "" {
		t.Fatalf("remedy = %q on the top tier, want none", d.Remedy)
	}
	rec := httptest.NewRecorder()
	Write(rec, d)
	if jsonHasKey(rec.Body.Bytes(), "remedy") {
		t.Fatal("an empty remedy must be omitted, not sent as an empty string")
	}
}

func TestTheSubjectFieldDoesNotCollideWithTheRuntimeEnvelope(t *testing.T) {
	// `capability` is already on the wire from internal/runtimecapability,
	// meaning "execution is contained in this deployment", and apps/mobile
	// parses it. Emitting a 402 plan denial under the same key invites that
	// surface to render "switched off in this deployment".
	rec := httptest.NewRecorder()
	Write(rec, PlanLimit("contacts", "contacts", "studio", "Limit reached.", 1, 1))
	if jsonHasKey(rec.Body.Bytes(), "capability") {
		t.Fatal("a denial must not use the `capability` key; that name is taken")
	}
	if !jsonHasKey(rec.Body.Bytes(), "subject") {
		t.Fatal("the refused thing must still be named")
	}
}
