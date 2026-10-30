// Preset segment gallery paging (full-surface wiring #25). The server's
// `count` field on /preset-segments/{key}/list is the PAGE length, not
// a total — the pager must treat a short page as authoritative end-of-
// cohort and only cite the card total as approximate.

import { describe, expect, it } from "vitest";

import {
  presetPageWindow,
  presetRecreateText,
} from "../../components/segments/preset-segments-helpers";
import type { PresetSegment } from "../../lib/api/preset-segments";

describe("presetPageWindow", () => {
  it("full first page → hasNext, no prev, approximate total cited", () => {
    const w = presetPageWindow(0, 25, 25, 1204);
    expect(w.hasPrev).toBe(false);
    expect(w.hasNext).toBe(true);
    expect(w.rangeLabel).toBe("1–25 of ~1,204");
  });

  it("short page → never claims a next page, even when the stale total disagrees", () => {
    // Card said 1204 at gallery-load time, but the cohort shrank: the
    // server returned only 3 rows for offset 25.
    const w = presetPageWindow(25, 25, 3, 1204);
    expect(w.hasPrev).toBe(true);
    expect(w.hasNext).toBe(false);
    expect(w.rangeLabel).toBe("26–28 of ~1,204");
  });

  it("empty first page → 'No members', no paging either way", () => {
    const w = presetPageWindow(0, 25, 0, 0);
    expect(w.rangeLabel).toBe("No members");
    expect(w.hasPrev).toBe(false);
    expect(w.hasNext).toBe(false);
  });

  it("empty later page (cohort shrank mid-browse) → keeps Prev usable", () => {
    const w = presetPageWindow(50, 25, 0, 1204);
    expect(w.rangeLabel).toBe("No members on this page");
    expect(w.hasPrev).toBe(true);
    expect(w.hasNext).toBe(false);
  });

  it("omits the total when unknown or zero", () => {
    expect(presetPageWindow(0, 25, 10, null).rangeLabel).toBe("1–10");
    expect(presetPageWindow(0, 25, 10, 0).rangeLabel).toBe("1–10");
  });
});

describe("presetRecreateText", () => {
  const preset = (over: Partial<PresetSegment>): PresetSegment => ({
    key: "engaged_30d",
    label: "Engaged (last 30 days)",
    description:
      "subscribers with at least one open or click in the last 30 days",
    count: 10,
    ...over,
  });

  it("uses the server's prose definition as the NL-builder seed", () => {
    expect(presetRecreateText(preset({}))).toBe(
      "subscribers with at least one open or click in the last 30 days",
    );
  });

  it("falls back to the label when the description is blank", () => {
    expect(presetRecreateText(preset({ description: "  " }))).toBe(
      "Engaged (last 30 days)",
    );
  });
});
