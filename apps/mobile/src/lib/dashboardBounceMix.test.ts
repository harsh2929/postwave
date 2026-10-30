import { describe, expect, it } from "vitest";

import { bounceMixState } from "./dashboardBounceMix";
import type { BounceClassBreakdown } from "./deliverabilityDiagnostics";

function breakdown(
  overrides: Partial<BounceClassBreakdown> = {},
): BounceClassBreakdown {
  return {
    windowDays: 30,
    totalBounces: 1131,
    classes: [
      { code: "hard", label: "Hard bounce", count: 612, share: 0.5411 },
      { code: "block", label: "Blocked", count: 380, share: 0.336 },
      { code: "soft", label: "Soft bounce", count: 100, share: 0.0884 },
      { code: "spam_trap", label: "Spam trap", count: 39, share: 0.0345 },
    ],
    ...overrides,
  };
}

describe("bounceMixState — when the panel may appear at all", () => {
  it("stays out of the way while offline: the screen already says so once", () => {
    expect(
      bounceMixState({ breakdown: breakdown(), errored: false, offline: true })
        .kind,
    ).toBe("hidden");
  });

  it("says the read FAILED rather than vanishing — absence would read as 'no bounces'", () => {
    const state = bounceMixState({
      breakdown: undefined,
      errored: true,
      offline: false,
    });
    expect(state.kind).toBe("unavailable");
    if (state.kind !== "unavailable") throw new Error("expected unavailable");
    expect(state.body).toMatch(/couldn't be read/iu);
  });

  it("renders nothing before the read lands, and nothing on a clean workspace", () => {
    expect(
      bounceMixState({ breakdown: undefined, errored: false, offline: false })
        .kind,
    ).toBe("hidden");
    expect(
      bounceMixState({
        breakdown: breakdown({ totalBounces: 0, classes: [] }),
        errored: false,
        offline: false,
      }).kind,
    ).toBe("hidden");
  });

  it("hides — never throws — on a payload that is not a breakdown at all", () => {
    // A self-gating side panel that throws takes the whole dashboard down.
    // Reached in practice from a cached payload written by an older build,
    // and reproduced by the dashboard route test, which hands every query the
    // same stats object.
    const shapeless = [
      {},
      { totalBounces: 5 },
      { totalBounces: 5, windowDays: 30 },
      { totalBounces: 5, windowDays: 30, classes: "nope" },
      { totalBounces: "many", windowDays: 30, classes: [] },
      { totalBounces: Number.NaN, windowDays: 30, classes: [] },
    ] as unknown as BounceClassBreakdown[];
    for (const breakdown of shapeless) {
      expect(
        bounceMixState({ breakdown, errored: false, offline: false }).kind,
        JSON.stringify(breakdown),
      ).toBe("hidden");
    }
  });

  it("drops an unreadable ROW without discarding the readable ones", () => {
    const state = bounceMixState({
      breakdown: breakdown({
        totalBounces: 10,
        classes: [
          { code: "hard", label: "Hard bounce", count: 7, share: 0.7 },
          null,
          { code: "soft", count: 3, share: 0.3 },
          { code: "block", label: "Blocked", count: 3, share: 0.3 },
        ] as unknown as BounceClassBreakdown["classes"],
      }),
      errored: false,
      offline: false,
    });
    if (state.kind !== "mix") throw new Error("expected mix");
    expect(state.rows.map((row) => row.code)).toEqual(["hard", "block"]);
  });

  it("hides an unattributed total rather than drawing an empty mix", () => {
    // A non-zero total whose every class row is 0 has nothing to break down.
    expect(
      bounceMixState({
        breakdown: breakdown({
          totalBounces: 9,
          classes: [{ code: "unknown", label: "Unclassified", count: 0, share: 0 }],
        }),
        errored: false,
        offline: false,
      }).kind,
    ).toBe("hidden");
  });
});

describe("bounceMixState — what it says when it does appear", () => {
  it("shows the top three classes, grouped and shared", () => {
    const state = bounceMixState({
      breakdown: breakdown(),
      errored: false,
      offline: false,
    });
    if (state.kind !== "mix") throw new Error("expected mix");
    expect(state.rows.map((row) => row.code)).toEqual(["hard", "block", "soft"]);
    expect(state.rows[0]).toMatchObject({
      label: "Hard bounce",
      count: "612",
      share: "54.1%",
    });
    expect(state.total).toBe("1,131 bounces");
    expect(state.heading).toBe("Why they bounced · last 30 days");
  });

  it("keeps the server's label instead of inventing one", () => {
    const state = bounceMixState({
      breakdown: breakdown({
        classes: [
          { code: "block", label: "Blocked by reputation", count: 5, share: 1 },
        ],
        totalBounces: 5,
      }),
      errored: false,
      offline: false,
    });
    if (state.kind !== "mix") throw new Error("expected mix");
    expect(state.rows[0]?.label).toBe("Blocked by reputation");
  });

  it("inflects the window and the total", () => {
    const state = bounceMixState({
      breakdown: breakdown({
        windowDays: 1,
        totalBounces: 1,
        classes: [{ code: "hard", label: "Hard bounce", count: 1, share: 1 }],
      }),
      errored: false,
      offline: false,
    });
    if (state.kind !== "mix") throw new Error("expected mix");
    expect(state.heading).toBe("Why they bounced · last day");
    expect(state.total).toBe("1 bounce");
  });

  it("composes one spoken sentence carrying every row", () => {
    const state = bounceMixState({
      breakdown: breakdown(),
      errored: false,
      offline: false,
    });
    if (state.kind !== "mix") throw new Error("expected mix");
    expect(state.spoken).toBe(
      "Why they bounced · last 30 days. 1,131 bounces. " +
        "Hard bounce, 612, 54.1% of bounces. Blocked, 380, 33.6% of bounces. " +
        "Soft bounce, 100, 8.8% of bounces. Open the deliverability hub.",
    );
  });
});
