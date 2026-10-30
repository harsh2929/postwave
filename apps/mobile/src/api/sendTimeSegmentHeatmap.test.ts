/**
 * The transport seam for the scoped send-time week.
 *
 * This is the seam that goes untested by habit: parser tests prove the shape
 * and mocked-hook tests prove the render, and the function that actually builds
 * the URL and reads the error body sits between them, uncovered. Two things
 * only a test HERE can hold:
 *
 *   - the query parameter is `segment_id` (the handler 400s `missing_params`
 *     without it, and a typo would look like an empty workspace forever);
 *   - a 404 is turned into a VALUE carrying the server's sentence, not into a
 *     throw. `checkedApiResult` drops `payload`, so routing this call through
 *     it would lose the one thing the refusal is worth reading.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSegmentSendTimeHeatmap, segmentHeatmapPath } from "./sendTimeSegmentHeatmap";
import { rawRequest } from "./request";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const mocked = vi.mocked(rawRequest);

function week(value: number): number[][] {
  return Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => value),
  );
}

beforeEach(() => {
  mocked.mockReset();
});

describe("segmentHeatmapPath", () => {
  it("asks by segment_id and escapes it", () => {
    expect(segmentHeatmapPath("seg-1")).toBe(
      "/api/v1/send-time-opt/heatmap?segment_id=seg-1",
    );
    expect(segmentHeatmapPath("a b/c")).toContain("segment_id=a+b%2Fc");
  });
});

describe("fetchSegmentSendTimeHeatmap", () => {
  it("GETs the scoped path and parses the week", async () => {
    mocked.mockResolvedValue({
      data: { segment_id: "seg-1", subscribers_with_data: 88, grid: week(0.01) },
      error: null,
    });
    const outcome = await fetchSegmentSendTimeHeatmap("seg-1");
    expect(mocked).toHaveBeenCalledWith(
      "GET",
      "/api/v1/send-time-opt/heatmap?segment_id=seg-1",
    );
    expect(outcome.kind).toBe("pattern");
    if (outcome.kind !== "pattern") throw new Error("unreachable");
    expect(outcome.pattern.subscribersWithData).toBe(88);
  });

  it("returns the 404 refusal as a value, with the server's sentence intact", async () => {
    mocked.mockResolvedValue({
      data: null,
      error: {
        status: 404,
        message: "not found",
        payload: {
          error: "insufficient_data",
          message: "need >= 30 subscribers with open history; have 4",
        },
      },
    });
    const outcome = await fetchSegmentSendTimeHeatmap("seg-1");
    expect(outcome).toEqual({
      kind: "refused",
      refusal: {
        code: "insufficient_data",
        message: "need >= 30 subscribers with open history; have 4",
      },
    });
  });

  it("throws — with the status kept — on a real failure", async () => {
    mocked.mockResolvedValue({
      data: null,
      error: { status: 403, message: "insufficient_role", code: "insufficient_role" },
    });
    await expect(fetchSegmentSendTimeHeatmap("seg-1")).rejects.toMatchObject({
      status: 403,
      code: "insufficient_role",
    });
  });

  it("throws rather than drawing a blank week when the answer is unreadable", async () => {
    mocked.mockResolvedValue({ data: { subscribers_with_data: 40 }, error: null });
    await expect(fetchSegmentSendTimeHeatmap("seg-1")).rejects.toThrow(
      /couldn't be read/u,
    );
  });
});
