// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The denial this endpoint returns when the render-preview allowance is spent.
//
// Written at the HANDLER, deliberately. The entitlement package already has
// tests for the contract's own guarantees, but those exercise
// `entitlement.Write` directly — every one of them stays green if this handler
// is reverted to the hand-built `writeJSONErr(w, 402, "quota_exceeded", …)` it
// used to send. A test that cannot fail over the change it was written for
// proves nothing about it.
//
// The drift-guard script catches a reverted call site by reading the source;
// this catches a changed RESPONSE, which is what a client actually consumes.

// Asymmetric on purpose: with limit == current an argument swap in the handler
// is undetectable, and a review proved exactly that mutation passed.
type exhaustedQuota struct{ askedFor *string }

func (q exhaustedQuota) Consume(_ context.Context, _, resource string) (int, bool, *deliverability_control.Ceiling, error) {
	if q.askedFor != nil {
		*q.askedFor = resource
	}
	return 0, false, &deliverability_control.Ceiling{Limit: 500, Used: 517, Tier: "studio"}, nil
}

// unknownCeilingQuota refuses without numbers — an ungated tenant, or a read
// that failed. The denial must then OMIT limit/current entirely.
type unknownCeilingQuota struct{}

func (unknownCeilingQuota) Consume(context.Context, string, string) (int, bool, *deliverability_control.Ceiling, error) {
	return 0, false, nil, nil
}

func renderRequestForTest(t *testing.T) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/email-preview/render",
		strings.NewReader(`{"mjml":"<mjml><mj-body></mj-body></mjml>"}`))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111", Slug: "acme", Tier: "studio",
	}))
}

func TestRenderQuotaDenialIsTheSharedContractShape(t *testing.T) {
	rec := httptest.NewRecorder()
	var askedFor string
	(&Deps{Quota: exhaustedQuota{askedFor: &askedFor}}).Render(rec, renderRequestForTest(t))

	// Provenance: the numbers must come from the meter, asked for the right
	// resource — not from a constant the handler happens to carry.
	if askedFor != "render_previews" {
		t.Errorf("handler metered %q, want render_previews", askedFor)
	}
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 (body: %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error == nil {
		t.Fatalf("not the shared {error:{...}} denial envelope: %s", rec.Body.String())
	}
	if body.Error["reason"] != "plan" {
		t.Errorf("reason = %v, want \"plan\". Without a machine-readable class a "+
			"client has nothing to switch on but the message text, which is how a "+
			"paywall gets shown to someone who needs something else.", body.Error["reason"])
	}
	if body.Error["resource"] != "render_previews" {
		t.Errorf("resource = %v, want render_previews — a denial that does not name "+
			"what ran out cannot be rendered", body.Error["resource"])
	}
	// The remedy must name the lever that actually exists. Nothing in this repo
	// raises these ceilings on a plan change — the only writer of
	// `deliverability_entitlements` limits is the tenant-admin
	// `PUT /api/v1/deliverability-control/entitlements`.
	if body.Error["remedy"] != "contact_workspace_admin" {
		t.Errorf("remedy = %v, want contact_workspace_admin", body.Error["remedy"])
	}
	if body.Error["remedy"] == "upgrade_plan" {
		t.Error("the denial claims an upgrade resolves it. No plan change moves " +
			"this ceiling, and on the top tier there is no plan to move to.")
	}
	// The code must NOT be plan_limit_exceeded: apps/web appends "Upgrade your
	// plan…" to any error carrying the server's upgrade remedy, and reusing the
	// plan-ceiling code previously routed this denial into that copy.
	if body.Error["code"] == "plan_limit_exceeded" {
		t.Error("reusing the plan-ceiling code sends this denial into the client's " +
			"upgrade copy for a ceiling no plan raises")
	}
	// The numbers the meter already computed. Their absence was the finding:
	// without them a client can say a limit was hit but not what the limit was.
	if body.Error["limit"] != float64(500) {
		t.Errorf("limit = %v, want 500 — the meter knows it and the denial must carry it", body.Error["limit"])
	}
	if body.Error["current"] != float64(517) {
		t.Errorf("current = %v, want 517 (distinct from limit, so an argument swap "+
			"in the handler is detectable)", body.Error["current"])
	}
	if body.Error["tier"] != "studio" {
		t.Errorf("tier = %v, want studio — without it the top-tier remedy rule cannot apply", body.Error["tier"])
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store — a denial names a tenant's "+
			"limits and must not be cached by a shared proxy", got)
	}
}

func TestRenderIsNotDeniedWhenTheQuotaAllows(t *testing.T) {
	// The control. Without it the test above passes over a handler that denies
	// unconditionally, which would be a far worse bug than the one it guards.
	rec := httptest.NewRecorder()
	(&Deps{Quota: allowingQuota{}}).Render(rec, renderRequestForTest(t))
	if rec.Code == http.StatusPaymentRequired {
		t.Fatalf("a request within quota was denied 402: %s", rec.Body.String())
	}
}

type allowingQuota struct{}

func (allowingQuota) Consume(context.Context, string, string) (int, bool, *deliverability_control.Ceiling, error) {
	return 99, true, nil, nil
}

func TestAMeteringErrorFailsOpen(t *testing.T) {
	// The documented behaviour at the call site: a transient DB hiccup must not
	// block a paid feature. Asserted because "fail open" is exactly the property
	// a later refactor silently inverts.
	rec := httptest.NewRecorder()
	(&Deps{Quota: brokenQuota{}}).Render(rec, renderRequestForTest(t))
	if rec.Code == http.StatusPaymentRequired {
		t.Fatalf("a metering ERROR produced a denial; the meter is supposed to fail "+
			"open so an outage in it cannot look like an exhausted allowance: %s",
			rec.Body.String())
	}
}

type brokenQuota struct{}

func (brokenQuota) Consume(context.Context, string, string) (int, bool, *deliverability_control.Ceiling, error) {
	return 0, false, nil, context.DeadlineExceeded
}

// countingQuota records whether a unit was consumed.
type countingQuota struct{ consumed *int }

func (q countingQuota) Consume(context.Context, string, string) (int, bool, *deliverability_control.Ceiling, error) {
	*q.consumed++
	return 99, true, nil, nil
}

func TestAMalformedBodyDoesNotBurnAnAllowanceUnit(t *testing.T) {
	// The handler used to meter BEFORE parsing. A malformed or oversized request
	// then spent a unit and returned 400/413 having rendered nothing, so 500 bad
	// requests could exhaust a 500-preview month and the next good one was told
	// "monthly render-preview quota exhausted" — a denial whose own message was
	// untrue of what had actually been rendered.
	consumed := 0
	req := httptest.NewRequest(http.MethodPost, "/api/v1/email-preview/render",
		strings.NewReader(`{"not_a_field":1}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111", Slug: "acme", Tier: "studio",
	}))

	rec := httptest.NewRecorder()
	(&Deps{Quota: countingQuota{consumed: &consumed}}).Render(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("a malformed body was accepted: %s", rec.Body.String())
	}
	if consumed != 0 {
		t.Fatalf("a rejected request consumed %d allowance unit(s). Metering must "+
			"happen after the body is known to be usable, or bad requests can "+
			"exhaust a month of a paid allowance without rendering anything.", consumed)
	}
}

func TestADenialWithNoMeasuredCeilingOmitsTheNumbers(t *testing.T) {
	// An ungated tenant, or a ceiling read that failed. `-1` is not "unknown" to
	// a client — it is a number, and the `limit - current` idiom apps/web already
	// uses renders it as a plausible zero remaining. Omission is the only honest
	// answer, and the Denial's own doc says so: "Omitted otherwise rather than
	// sent as zero, because 0 is a real limit."
	rec := httptest.NewRecorder()
	(&Deps{Quota: unknownCeilingQuota{}}).Render(rec, renderRequestForTest(t))
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if _, present := body.Error["limit"]; present {
		t.Errorf("limit = %v on a denial that measured nothing; it must be omitted", body.Error["limit"])
	}
	if _, present := body.Error["current"]; present {
		t.Errorf("current = %v on a denial that measured nothing", body.Error["current"])
	}
}
