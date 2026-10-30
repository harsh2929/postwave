import { describe, expect, it, vi } from "vitest";

// The module reaches for the RN-bound API client at call time only; the pure
// parser below is what this file exercises.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import {
  ANOMALY_BRIEF_METRICS,
  AnomalyBriefUnreadableError,
  isAnomalyBriefMetric,
  parseAnomalyBrief,
} from "./anomalyBrief";

const ok = {
  metric: "bounces",
  window_days: 7,
  summary: "Bounces rose 3x on Tuesday, concentrated in one campaign.",
  probable_causes: ["A stale imported list", "A provider-side block"],
  suggested_actions: ["Check the Tuesday send", "Review the imported segment"],
  aggregates: { current_total: 412, previous_total: 130 },
};

describe("isAnomalyBriefMetric", () => {
  it("mirrors the server whitelist exactly", () => {
    // Verified against apps/api/internal/nql/anomaly_brief.go. Offering a
    // metric outside it means an "Explain" button that always 422s.
    expect([...ANOMALY_BRIEF_METRICS]).toEqual([
      "opens",
      "clicks",
      "bounces",
      "complaints",
      "unsubscribes",
      "revenue",
    ]);
    // Charted on the dashboard, NOT accepted by the brief endpoint.
    expect(isAnomalyBriefMetric("subscribers")).toBe(false);
    expect(isAnomalyBriefMetric("bounces")).toBe(true);
    expect(isAnomalyBriefMetric(undefined)).toBe(false);
  });
});

describe("parseAnomalyBrief", () => {
  it("keeps the aggregates the prose was written from", () => {
    const brief = parseAnomalyBrief(ok);
    expect(brief.summary).toContain("Bounces rose");
    expect(brief.currentTotal).toBe(412);
    expect(brief.previousTotal).toBe(130);
    expect(brief.windowDays).toBe(7);
    expect(brief.probableCauses).toHaveLength(2);
  });

  it("treats a summary-less body as unusable, not as an empty brief", () => {
    // Empty bullet lists under a blank heading read as "the AI has nothing to
    // say about your bounce spike", which is a different claim from "the
    // request failed".
    expect(() => parseAnomalyBrief({ ...ok, summary: "   " })).toThrow(
      AnomalyBriefUnreadableError,
    );
    expect(() => parseAnomalyBrief(null)).toThrow(AnomalyBriefUnreadableError);
    expect(() => parseAnomalyBrief([ok])).toThrow(AnomalyBriefUnreadableError);
  });

  it("drops non-string bullets rather than rendering [object Object]", () => {
    const brief = parseAnomalyBrief({
      ...ok,
      probable_causes: ["real", { nope: 1 }, "", 42, "also real"],
      suggested_actions: "not a list",
    });
    expect(brief.probableCauses).toEqual(["real", "also real"]);
    expect(brief.suggestedActions).toEqual([]);
  });

  it("reports absent aggregates as null instead of zero", () => {
    const brief = parseAnomalyBrief({ summary: "Something moved." });
    expect(brief.currentTotal).toBeNull();
    expect(brief.previousTotal).toBeNull();
    expect(brief.windowDays).toBe(0);
  });

  it("echoes the metric the SERVER answered about", () => {
    // If the server answered about a different metric than we asked for, the
    // sheet must label what it got.
    expect(parseAnomalyBrief({ ...ok, metric: "clicks" }).metric).toBe(
      "clicks",
    );
  });
});
