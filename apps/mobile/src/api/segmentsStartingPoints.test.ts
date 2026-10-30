/**
 * The starting-points catalogue: three sources merged best-effort. The
 * seams that matter: (1) each parser reads its real server shape, (2) one
 * failed source is NAMED rather than collapsing the catalogue, (3) all
 * three failing throws — "nothing exists" and "nothing loaded" are
 * different sentences — and (4) the AI disclosure notice rides along.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSegmentStartingPoints } from "./segmentsStartingPoints";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

const PRESETS = {
  items: [
    { key: "engaged-30d", label: "Engaged (30d)", description: "Opened or clicked in the last 30 days", count: 812 },
  ],
};
const TEMPLATES = {
  items: [
    {
      key: "churn-risk",
      label: "Churn risk",
      description: "High predicted churn score",
      icon_hint: "trending-down",
      category: "predictive",
      suggested_name: "Churn risk — act this week",
    },
  ],
};
const AI = {
  items: [
    {
      key: "quiet-vips",
      name: "Quiet VIPs",
      description: "tagged vip and no opens in 60 days",
      predicate_json: { op: "and" },
      estimated_size: 44,
      rationale: "You have 200 vip-tagged subscribers and falling opens",
      category: "engagement",
    },
  ],
  generated: "heuristic",
  notice: "Suggestions are ranked by a rule engine over your own data.",
};

function respondByPath(map: Record<string, unknown>) {
  rawRequest.mockImplementation(async (_m: string, path: string) => {
    if (path in map) return { data: map[path], error: null };
    return { data: null, error: { message: "boom", status: 500 } };
  });
}

const P = "/api/v1/preset-segments";
const T = "/api/v1/segments/templates";
const A = "/api/v1/segments/ai-suggestions";

describe("fetchSegmentStartingPoints", () => {
  it("merges the three sources, AI first, with seeds for the describe sheet", async () => {
    respondByPath({ [P]: PRESETS, [T]: TEMPLATES, [A]: AI });
    const out = await fetchSegmentStartingPoints();
    expect(out.items.map((i) => i.key)).toEqual([
      "ai:quiet-vips",
      "preset:engaged-30d",
      "template:churn-risk",
    ]);
    expect(out.items[0]).toMatchObject({
      seedText: "tagged vip and no opens in 60 days",
      seedName: "Quiet VIPs",
      size: 44,
    });
    expect(out.items[2]).toMatchObject({
      seedName: "Churn risk — act this week",
    });
    expect(out.aiNotice).toContain("rule engine");
    expect(out.failedSources).toEqual([]);
  });

  it("names a failed source instead of collapsing the catalogue", async () => {
    respondByPath({ [P]: PRESETS, [T]: TEMPLATES });
    const out = await fetchSegmentStartingPoints();
    expect(out.items).toHaveLength(2);
    expect(out.failedSources).toEqual(["ai"]);
  });

  it("throws when every source failed — that is not an empty catalogue", async () => {
    respondByPath({});
    await expect(fetchSegmentStartingPoints()).rejects.toThrow(
      /starting points/i,
    );
  });
});
