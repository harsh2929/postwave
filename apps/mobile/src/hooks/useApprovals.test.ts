import { describe, expect, it, vi } from "vitest";

// useApprovals.ts imports @/api/client + the online-query auth gate (both
// RN-bound). The tests below only exercise the pure
// deriveApprovalCampaignContext mapping, so stub those modules so the import
// graph resolves under node.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));

// eslint-disable-next-line import/first
import {
  approvalDecisionSuccessMessage,
  buildApprovalDecisionRequest,
  decisionErrorMessage,
  deriveApprovalCampaignContext,
  isStaleDecisionError,
} from "./useApprovals";

describe("deriveApprovalCampaignContext", () => {
  it("prefers the subject as the title", () => {
    const out = deriveApprovalCampaignContext(
      { subject: "Spring sale", name: "spring-2026", status: "draft" },
      null,
    );
    expect(out.title).toBe("Spring sale");
    expect(out.subtitle).toBe("spring-2026");
    expect(out.status).toBe("draft");
  });

  it("falls back to the name when there is no subject", () => {
    const out = deriveApprovalCampaignContext({ name: "Untitled draft" }, null);
    expect(out.title).toBe("Untitled draft");
    // No distinct second value → no subtitle.
    expect(out.subtitle).toBeUndefined();
  });

  it("omits the subtitle when subject and name are identical", () => {
    const out = deriveApprovalCampaignContext(
      { subject: "Newsletter", name: "Newsletter" },
      null,
    );
    expect(out.title).toBe("Newsletter");
    expect(out.subtitle).toBeUndefined();
  });

  it("trims whitespace and treats blank values as absent", () => {
    const out = deriveApprovalCampaignContext(
      { subject: "  ", name: "  Real name  " },
      null,
    );
    expect(out.title).toBe("Real name");
  });

  it("surfaces the recipient count from the report", () => {
    const out = deriveApprovalCampaignContext(
      { subject: "Blast" },
      { sent: 4200 },
    );
    expect(out.recipients).toBe(4200);
  });

  it("keeps recipients undefined when the report has no count", () => {
    const out = deriveApprovalCampaignContext({ subject: "Blast" }, null);
    expect(out.recipients).toBeUndefined();
  });

  it("returns an empty object for a null campaign", () => {
    expect(deriveApprovalCampaignContext(null, null)).toEqual({});
  });

  it("preserves a zero recipient count (sent campaign with no audience)", () => {
    const out = deriveApprovalCampaignContext(
      { subject: "Blast" },
      { sent: 0 },
    );
    expect(out.recipients).toBe(0);
  });
});

describe("approval decision helpers", () => {
  it("reports a saved decision whose follow-up action failed", () => {
    expect(
      approvalDecisionSuccessMessage("approve", {
        ok: true,
        followup_error: "campaign enqueue failed",
      }),
    ).toEqual({
      title: "Decision saved, action failed",
      message:
        "The request was approved, but its follow-up action failed: campaign enqueue failed",
      followupFailed: true,
    });
  });

  it("builds an approve request with no notes body", () => {
    expect(
      buildApprovalDecisionRequest({
        id: "apr 123/unsafe",
        decision: "approve",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/approvals/apr%20123%2Funsafe/approve",
      body: {},
    });
  });

  it("trims and sends the rejection reason in the notes body", () => {
    expect(
      buildApprovalDecisionRequest({
        id: "approval_1",
        decision: "reject",
        notes: "  Missing legal footer.  ",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/v1/approvals/approval_1/reject",
      body: { notes: "Missing legal footer." },
    });
  });

  it("drops blank rejection notes instead of sending whitespace", () => {
    expect(
      buildApprovalDecisionRequest({
        id: "approval_1",
        decision: "reject",
        notes: "   ",
      }).body,
    ).toEqual({});
  });

  it("marks stale decision errors as cache-invalidating", () => {
    expect(isStaleDecisionError({ status: 409 })).toBe(true);
    expect(isStaleDecisionError({ status: 410 })).toBe(true);
    expect(isStaleDecisionError({ status: 404 })).toBe(true);
    expect(isStaleDecisionError({ status: 403 })).toBe(false);
  });

  it("translates common decision errors into actionable copy", () => {
    expect(decisionErrorMessage({ status: 410 })).toContain("expired");
    expect(decisionErrorMessage({ status: 403 })).toContain("can't decide");
    expect(decisionErrorMessage(new Error("network down"))).toBe(
      "network down",
    );
  });
});
