/**
 * Holdout / optimizer / remix transport: exact routes and bodies, and the
 * one policy this file encodes — the optimizer's PERSISTED-run POST is not
 * exported at all (dispatch does not consume runs yet; desktop disables it
 * for the same reason).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as measure from "./campaignMeasure";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: {}, error: null });
});

describe("measure transport", () => {
  it("holdout create/read/remove hit …/campaigns/{id}/holdout", async () => {
    await measure.createCampaignHoldout("c1", 10);
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/campaigns/c1/holdout",
      { percent: 10 },
    );
    await measure.getCampaignHoldout("c1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/campaigns/c1/holdout",
    );
    await measure.deleteCampaignHoldout("c1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "DELETE",
      "/api/v1/campaigns/c1/holdout",
    );
  });

  it("optimizer: GET run + POST preview only — no persisted-run POST exists", async () => {
    await measure.getContentOptimizerRun("c1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/campaigns/c1/content-optimizer",
    );
    await measure.previewContentOptimizer("c1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/campaigns/c1/content-optimizer/preview",
      {},
    );
    // The phantom-control guard: creating a persisted run must not be
    // reachable from this module while dispatch ignores runs.
    expect(
      Object.keys(measure).filter((k) => /create.*[Oo]ptimizer|createRun/.test(k)),
    ).toEqual([]);
  });

  it("remix: POST …/campaigns/{id}/remix with an empty body", async () => {
    await measure.remixCampaignContent("c/1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/campaigns/c%2F1/remix",
      {},
    );
  });
});
