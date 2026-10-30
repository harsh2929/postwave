import { describe, expect, it } from "vitest";

import {
  approvalChainHeadline,
  approvalChainStageLabel,
  buildApprovalChainView,
  normalizeChainProgress,
  normalizeChainSteps,
} from "./approvalChain";

const STEPS = [
  { position: 1, role: "editor" },
  { position: 2, role: "legal" },
  { position: 3, role: "cmo" },
];

describe("normalizeChainSteps", () => {
  it("reads the wrapped steps array and orders it", () => {
    expect(
      normalizeChainSteps({
        steps: [
          { position: 2, role: " legal " },
          { position: 1, role: "editor" },
        ],
      }),
    ).toEqual([
      { position: 1, role: "editor" },
      { position: 2, role: "legal" },
    ]);
  });

  it("drops rows without a usable 1-based position", () => {
    expect(
      normalizeChainSteps({ steps: [{ position: 0, role: "x" }, null, 7] }),
    ).toEqual([]);
  });

  it("is empty for a non-chain response", () => {
    expect(normalizeChainSteps(null)).toEqual([]);
    expect(normalizeChainSteps({ steps: "nope" })).toEqual([]);
  });
});

describe("normalizeChainProgress", () => {
  it("clamps an unknown overall state to pending", () => {
    expect(
      normalizeChainProgress({ stages: [], state: "weird", current_position: 4 })
        .state,
    ).toBe("pending");
  });

  it("keeps approved and rejected", () => {
    expect(normalizeChainProgress({ state: "approved" }).state).toBe("approved");
    expect(normalizeChainProgress({ state: "rejected" }).state).toBe("rejected");
  });
});

describe("buildApprovalChainView", () => {
  it("reports no chain when neither source has anything", () => {
    const view = buildApprovalChainView([], null);
    expect(view.configured).toBe(false);
    expect(approvalChainHeadline(view, "admin")).toBeNull();
  });

  it("shows an untouched chain as waiting on stage 1, not stage 0", () => {
    // The server returns stages: [] and current_position: 0 until the first
    // decision lazily inserts the progress rows. Rendering 0 would put the
    // reader on a stage that does not exist.
    const view = buildApprovalChainView(STEPS, {
      stages: [],
      state: "pending",
      current_position: 0,
    });
    expect(view.configured).toBe(true);
    expect(view.currentPosition).toBe(1);
    expect(view.stages.every((s) => s.unrecorded)).toBe(true);
    expect(approvalChainHeadline(view, null)).toBe(
      "Stage 1 of 3 — waiting on Editor.",
    );
  });

  it("advances to the first non-approved stage and counts what is behind", () => {
    const view = buildApprovalChainView(STEPS, {
      stages: [
        { position: 1, role: "editor", status: "approved" },
        { position: 2, role: "legal", status: "pending" },
        { position: 3, role: "cmo", status: "pending" },
      ],
      state: "pending",
      current_position: 2,
    });
    expect(view.currentPosition).toBe(2);
    expect(approvalChainHeadline(view, null)).toBe(
      "Stage 2 of 3 — waiting on Legal. 1 stage ahead already approved.",
    );
  });

  it("tells the reader when the blocking stage is their own role", () => {
    const view = buildApprovalChainView(STEPS, {
      stages: [
        { position: 1, role: "editor", status: "approved" },
        { position: 2, role: "legal", status: "pending" },
        { position: 3, role: "cmo", status: "pending" },
      ],
      state: "pending",
      current_position: 2,
    });
    expect(approvalChainHeadline(view, "LEGAL")).toContain("which is your role");
  });

  it("reports a rejection at the stage that rejected", () => {
    const view = buildApprovalChainView(STEPS, {
      stages: [
        { position: 1, role: "editor", status: "approved" },
        { position: 2, role: "legal", status: "rejected" },
        { position: 3, role: "cmo", status: "pending" },
      ],
      state: "rejected",
      current_position: 2,
    });
    expect(view.state).toBe("rejected");
    expect(view.currentPosition).toBeNull();
    expect(approvalChainHeadline(view, null)).toBe(
      "Rejected at stage 2 of 3 (Legal).",
    );
  });

  it("reports a fully approved chain", () => {
    const view = buildApprovalChainView(STEPS, {
      stages: STEPS.map((s) => ({ ...s, status: "approved" })),
      state: "approved",
      current_position: 3,
    });
    expect(view.state).toBe("approved");
    expect(approvalChainHeadline(view, null)).toBe("All 3 chain stages approved.");
  });

  it("keeps the recorded stage when the chain was reconfigured mid-flight", () => {
    // setChain deletes and re-inserts steps while progress rows survive, so
    // the plan and the history genuinely can disagree.
    const view = buildApprovalChainView(
      [
        { position: 1, role: "editor" },
        { position: 2, role: "finance" },
      ],
      {
        stages: [{ position: 1, role: "editor", status: "approved" }],
        state: "pending",
        current_position: 2,
      },
    );
    expect(view.reconfigured).toBe(true);
    expect(view.stages[0]?.status).toBe("approved");
    expect(view.stages[1]).toMatchObject({
      position: 2,
      role: "finance",
      status: "pending",
      unrecorded: true,
    });
  });

  it("surfaces a recorded stage the current config dropped entirely", () => {
    const view = buildApprovalChainView([{ position: 1, role: "editor" }], {
      stages: [
        { position: 1, role: "editor", status: "approved" },
        { position: 2, role: "legal", status: "approved" },
      ],
      state: "approved",
      current_position: 2,
    });
    expect(view.stages).toHaveLength(2);
    expect(view.reconfigured).toBe(true);
  });
});

describe("approvalChainStageLabel", () => {
  it("speaks every state without relying on colour", () => {
    expect(
      approvalChainStageLabel({
        position: 2,
        role: "legal",
        status: "pending",
        current: true,
        unrecorded: false,
      }),
    ).toBe("Stage 2, Legal: waiting now");
    expect(
      approvalChainStageLabel({
        position: 3,
        role: "cmo",
        status: "pending",
        current: false,
        unrecorded: true,
      }),
    ).toBe("Stage 3, Cmo: not started");
    expect(
      approvalChainStageLabel({
        position: 1,
        role: "",
        status: "approved",
        current: false,
        unrecorded: false,
      }),
    ).toBe("Stage 1, an unnamed role: approved");
  });
});
