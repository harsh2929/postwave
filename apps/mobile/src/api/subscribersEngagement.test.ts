/**
 * The engagement-explorer transport: exact paths, the banded browse query
 * string, and the envelope THROW rule. No recompute function exists in this
 * module — the server holds that verb, and a test pins the absence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import * as engagement from "./subscribersEngagement";

beforeEach(() => rawRequest.mockReset());

describe("engagement transport", () => {
  it("requests the banded browse with min/max/page/per_page", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await engagement.fetchScoredSubscribers({ min: 10, max: 19, page: 2 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/engagement-scores/subscribers?min=10&max=19&page=2&per_page=50",
    );
  });

  it("omits absent band bounds entirely", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await engagement.fetchScoredSubscribers({ min: null, max: null, page: 1 });
    expect(rawRequest.mock.calls[0]![1]).toBe(
      "/api/v1/engagement-scores/subscribers?page=1&per_page=50",
    );
  });

  it("PUTs the rule set and throws envelope errors (409 conflict included)", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "Scoring rules changed after this draft loaded.", status: 409 },
    });
    await expect(
      engagement.putScoringRules({ rules: [], expected_version: "v1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(rawRequest).toHaveBeenCalledWith("PUT", "/api/v1/scoring/rules", {
      rules: [],
      expected_version: "v1",
    });
  });

  it("exports NO recompute call — the server holds that verb", () => {
    expect(
      Object.keys(engagement).filter((k) => /recompute/i.test(k)),
    ).toEqual([]);
  });
});
