import { describe, expect, it } from "vitest";

import { decayChangeSentence, decayKindPresentation } from "./segmentDecay";

describe("decayKindPresentation", () => {
  it("names the four kinds the radar emits today", () => {
    expect(decayKindPresentation("size_cliff")).toEqual({
      label: "Size cliff",
      tone: "danger",
    });
    expect(decayKindPresentation("zero_match").tone).toBe("danger");
    expect(decayKindPresentation("everyone_match").label).toBe(
      "Matches everyone",
    );
    expect(decayKindPresentation("definition_changed").label).toBe(
      "Definition changed",
    );
  });

  it("still shows a kind the server adds later", () => {
    // The vocabulary has grown once already (`definition_changed` arrived
    // after the first three). Rendering only recognised kinds would silently
    // hide the newest class of alert — the exact failure this card exists to
    // prevent.
    expect(decayKindPresentation("membership_churn")).toEqual({
      label: "Membership churn",
      tone: "warning",
    });
  });

  it("never renders an empty label", () => {
    expect(decayKindPresentation("").label).toBe("Anomaly");
  });
});

describe("decayChangeSentence", () => {
  const none = {
    priorCount: null,
    newCount: null,
    leaverCount: null,
    entrantCount: null,
  };

  it("states the transition and the movement behind it", () => {
    expect(
      decayChangeSentence({
        priorCount: 12_480,
        newCount: 1_204,
        leaverCount: 11_300,
        entrantCount: 24,
      }),
    ).toBe("12,480 → 1,204 members · 11,300 left, 24 entered");
  });

  it("says nothing at all when the server sent no counts", () => {
    // Better an absent sentence than a fabricated transition.
    expect(decayChangeSentence(none)).toBe("");
  });

  it("does not invent a prior size from a present one", () => {
    expect(decayChangeSentence({ ...none, newCount: 0 })).toBe("0 members");
    expect(decayChangeSentence({ ...none, priorCount: 90 })).toBe(
      "was 90 members",
    );
  });

  it("omits zero movement rather than reporting '0 left'", () => {
    expect(
      decayChangeSentence({
        priorCount: 10,
        newCount: 10,
        leaverCount: 0,
        entrantCount: 0,
      }),
    ).toBe("10 → 10 members");
  });
});
