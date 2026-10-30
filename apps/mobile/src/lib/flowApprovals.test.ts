/**
 * lib/flowApprovals.test.ts — the decidability predicate above all else.
 *
 * `isDecidable` is the ONLY thing that decides whether Approve/Reject appear,
 * and it must equal `Repo.Decide`'s `WHERE transactional_status IN
 * ('requested','marketing')` exactly. Too narrow and a parked flow can never
 * be released from a phone; too wide and every tap is a 409.
 */
import { describe, expect, it } from "vitest";

import {
  approvalChannelLabel,
  approvalStatusPresentation,
  decisionCopy,
  decisionErrorMessage,
  decisionSuccessMessage,
  isDecidable,
  parseFlowApproval,
  parseFlowApprovalList,
  partitionApprovals,
  APPROVAL_STATUSES,
  DECIDABLE_APPROVAL_STATUSES,
  type MobileFlowApproval,
} from "./flowApprovals";

function approval(overrides: Record<string, unknown> = {}) {
  return parseFlowApproval({
    id: "a-1",
    automation_id: "11111111-1111-4111-8111-111111111111",
    node_id: "review-1",
    channel: "email",
    message_ref: "",
    transactional_status: "requested",
    requested_at: "2026-07-20T10:00:00Z",
    decided_at: null,
    created_at: "2026-07-20T09:59:00Z",
    ...overrides,
  })!;
}

describe("isDecidable", () => {
  it("admits BOTH statuses Repo.Decide updates on", () => {
    // 'marketing' is the column DEFAULT (migration 0202) and the engine's gate
    // maps it to "pending" in its default arm. A queue that filtered on
    // 'requested' alone would leave those flows parked with nothing on screen.
    expect(isDecidable(approval({ transactional_status: "requested" }))).toBe(true);
    expect(isDecidable(approval({ transactional_status: "marketing" }))).toBe(true);
  });

  it("refuses every status Decide answers 409 for", () => {
    for (const status of ["approved", "rejected", "revoked"]) {
      expect(isDecidable(approval({ transactional_status: status }))).toBe(false);
    }
  });

  it("refuses an unrecognised or absent status rather than offering a doomed tap", () => {
    expect(isDecidable(approval({ transactional_status: "" }))).toBe(false);
    expect(isDecidable(approval({ transactional_status: "queued" }))).toBe(false);
  });

  it("covers exactly the decidable half of the DDL's CHECK constraint", () => {
    const decidable = APPROVAL_STATUSES.filter((status) =>
      isDecidable(approval({ transactional_status: status })),
    );

    expect([...decidable].sort()).toEqual([...DECIDABLE_APPROVAL_STATUSES].sort());
  });
});

describe("parseFlowApproval", () => {
  it("returns null for a row with no id", () => {
    expect(parseFlowApproval({ node_id: "x" })).toBeNull();
    expect(parseFlowApproval(null)).toBeNull();
  });

  it("leaves an absent status empty rather than defaulting it to decidable", () => {
    const row = parseFlowApproval({ id: "a-1" })!;

    expect(row.transactionalStatus).toBe("");
    expect(isDecidable(row)).toBe(false);
  });

  it("rejects Go's zero time on both instants", () => {
    const row = parseFlowApproval({
      id: "a-1",
      requested_at: "0001-01-01T00:00:00Z",
      decided_at: "0001-01-01T00:00:00Z",
    })!;

    expect(row.requestedAt).toBeNull();
    expect(row.decidedAt).toBeNull();
  });

  it("reads the {items} map the handler writes — NOT a pagination envelope", () => {
    const list = parseFlowApprovalList({ items: [{ id: "a-1" }, { id: "a-2" }] });

    expect(list).toHaveLength(2);
  });

  it("returns empty rather than throwing on a drifted envelope", () => {
    expect(parseFlowApprovalList({ approvals: [{ id: "a" }] })).toEqual([]);
    expect(parseFlowApprovalList(undefined)).toEqual([]);
  });
});

describe("partitionApprovals", () => {
  it("splits on the same predicate the server writes with", () => {
    const rows: MobileFlowApproval[] = [
      approval({ id: "a", transactional_status: "requested" }),
      approval({ id: "b", transactional_status: "approved" }),
      approval({ id: "c", transactional_status: "marketing" }),
      approval({ id: "d", transactional_status: "rejected" }),
    ];

    const { pending, decided } = partitionApprovals(rows);

    expect(pending.map((row) => row.id)).toEqual(["a", "c"]);
    expect(decided.map((row) => row.id)).toEqual(["b", "d"]);
  });

  it("handles an empty queue without inventing either bucket", () => {
    expect(partitionApprovals([])).toEqual({ pending: [], decided: [] });
  });
});

describe("approvalStatusPresentation", () => {
  it("does not describe the column default as a requested review", () => {
    // It is decidable, but the gate never asked for it — saying "Awaiting
    // review" would imply a deliberate request that was never made.
    const marketing = approvalStatusPresentation("marketing");

    expect(marketing.label).toBe("Not yet requested");
    expect(marketing.spoken).toMatch(/can be decided/i);
  });

  it("gives every DDL status a spoken sentence, so state is never colour-alone", () => {
    for (const status of APPROVAL_STATUSES) {
      expect(approvalStatusPresentation(status).spoken.length).toBeGreaterThan(0);
    }
  });

  it("shows an unrecognised status verbatim", () => {
    expect(approvalStatusPresentation("escalated").label).toBe("escalated");
  });

  it("names every channel the DDL's CHECK allows", () => {
    expect(approvalChannelLabel("email")).toBe("Email");
    expect(approvalChannelLabel("sms")).toBe("SMS");
    expect(approvalChannelLabel("push")).toBe("Push");
    expect(approvalChannelLabel("webhook")).toBe("Webhook");
    expect(approvalChannelLabel("")).toBe("Unknown channel");
  });
});

describe("decision copy", () => {
  it("tells the operator there is no undo, for BOTH verbs", () => {
    // Nothing in flow_approvals returns a decided row to pending.
    expect(decisionCopy(approval(), "approve").consequence).toMatch(/no undo/i);
    expect(decisionCopy(approval(), "reject").consequence).toMatch(/no undo/i);
  });

  it("does not claim the flow resumes immediately", () => {
    // The parked execution resumes on its NEXT RETRY.
    expect(decisionCopy(approval(), "approve").consequence).toMatch(/next retry/i);
    expect(decisionSuccessMessage("approve")).toMatch(/next retry/i);
  });

  it("marks reject as destructive and approve as not", () => {
    expect(decisionCopy(approval(), "reject").destructive).toBe(true);
    expect(decisionCopy(approval(), "approve").destructive).toBe(false);
  });

  it("names the step so the sheet is about a specific gate", () => {
    expect(decisionCopy(approval({ node_id: "legal-check" }), "approve").message)
      .toContain("legal-check");
  });

  it("survives a row with no node id rather than printing an empty quote", () => {
    expect(decisionCopy(approval({ node_id: "" }), "approve").message).toContain(
      "this step",
    );
  });
});

describe("decisionErrorMessage", () => {
  it("explains a 409 as someone else having decided it", () => {
    // The most likely failure on a shared queue, and one a generic error
    // leaves the operator retrying forever.
    const byStatus = decisionErrorMessage(
      Object.assign(new Error("conflict"), { status: 409 }),
    );
    const byCode = decisionErrorMessage(
      Object.assign(new Error("conflict"), { code: "not_pending" }),
    );

    expect(byStatus).toMatch(/already decided/i);
    expect(byCode).toMatch(/already decided/i);
  });

  it("explains a 403 as the role floor it actually is", () => {
    expect(
      decisionErrorMessage(Object.assign(new Error("nope"), { status: 403 })),
    ).toMatch(/editor/i);
  });

  it("falls back to the server's own message, then to something actionable", () => {
    expect(decisionErrorMessage(new Error("upstream timeout"))).toBe(
      "upstream timeout",
    );
    expect(decisionErrorMessage(undefined)).toMatch(/try again/i);
  });
});
