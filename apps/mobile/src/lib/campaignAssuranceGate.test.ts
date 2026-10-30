import { describe, expect, it } from "vitest";

import {
  ASSURANCE_CANCELLABLE_STATES,
  ASSURANCE_GATE_SATISFIABLE_PROFILES,
  assuranceAdvisorySummary,
  assuranceCardControl,
  MOBILE_ASSURANCE_RUN_PROFILE,
  assuranceRefusal,
  assuranceRunIsCancellable,
} from "./campaignAssuranceGate";

describe("assuranceRefusal", () => {
  it("gives each server refusal code its own sentence and remedy", () => {
    expect(assuranceRefusal("campaign_assurance_required")).toEqual({
      code: "campaign_assurance_required",
      sentence:
        "Campaign Assurance hasn't run for this content yet. Run it, then send.",
      remedy: "run",
    });
    expect(assuranceRefusal("campaign_assurance_stale")?.remedy).toBe("run");
    expect(assuranceRefusal("campaign_assurance_pending")?.remedy).toBe("wait");
    expect(assuranceRefusal("campaign_assurance_blocked")?.remedy).toBe(
      "remediate",
    );
    expect(assuranceRefusal("campaign_assurance_unavailable")?.remedy).toBe(
      "retry",
    );
  });

  it("returns null for anything that is not an assurance refusal", () => {
    expect(assuranceRefusal("campaign_not_draft")).toBeNull();
    expect(assuranceRefusal("")).toBeNull();
  });

  it("never reuses a sentence between two codes", () => {
    const codes = [
      "campaign_assurance_required",
      "campaign_assurance_pending",
      "campaign_assurance_stale",
      "campaign_assurance_blocked",
      "campaign_assurance_unavailable",
    ];
    const sentences = codes.map((code) => assuranceRefusal(code)?.sentence);
    expect(new Set(sentences).size).toBe(codes.length);
  });

  it("is not confused by a prototype key masquerading as a refusal code", () => {
    // A Record lookup on attacker-influenced input must not resolve through the
    // prototype chain; "constructor" would otherwise return a truthy value and
    // the send modal would render `undefined` as its reason.
    expect(assuranceRefusal("constructor")).toBeNull();
    expect(assuranceRefusal("toString")).toBeNull();
    expect(assuranceRefusal("__proto__")).toBeNull();
  });
});

describe("assuranceRunIsCancellable", () => {
  // Mirrors the server predicate exactly:
  // apps/api/internal/campaignassurance/lifecycle.go:383
  //   WHERE tenant_id = $1 AND id = $2 AND state IN ('queued', 'running')
  it("allows exactly the two states the server's UPDATE matches", () => {
    expect(ASSURANCE_CANCELLABLE_STATES).toEqual(["queued", "running"]);
    expect(assuranceRunIsCancellable("queued")).toBe(true);
    expect(assuranceRunIsCancellable("running")).toBe(true);
  });

  it("refuses every terminal state, so the card cannot offer a guaranteed conflict", () => {
    for (const state of [
      "complete",
      "incomplete",
      "failed",
      "cancelled",
      "stale",
    ]) {
      expect(assuranceRunIsCancellable(state)).toBe(false);
    }
  });

  it("refuses an absent or unknown state rather than guessing", () => {
    expect(assuranceRunIsCancellable(undefined)).toBe(false);
    expect(assuranceRunIsCancellable("")).toBe(false);
    // The server compares a lowercase literal; a differently-cased value is not
    // the same state and must not be treated as one.
    expect(assuranceRunIsCancellable("QUEUED")).toBe(false);
  });
});

describe("MOBILE_ASSURANCE_RUN_PROFILE", () => {
  it("asks for a profile the send gate can actually be satisfied by", () => {
    // gate.go:142 answers ErrUnavailable for ProfileCalibration, so a calibration
    // run can never clear the send it was started to clear. A phone must not
    // offer a button whose only outcome is the refusal being escaped.
    expect(ASSURANCE_GATE_SATISFIABLE_PROFILES).toContain(
      MOBILE_ASSURANCE_RUN_PROFILE,
    );
    expect(MOBILE_ASSURANCE_RUN_PROFILE).not.toBe("calibration");
  });

  it("picks the faster of the two satisfiable suites", () => {
    expect(MOBILE_ASSURANCE_RUN_PROFILE).toBe("fast");
  });
});

describe("assuranceCardControl", () => {
  it("offers nothing to a role that cannot write, whatever the run says", () => {
    for (const runState of ["queued", "running", "complete", undefined]) {
      expect(
        assuranceCardControl({ mayWrite: false, runState, hasReceipt: true }),
      ).toBe("none");
    }
    expect(
      assuranceCardControl({
        mayWrite: false,
        runState: undefined,
        hasReceipt: false,
      }),
    ).toBe("none");
  });

  it("offers the first run when there is no receipt", () => {
    expect(
      assuranceCardControl({
        mayWrite: true,
        runState: undefined,
        hasReceipt: false,
      }),
    ).toBe("start");
  });

  it("offers cancel only while the server would still accept one", () => {
    for (const runState of ["queued", "running"]) {
      expect(
        assuranceCardControl({ mayWrite: true, runState, hasReceipt: true }),
      ).toBe("cancel");
    }
  });

  it("offers a re-run once the run is terminal", () => {
    for (const runState of [
      "complete",
      "incomplete",
      "failed",
      "cancelled",
      "stale",
    ]) {
      expect(
        assuranceCardControl({ mayWrite: true, runState, hasReceipt: true }),
      ).toBe("rerun");
    }
  });

  it("never offers cancel and re-run at once", () => {
    // Two controls would invite a second run while the first still holds the
    // lease, and the server would serialise them in an order nobody chose.
    const controls = ["queued", "running", "complete", "failed"].map(
      (runState) =>
        assuranceCardControl({ mayWrite: true, runState, hasReceipt: true }),
    );
    for (const control of controls) {
      expect(["cancel", "rerun"]).toContain(control);
    }
  });
});

describe("assuranceAdvisorySummary", () => {
  it("is null when every finding blocks, so the card adds no noise", () => {
    expect(
      assuranceAdvisorySummary([
        { code: "A", blocking: true },
        { code: "B", blocking: true },
      ]),
    ).toBeNull();
    expect(assuranceAdvisorySummary([])).toBeNull();
  });

  it("counts and names the non-blocking findings the card used to discard", () => {
    const summary = assuranceAdvisorySummary([
      { code: "BLOCK", blocking: true },
      { code: "SEMANTIC_1", blocking: false },
      { code: "UNICODE_TAGS", blocking: false },
    ]);
    expect(summary).toContain("2 non-blocking advisories");
    expect(summary).toContain("SEMANTIC_1");
    expect(summary).toContain("UNICODE_TAGS");
    expect(summary).toContain("do not hold this send");
  });

  it("treats a missing `blocking` as non-blocking, matching the render's filter", () => {
    // The card's blocker list is `.filter(f => f.blocking)`, so anything without an
    // explicit true is already excluded there; the summary must cover exactly that
    // complement or some findings would appear in neither place.
    expect(assuranceAdvisorySummary([{ code: "X" }])).toContain("1 non-blocking");
  });

  it("caps the codes it names and says how many were left out", () => {
    const summary = assuranceAdvisorySummary(
      [1, 2, 3, 4, 5].map((n) => ({ code: `C${n}`, blocking: false })),
      3,
    );
    expect(summary).toContain("C1, C2, C3");
    expect(summary).toContain("+2 more");
    expect(summary).not.toContain("C4");
  });

  it("uses the singular for one advisory", () => {
    const summary = assuranceAdvisorySummary([{ code: "C1", blocking: false }]);
    expect(summary).toContain("1 non-blocking advisory");
    expect(summary).not.toContain("advisories");
  });

  it("still reports a count when the codes are unusable", () => {
    const summary = assuranceAdvisorySummary([{ blocking: false }, {}]);
    expect(summary).toContain("2 non-blocking advisories");
  });
});

describe("assuranceAdvisorySummary tolerates an absent evidence read", () => {
  it("returns null rather than throwing when evidence could not be loaded", () => {
    // The card renders even when the evidence half of the read failed (the receipt
    // is still authoritative), so this is a real call shape, not a defensive
    // flourish.
    expect(assuranceAdvisorySummary(undefined)).toBeNull();
  });
});
