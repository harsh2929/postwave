import { describe, expect, it } from "vitest";

import {
  parseReachReport,
  reachCaveats,
  reachHeadline,
  type HumanEngagedReach,
} from "./humanEngagedReach";

// The phone shows one number from this report, so the number has to be the
// honest one. The floor counts recipients we can prove were human; the band
// counts the ones we could not classify. Showing the floor alone turns a lower
// bound into a claim.

function report(over: Partial<HumanEngagedReach> = {}): HumanEngagedReach {
  return {
    headline:
      "human-engaged reach floor: 120, with up to 40 additional unclassified",
    provider_accepted_recipients: 1000,
    human_engaged_reach_floor: 120,
    unknown_band: 40,
    human_engaged_reach_upper_bound: 160,
    machine_only_recipients: 300,
    no_interaction_recipients: 540,
    classifier_version: "v2",
    methodology_version: "m1",
    registry_version: "r1",
    configuration_hash: "a".repeat(64),
    classifier_version_coverage: [
      {
        classifier_version: "v2",
        methodology_version: "m1",
        registry_version: "r1",
        configuration_hash: "a".repeat(64),
        shadow_mode: false,
        event_count: 900,
        unclassified: false,
      },
    ],
    mixed_classifier_versions: false,
    shadow_mode: false,
    methodology: "Recipients with at least one human-classified interaction.",
    ...over,
  };
}

describe("parseReachReport", () => {
  it("accepts the server payload", () => {
    const parsed = parseReachReport(report() as unknown);
    expect(parsed?.human_engaged_reach_floor).toBe(120);
  });

  // A phone on a flaky connection gets partial JSON more often than a desktop.
  // Rendering a partial report as zeros would read as "nobody engaged".
  it("returns undefined for a non-object or a missing count", () => {
    expect(parseReachReport(null)).toBeUndefined();
    expect(parseReachReport("nope")).toBeUndefined();
    const missing = report() as unknown as Record<string, unknown>;
    delete missing.human_engaged_reach_floor;
    expect(parseReachReport(missing)).toBeUndefined();
  });

  it("rejects a negative count rather than rendering it", () => {
    expect(
      parseReachReport(report({ unknown_band: -1 }) as unknown),
    ).toBeUndefined();
  });

  it("rejects shadow and unclassified cached responses", () => {
    expect(parseReachReport(report({ shadow_mode: true }))).toBeUndefined();
    expect(
      parseReachReport(
        report({
          classifier_version_coverage: [
            {
              ...report().classifier_version_coverage[0]!,
              shadow_mode: true,
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("reachHeadline", () => {
  it("prefers the server's sentence so the band travels with the number", () => {
    expect(reachHeadline(report())).toContain("with up to 40");
  });

  it("still carries the band when the server sends no sentence", () => {
    const text = reachHeadline(report({ headline: "" }));
    expect(text).toContain("120");
    expect(text).toContain("40");
  });
});

describe("reachCaveats", () => {
  it("is silent on a clean report", () => {
    expect(reachCaveats(report())).toEqual([]);
  });

  it("leads with shadow mode, which makes the figure unpublishable", () => {
    expect(reachCaveats(report({ shadow_mode: true }))[0]).toMatch(/shadow/i);
  });

  it("warns when the window spans more than one classifier version", () => {
    expect(
      reachCaveats(report({ mixed_classifier_versions: true })).join(" "),
    ).toMatch(/more than one/i);
  });

  it("warns when more recipients are unclassified than confirmed human", () => {
    expect(
      reachCaveats(
        report({ human_engaged_reach_floor: 10, unknown_band: 90 }),
      ).join(" "),
    ).toMatch(/unclassified/i);
  });
});
