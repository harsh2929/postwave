import { describe, expect, it } from "vitest";

import {
  parseReachReport,
  reachCaveats,
  reachHeadline,
  type HumanEngagedReach,
} from "../../lib/human-engaged-reach";

// The desktop is where a number gets copied into a board deck, so this is the
// surface where an overstated figure does the most damage. The floor counts
// recipients we can prove were human; the band counts the ones we could not
// classify. The two must never be separated.

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
    machine_by_subtype: { security_scanner: 200, image_proxy: 100 },
    classifier_version: "v2",
    methodology_version: "m1",
    registry_version: "r1",
    configuration_hash: "abcdef0123456789",
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
    expect(parseReachReport(report() as unknown)?.unknown_band).toBe(40);
  });

  it("refuses a partial report rather than rendering it as zeros", () => {
    const partial = report() as unknown as Record<string, unknown>;
    delete partial.unknown_band;
    expect(parseReachReport(partial)).toBeUndefined();
    expect(parseReachReport(null)).toBeUndefined();
  });

  it("refuses shadow or unclassified coverage even when the payload is complete", () => {
    expect(parseReachReport(report({ shadow_mode: true }))).toBeUndefined();
    expect(
      parseReachReport(
        report({
          classifier_version_coverage: [
            {
              ...report().classifier_version_coverage[0],
              unclassified: true,
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("reachHeadline", () => {
  it("renders the server's sentence so the band cannot be dropped", () => {
    expect(reachHeadline(report())).toContain("with up to 40");
  });

  it("keeps the band when rebuilding for an older gateway", () => {
    const text = reachHeadline(report({ headline: "" }));
    expect(text).toContain("120");
    expect(text).toContain("40");
    expect(text).not.toBe("120");
  });
});

describe("reachCaveats", () => {
  it("says nothing about a clean report", () => {
    expect(reachCaveats(report())).toEqual([]);
  });

  it("leads with shadow mode, the one that makes the figure unpublishable", () => {
    expect(reachCaveats(report({ shadow_mode: true }))[0]).toMatch(/shadow/i);
  });

  it("warns when the window spans more than one classifier version", () => {
    expect(
      reachCaveats(report({ mixed_classifier_versions: true })).join(" "),
    ).toMatch(/more than one/i);
  });

  it("warns when unclassified recipients outnumber confirmed humans", () => {
    expect(
      reachCaveats(
        report({ human_engaged_reach_floor: 10, unknown_band: 90 }),
      ).join(" "),
    ).toMatch(/unclassified/i);
  });
});
