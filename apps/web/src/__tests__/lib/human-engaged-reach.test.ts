// SPDX-License-Identifier: AGPL-3.0-only
//
// The reach report replaces the open rate as the number a customer quotes. Its
// whole value is that it is defensible, which makes every way of quietly
// overstating it a bug — not a formatting preference.

import { describe, expect, it } from "vitest";

import {
  isReleasedReachPayload,
  reachCaveats,
  reachHeadline,
  reachShare,
  type HumanEngagedReach,
} from "@/lib/human-engaged-reach";

function report(over: Partial<HumanEngagedReach> = {}): HumanEngagedReach {
  return {
    tenant_id: "t",
    window_start: "2026-08-01T00:00:00Z",
    window_end: "2026-08-14T00:00:00Z",
    generated_at: "2026-08-14T12:00:00Z",
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
    methodology:
      "Counted recipients with at least one human-classified interaction.",
    ...over,
  };
}

describe("reachHeadline", () => {
  // The server renders the sentence because the band must travel with the
  // number. Re-deriving it in the client is how the band gets dropped.
  it("uses the server's sentence verbatim", () => {
    expect(reachHeadline(report())).toBe(
      "human-engaged reach floor: 120, with up to 40 additional unclassified",
    );
  });

  it("falls back to a sentence that still carries the band if the server omits one", () => {
    const text = reachHeadline(report({ headline: "" }));
    expect(text).toContain("120");
    expect(text).toContain("40");
  });

  // The fallback must never degrade into the bare floor, which is the exact
  // overstatement the band exists to prevent.
  it("never renders the floor alone when an unknown band exists", () => {
    expect(reachHeadline(report({ headline: "" }))).not.toBe("120");
  });
});

describe("release boundary", () => {
  it("accepts only a non-shadow report with complete classifier coverage", () => {
    expect(isReleasedReachPayload(report())).toBe(true);
  });

  it("refuses shadow and unclassified cached payloads", () => {
    expect(isReleasedReachPayload(report({ shadow_mode: true }))).toBe(false);
    expect(
      isReleasedReachPayload(
        report({
          classifier_version_coverage: [
            {
              ...report().classifier_version_coverage[0],
              unclassified: true,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("reachShare", () => {
  it("expresses the floor against provider-accepted recipients", () => {
    expect(reachShare(report())).toEqual({ floor: 0.12, upper: 0.16 });
  });

  // Dividing by zero deliveries would render NaN% or Infinity, and a metric
  // that renders nonsense on an empty window teaches people to distrust it.
  it("returns nothing when nothing was delivered", () => {
    expect(
      reachShare(report({ provider_accepted_recipients: 0 })),
    ).toBeUndefined();
  });
});

describe("reachCaveats", () => {
  it("is silent when the report is clean", () => {
    expect(reachCaveats(report())).toEqual([]);
  });

  // Shadow mode means the classifier is not authoritative yet. Publishing that
  // number as a result would be the most expensive possible mistake here.
  it("warns first when the classifier is in shadow mode", () => {
    const caveats = reachCaveats(report({ shadow_mode: true }));
    expect(caveats[0]).toMatch(/shadow/i);
  });

  // A window spanning two classifier versions is not one measurement. Labelling
  // it with the latest version alone is how a methodology change gets
  // backdated onto data it never described.
  it("warns when the window spans more than one classifier version", () => {
    const caveats = reachCaveats(
      report({
        mixed_classifier_versions: true,
        classifier_version_coverage: [
          {
            ...report().classifier_version_coverage[0],
            classifier_version: "v1",
            event_count: 200,
          },
          {
            ...report().classifier_version_coverage[0],
            classifier_version: "v2",
            event_count: 700,
          },
        ],
      }),
    );
    expect(caveats.join(" ")).toMatch(/more than one classifier version/i);
  });

  // An unknown band wider than the floor means the honest answer is "we mostly
  // do not know", and the reader has to be told that in words.
  it("warns when the unknown band is larger than the floor itself", () => {
    const caveats = reachCaveats(
      report({
        human_engaged_reach_floor: 30,
        unknown_band: 90,
        human_engaged_reach_upper_bound: 120,
      }),
    );
    expect(caveats.join(" ")).toMatch(/unclassified/i);
  });

  it("reports every applicable caveat, not just the first", () => {
    const caveats = reachCaveats(
      report({ shadow_mode: true, mixed_classifier_versions: true }),
    );
    expect(caveats.length).toBeGreaterThanOrEqual(2);
  });
});
