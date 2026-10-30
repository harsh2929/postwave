/**
 * subscriberTracking — the two-layer "stop tracking me" rules.
 *
 * What must never regress: the EXPLICIT evidence layer and the EFFECTIVE
 * send-time layer (which includes GPC) stay distinct in the copy — a switch
 * position alone cannot carry "GPC is on and you may not override it" — and
 * the PATCH body touches exactly ONE dimension per decision.
 */
import { describe, expect, it } from "vitest";

import {
  buildTrackingPatchBody,
  parseTrackingPrefs,
  trackingDimensionSummary,
} from "./subscriberTracking";

describe("parseTrackingPrefs", () => {
  it("parses the consent.TrackingPrefs body", () => {
    expect(
      parseTrackingPrefs({
        subscriber_id: "sub-1",
        open_opt_out_at: "2026-08-01T00:00:00Z",
        click_opt_out_at: null,
        effective_open_opt_out: true,
        effective_click_opt_out: true,
        gpc: true,
        source: "gpc",
      }),
    ).toEqual({
      subscriberId: "sub-1",
      openOptOutAt: "2026-08-01T00:00:00Z",
      clickOptOutAt: null,
      effectiveOpenOptOut: true,
      effectiveClickOptOut: true,
      gpc: true,
      source: "gpc",
    });
  });

  it("returns null for junk instead of a fake row", () => {
    expect(parseTrackingPrefs(null)).toBeNull();
    expect(parseTrackingPrefs("nope")).toBeNull();
    expect(parseTrackingPrefs({ gpc: true })).toBeNull(); // no subscriber_id
  });
});

describe("trackingDimensionSummary — the layered truth", () => {
  it("GPC + explicit opt-out names both facts", () => {
    expect(trackingDimensionSummary("Open", true, true, true)).toBe(
      "Open tracking is off: the subscriber opted out AND their browser sends Global Privacy Control.",
    );
  });

  it("GPC-only says an explicit opt-out may be recorded but GPC never overridden", () => {
    expect(trackingDimensionSummary("Click", false, true, true)).toBe(
      "Click tracking is off by Global Privacy Control. Recording an explicit opt-out is allowed; overriding GPC is not.",
    );
  });

  it("plain opt-out and plain on-states", () => {
    expect(trackingDimensionSummary("Open", true, true, false)).toBe(
      "Open tracking is off for this subscriber.",
    );
    expect(trackingDimensionSummary("Open", false, false, false)).toBe(
      "Open tracking is on for this subscriber.",
    );
  });
});

describe("buildTrackingPatchBody — one dimension per decision", () => {
  it("sends only the touched key", () => {
    expect(buildTrackingPatchBody("open", true)).toEqual({
      open_opt_out: true,
    });
    expect(buildTrackingPatchBody("click", false)).toEqual({
      click_opt_out: false,
    });
    // Never both: an omitted key inherits server-side.
    expect(Object.keys(buildTrackingPatchBody("open", true))).toHaveLength(1);
  });
});
