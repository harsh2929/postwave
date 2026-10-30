/**
 * The `?seed` / `?campaignId` contract between CampaignSubjectLabLink (encode)
 * and app/(tabs)/subject-lab.tsx (decode).
 *
 * What must not regress silently: the two sides agreeing. A link that sends a
 * key the screen no longer reads — or a screen that reads a key the link no
 * longer sends — leaves "Score in Subject Lab →" opening an EMPTY lab, which
 * is indistinguishable from the feature not existing.
 */
import { describe, expect, it } from "vitest";

import { CAMPAIGN_SUBJECT_MAX } from "./campaignCreate";
import { readSubjectLabArrival, subjectLabSeedParams } from "./subjectLabSeed";

describe("subjectLabSeedParams → readSubjectLabArrival round trip", () => {
  it("carries the trimmed subject and the campaign id across intact", () => {
    const params = subjectLabSeedParams(
      "  Your April report is ready \n",
      "cmp_1",
    );
    expect(params).toEqual({
      seed: "Your April report is ready",
      campaignId: "cmp_1",
    });
    expect(readSubjectLabArrival(params)).toEqual({
      seed: "Your April report is ready",
      campaignId: "cmp_1",
    });
  });

  it("omits the seed key for an empty subject rather than sending ?seed=", () => {
    expect(subjectLabSeedParams("   ", "cmp_1")).toEqual({ campaignId: "cmp_1" });
    expect(subjectLabSeedParams(null, "cmp_1")).toEqual({ campaignId: "cmp_1" });
    expect(readSubjectLabArrival({ campaignId: "cmp_1" })).toEqual({
      seed: null,
      campaignId: "cmp_1",
    });
  });

  it("omits the campaign id when there is none, so the bandit stays unarmed", () => {
    expect(subjectLabSeedParams("A real subject line", undefined)).toEqual({
      seed: "A real subject line",
    });
    expect(readSubjectLabArrival({ seed: "A real subject line" })).toEqual({
      seed: "A real subject line",
      campaignId: undefined,
    });
  });

  it("clamps an over-long seed to the campaign subject cap on BOTH sides", () => {
    const long = "x".repeat(CAMPAIGN_SUBJECT_MAX + 25);
    expect(subjectLabSeedParams(long, "cmp_1").seed).toHaveLength(
      CAMPAIGN_SUBJECT_MAX,
    );
    // A link built by hand, bypassing the encoder, lands in the same place.
    expect(readSubjectLabArrival({ seed: long }).seed).toHaveLength(
      CAMPAIGN_SUBJECT_MAX,
    );
  });
});

describe("readSubjectLabArrival on what expo-router actually hands back", () => {
  it("reads a repeated key as its first value", () => {
    expect(
      readSubjectLabArrival({
        seed: ["First arrival", "Second arrival"],
        campaignId: ["cmp_1", "cmp_2"],
      }),
    ).toEqual({ seed: "First arrival", campaignId: "cmp_1" });
  });

  it("treats a missing params object and non-string values as absent", () => {
    expect(readSubjectLabArrival(undefined)).toEqual({
      seed: null,
      campaignId: undefined,
    });
    expect(readSubjectLabArrival({ seed: 42, campaignId: { id: "x" } })).toEqual(
      { seed: null, campaignId: undefined },
    );
    expect(readSubjectLabArrival({ seed: [], campaignId: [7] })).toEqual({
      seed: null,
      campaignId: undefined,
    });
  });

  it("trims a whitespace-padded arrival exactly as the encoder would have", () => {
    expect(readSubjectLabArrival({ seed: "  padded  ", campaignId: " cmp_1 " })).toEqual(
      { seed: "padded", campaignId: "cmp_1" },
    );
  });
});
