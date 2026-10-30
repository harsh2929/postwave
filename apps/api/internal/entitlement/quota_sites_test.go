// SPDX-License-Identifier: AGPL-3.0-only
package entitlement_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The properties every converted denial site must have.
//
// Increment 6 built the contract and converted the two sites whose duplication
// motivated it. The remaining ~77 sites each hand-build a status code and a
// prose string, which is how a paywall ends up shown to someone who needs a role
// change: a client with no machine-readable class has nothing to switch on but
// the message text.
//
// These assert the contract's guarantees directly, so a site converted later can
// be checked against them rather than against a hand-copied expectation.

func decodeDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("denial body is not the {error:{...}} envelope: %v (%s)", err, rec.Body.String())
	}
	if body.Error == nil {
		t.Fatalf("denial body has no `error` object: %s", rec.Body.String())
	}
	return body.Error
}

func TestAPlanCeilingDenialCarriesTheNumbersAClientNeeds(t *testing.T) {
	// A metered feature at its ceiling. "quota_exceeded" as a bare string tells a
	// client nothing it can render: not which resource, not the limit, not
	// whether waiting or paying resolves it.
	rec := httptest.NewRecorder()
	entitlement.Write(rec, entitlement.PlanLimit(
		"render_previews", "render_previews", "studio",
		"monthly render-preview quota exhausted", 500, 500))

	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
	d := decodeDenial(t, rec)
	if d["reason"] != "plan" {
		t.Errorf("reason = %v, want plan — a client switches on this to choose an affordance", d["reason"])
	}
	if d["resource"] != "render_previews" {
		t.Errorf("resource = %v; a denial that does not name what ran out cannot be rendered", d["resource"])
	}
	if d["limit"] == nil || d["current"] == nil {
		t.Errorf("limit/current missing: %v. Without them the client cannot say how much is left", d)
	}
	if d["remedy"] != "upgrade_plan" {
		t.Errorf("remedy = %v, want upgrade_plan on a non-top tier", d["remedy"])
	}
}

func TestATopTierCeilingOffersNoUpgrade(t *testing.T) {
	// The case a hand-written envelope always gets wrong: `pro` is the highest
	// plan, so telling a pro tenant at their ceiling to upgrade points at a
	// button that does not exist.
	rec := httptest.NewRecorder()
	entitlement.Write(rec, entitlement.PlanLimit(
		"inbox_tests", "inbox_tests", "pro", "monthly inbox-test quota exhausted", 100, 100))
	d := decodeDenial(t, rec)
	if d["remedy"] != nil && d["remedy"] != "" {
		t.Fatalf("remedy = %v on the top tier; there is nothing to upgrade to", d["remedy"])
	}
}

func TestADenialTheCallerCannotSelfServeSaysSo(t *testing.T) {
	// Provider credit exhaustion is a billing state, but not the CALLER's: no
	// action available to them resolves it. An empty remedy is the honest answer
	// and is more useful than offering an upgrade that would change nothing.
	rec := httptest.NewRecorder()
	entitlement.Write(rec, entitlement.Denial{
		Subject: "email_verification",
		Reason:  entitlement.ReasonPlan,
		Code:    "verification_no_credits",
		Message: "The verification provider reported no remaining credits.",
		Remedy:  "add_provider_credits",
	})
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 — this is an actionable billing state, not a 500", rec.Code)
	}
	d := decodeDenial(t, rec)
	if d["code"] != "verification_no_credits" {
		t.Errorf("code = %v; the specific code within the reason must survive", d["code"])
	}
	if d["remedy"] != "add_provider_credits" {
		t.Errorf("remedy = %v; the one action that resolves this must be named", d["remedy"])
	}
	if d["limit"] != nil || d["current"] != nil {
		t.Errorf("limit/current present on a denial with no numeric ceiling: %v. "+
			"Zero is a real limit, so these must be OMITTED rather than sent as 0", d)
	}
}

func TestEveryDenialCarriesNoStoreAndNosniff(t *testing.T) {
	// A denial names what a tenant may not do and how close they are to a limit.
	// A shared cache holding one is a cross-tenant disclosure, and the header is
	// exactly the thing a hand-built envelope forgets.
	for _, reason := range []entitlement.Reason{
		entitlement.ReasonPlan, entitlement.ReasonRole, entitlement.ReasonFlag,
		entitlement.ReasonQuota, entitlement.ReasonPolicy, entitlement.ReasonRuntime,
	} {
		rec := httptest.NewRecorder()
		entitlement.Write(rec, entitlement.Denial{Reason: reason, Code: "x", Message: "m"})
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", reason, got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q, want nosniff", reason, got)
		}
	}
}

func TestWriteSuppressesAnUpgradeRemedyOnTheTopTier(t *testing.T) {
	// The rule must hold for ANY denial, not only ones PlanLimit built.
	//
	// It originally lived in `remedyForTier`, which is unexported — so a site in
	// another package could not apply it even knowing it existed. Three sites
	// converted later duly hardcoded `upgrade_plan`, reintroducing the exact
	// defect the contract was written to remove. Enforcing it in Write means a
	// caller cannot get it wrong by omission.
	rec := httptest.NewRecorder()
	entitlement.Write(rec, entitlement.Denial{
		Reason: entitlement.ReasonPlan, Code: "c", Message: "m",
		Tier: "pro", Remedy: entitlement.RemedyUpgradePlan,
	})
	if d := decodeDenial(t, rec); d["remedy"] != nil && d["remedy"] != "" {
		t.Fatalf("remedy = %v on the top tier; there is no plan above it to buy", d["remedy"])
	}

	// And it must not strip a remedy that IS true.
	rec = httptest.NewRecorder()
	entitlement.Write(rec, entitlement.Denial{
		Reason: entitlement.ReasonPlan, Code: "c", Message: "m",
		Tier: "studio", Remedy: entitlement.RemedyUpgradePlan,
	})
	if d := decodeDenial(t, rec); d["remedy"] != entitlement.RemedyUpgradePlan {
		t.Fatalf("remedy = %v on a non-top tier; the upgrade is real and must be offered", d["remedy"])
	}

	// A DIFFERENT remedy on the top tier is untouched: the rule is about the
	// upgrade claim specifically, not about suppressing remedies generally.
	rec = httptest.NewRecorder()
	entitlement.Write(rec, entitlement.Denial{
		Reason: entitlement.ReasonPlan, Code: "c", Message: "m",
		Tier: "pro", Remedy: "add_provider_credits",
	})
	if d := decodeDenial(t, rec); d["remedy"] != "add_provider_credits" {
		t.Fatalf("remedy = %v; only the upgrade claim is conditional on tier", d["remedy"])
	}
}

func TestPlanLimitUsesTheSubjectItWasGiven(t *testing.T) {
	// The parameter was declared and ignored: the constructor assigned
	// `Subject: resource`, so a caller naming a distinct subject silently got the
	// resource instead. Nothing asserted subject, and the two call sites that
	// existed passed subject == resource, so the register of tests structurally
	// could not catch it.
	rec := httptest.NewRecorder()
	entitlement.Write(rec, entitlement.PlanLimit(
		"plan.contacts", "contacts", "studio", "too many contacts", 1000, 1000))
	d := decodeDenial(t, rec)
	if d["subject"] != "plan.contacts" {
		t.Errorf("subject = %v, want plan.contacts — the caller named it and it was dropped", d["subject"])
	}
	if d["resource"] != "contacts" {
		t.Errorf("resource = %v, want contacts", d["resource"])
	}
}
