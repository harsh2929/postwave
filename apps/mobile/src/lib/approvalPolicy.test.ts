import { describe, expect, it } from "vitest";

import {
  approvalDecisionSuccessMessage,
  buildApprovalDecisionRequest,
  decisionErrorMessage,
  deriveApprovalCampaignContext,
  isOptionalResourceError,
  isStaleDecisionError,
  optionalResourceStatus,
  pendingApprovalsWidgetValue,
} from "./approvalPolicy";

/**
 * The approvals surface's rules, tested where they actually live.
 *
 * Every one of these is a sentence a human READS at the moment they are
 * deciding something irreversible, or a number a widget ASSERTS about a
 * governance queue. The screens had render tests; the rules underneath them
 * had none, which is why the audit — and not CI — is where their defects
 * would have surfaced.
 */

describe("decisionErrorMessage", () => {
  it("does not blame a teammate for a 409", () => {
    const message = decisionErrorMessage({ status: 409 });
    // The commonest real cause is the user's OWN earlier attempt committing
    // server-side and timing out client-side on cellular. Telling them a
    // colleague decided it would be a confident, wrong accusation.
    expect(message).toContain("possibly by your earlier attempt");
    expect(message).not.toMatch(/colleague|teammate|someone else has/i);
  });

  it("tells the requester to re-submit after a 410", () => {
    expect(decisionErrorMessage({ status: 410 })).toContain("re-submit");
  });

  it("separates the two 403 reasons instead of emitting both", () => {
    const self = decisionErrorMessage({ status: 403, code: "self_approval" });
    expect(self).toBe(
      "You requested this approval, so someone else has to decide it.",
    );
    // The old copy concatenated both explanations, so a self-approval told the
    // requester they might also lack the role — two wrong diagnoses at once.
    expect(self).not.toMatch(/admin role/i);

    const forbidden = decisionErrorMessage({ status: 403, code: "forbidden" });
    expect(forbidden).toMatch(/owner or admin role/i);
    expect(forbidden).not.toMatch(/requested this approval/i);
  });

  it("falls back to the combined 403 copy when the server sends no code", () => {
    // A code we do not recognise must not be silently dropped into one of the
    // precise branches: without it, both possibilities are still live.
    const message = decisionErrorMessage({ status: 403 });
    expect(message).toMatch(/can't approve their own requests/i);
    expect(message).toMatch(/admin role/i);
  });

  it("reads an Error's own message when the status means nothing to us", () => {
    expect(decisionErrorMessage(new Error("socket hang up"))).toBe(
      "socket hang up",
    );
    expect(decisionErrorMessage({ status: 500 })).toBe("[object Object]");
  });
});

describe("isStaleDecisionError", () => {
  it.each([409, 410, 404])(
    "treats %i as our cached copy being stale",
    (status) => {
      expect(isStaleDecisionError({ status })).toBe(true);
    },
  );

  it.each([400, 401, 403, 422, 500, 503])(
    "leaves the cache alone on a %i",
    (status) => {
      // These say something about the REQUEST, not about the row. Refetching
      // would blank the queue the approver is reading for no new information.
      expect(isStaleDecisionError({ status })).toBe(false);
    },
  );

  it("is false for a thrown network error with no status at all", () => {
    expect(isStaleDecisionError(new Error("Network request failed"))).toBe(
      false,
    );
    expect(isStaleDecisionError(undefined)).toBe(false);
    expect(isStaleDecisionError(null)).toBe(false);
  });
});

describe("buildApprovalDecisionRequest", () => {
  it("posts to the decision's own route and escapes the id", () => {
    const request = buildApprovalDecisionRequest({
      id: "ap 1/../admin",
      decision: "approve",
    });
    expect(request.method).toBe("POST");
    // The id comes from a server payload but lands in a URL path; escaping it
    // is what stops a crafted id from addressing a different route.
    expect(request.path).toBe("/api/v1/approvals/ap%201%2F..%2Fadmin/approve");
  });

  it("omits notes entirely when the reason is blank or whitespace", () => {
    // `{ notes: "" }` and `{ notes: "   " }` both reach the server's
    // reason_required check as a PRESENT but empty field; sending no field at
    // all is the honest encoding of "the user typed nothing".
    expect(
      buildApprovalDecisionRequest({ id: "a", decision: "reject", notes: "" })
        .body,
    ).toEqual({});
    expect(
      buildApprovalDecisionRequest({
        id: "a",
        decision: "reject",
        notes: "   ",
      }).body,
    ).toEqual({});
  });

  it("trims the reason it does send", () => {
    expect(
      buildApprovalDecisionRequest({
        id: "a",
        decision: "reject",
        notes: "  wrong segment \n",
      }).body,
    ).toEqual({ notes: "wrong segment" });
  });
});

describe("approvalDecisionSuccessMessage", () => {
  it("reports a failed follow-up as a partial success, not a success", () => {
    const result = approvalDecisionSuccessMessage("approve", {
      ok: true,
      followup_error: "campaign queue rejected the send",
    });
    // Saying "Approved" when the thing that was approved did not run is the
    // single most misleading outcome this surface can produce.
    expect(result.followupFailed).toBe(true);
    expect(result.title).toBe("Decision saved, action failed");
    expect(result.message).toContain("campaign queue rejected the send");
  });

  it("treats a whitespace-only follow-up error as no error", () => {
    const result = approvalDecisionSuccessMessage("approve", {
      ok: true,
      followup_error: "   ",
    });
    expect(result.followupFailed).toBe(false);
    expect(result.title).toBe("Approved");
  });

  it("says what happens next for each decision", () => {
    expect(approvalDecisionSuccessMessage("approve", { ok: true }).message).toContain(
      "the action will proceed",
    );
    expect(approvalDecisionSuccessMessage("reject", { ok: true }).message).toContain(
      "requester will be notified",
    );
  });
});

describe("pendingApprovalsWidgetValue", () => {
  it("publishes an honest zero for an account that can never have approvals", () => {
    // GET /api/v1/approvals is owner/admin-only (requireAdmin in
    // approvals/handlers.go), so zero is TRUE for an editor or viewer — and
    // returning null would stop their widget publishing anything at all.
    expect(
      pendingApprovalsWidgetValue({ permitted: false, loaded: false, count: 0 }),
    ).toBe(0);
  });

  it("refuses to publish a number it has not received", () => {
    // ABSENCE IS NOT ZERO. "To approve: 0" is a governance surface asserting
    // there is nothing to do; publishing it from an unloaded query is a
    // confident false all-clear.
    expect(
      pendingApprovalsWidgetValue({ permitted: true, loaded: false, count: 0 }),
    ).toBeNull();
  });

  it("publishes what the server said once it has an answer", () => {
    expect(
      pendingApprovalsWidgetValue({ permitted: true, loaded: true, count: 7 }),
    ).toBe(7);
    expect(
      pendingApprovalsWidgetValue({ permitted: true, loaded: true, count: 0 }),
    ).toBe(0);
  });

  it("never publishes a negative or non-finite count", () => {
    expect(
      pendingApprovalsWidgetValue({ permitted: true, loaded: true, count: -3 }),
    ).toBe(0);
    expect(
      pendingApprovalsWidgetValue({
        permitted: true,
        loaded: true,
        count: Number.NaN,
      }),
    ).toBe(0);
  });
});

describe("deriveApprovalCampaignContext", () => {
  it("prefers the subject and shows the name only when it adds information", () => {
    expect(
      deriveApprovalCampaignContext(
        { name: "July promo", subject: "50% off everything" },
        null,
      ),
    ).toEqual({ title: "50% off everything", subtitle: "July promo" });

    // Identical strings would render the same line twice.
    expect(
      deriveApprovalCampaignContext(
        { name: "July promo", subject: "July promo" },
        null,
      ),
    ).toEqual({ title: "July promo" });
  });

  it("falls back to the name when there is no subject", () => {
    expect(deriveApprovalCampaignContext({ name: "July promo" }, null)).toEqual({
      title: "July promo",
    });
  });

  it("omits fields rather than inventing empty ones", () => {
    // An absent recipient count must not become 0: an unsent campaign has no
    // measurement, and "0 recipients" is a claim.
    expect(deriveApprovalCampaignContext({ subject: "  " }, {})).toEqual({});
    expect(
      deriveApprovalCampaignContext({ subject: "Hi", status: "draft" }, { sent: 0 }),
    ).toEqual({ title: "Hi", status: "draft", recipients: 0 });
  });

  it("survives a null campaign", () => {
    expect(deriveApprovalCampaignContext(null, null)).toEqual({});
  });
});

describe("optional resource lookups", () => {
  it.each([404, 405, 501])(
    "treats %i as the enrichment simply not being available",
    (status) => {
      expect(isOptionalResourceError({ status })).toBe(true);
    },
  );

  it.each([400, 403, 500])("keeps %i as a real failure", (status) => {
    expect(isOptionalResourceError({ status })).toBe(false);
  });

  it("reports 0 for anything without a numeric status", () => {
    expect(optionalResourceStatus(new Error("boom"))).toBe(0);
    expect(optionalResourceStatus({ status: "404" })).toBe(404);
    expect(optionalResourceStatus(null)).toBe(0);
  });
});
