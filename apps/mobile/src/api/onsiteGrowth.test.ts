/**
 * The onsite-growth transport seam — the audienceDestinations idiom, plus the
 * two properties specific to this surface: the 404 resting state on the
 * targeting read, and the full-replace PUT arriving with every column.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchOnsiteExperiments,
  fetchOnsiteSpinRewards,
  fetchOnsiteTargeting,
  putOnsiteTargeting,
} from "./onsiteGrowth";
import { rawRequest } from "./request";

vi.mock("./request", () => {
  const checkedApiResult = async (
    promise: Promise<{
      data: unknown;
      error: { message: string; status: number } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      const error = new Error(result.error.message) as Error & {
        status?: number;
      };
      error.status = result.error.status;
      throw error;
    }
    return result;
  };
  return { rawRequest: vi.fn(), checkedApiResult };
});

const mockedRaw = vi.mocked(rawRequest);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchOnsiteTargeting", () => {
  it("parses the bare record the handler writes", async () => {
    mockedRaw.mockResolvedValue({
      data: { form_id: "f-1", status: "published", trigger: { type: "delay" } },
      error: null,
    });
    const targeting = await fetchOnsiteTargeting("f-1");
    expect(mockedRaw).toHaveBeenCalledWith(
      "GET",
      "/api/v1/onsite-growth/forms/f-1/targeting",
    );
    expect(targeting?.status).toBe("published");
    expect(targeting?.triggerType).toBe("delay");
  });

  it("maps a 404 to null — never-configured is a resting state, not an error", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "not found", status: 404 },
    });
    await expect(fetchOnsiteTargeting("f-1")).resolves.toBeNull();
  });

  it("still throws every non-404 failure", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "boom", status: 500 },
    });
    await expect(fetchOnsiteTargeting("f-1")).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("the {items} reads", () => {
  it("unwraps experiments and spin rewards from their envelopes", async () => {
    mockedRaw.mockResolvedValueOnce({
      data: { items: [{ key: "e1", name: "Test", status: "running", variants: [] }] },
      error: null,
    });
    const experiments = await fetchOnsiteExperiments("f-1");
    expect(experiments).toHaveLength(1);
    expect(mockedRaw).toHaveBeenCalledWith(
      "GET",
      "/api/v1/onsite-growth/forms/f-1/experiments",
    );

    mockedRaw.mockResolvedValueOnce({
      data: { items: [{ key: "r1", label: "10% off", status: "active" }] },
      error: null,
    });
    const rewards = await fetchOnsiteSpinRewards("f-1");
    expect(rewards[0]?.label).toBe("10% off");
    expect(mockedRaw).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/onsite-growth/forms/f-1/spin/rewards",
    );
  });
});

describe("putOnsiteTargeting", () => {
  it("PUTs the body verbatim to the targeting path", async () => {
    const body = {
      form_id: "f-1",
      status: "paused",
      url_rules: { include: ["/pricing"] },
    };
    mockedRaw.mockResolvedValue({ data: body, error: null });
    await putOnsiteTargeting("f-1", body);
    expect(mockedRaw).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/onsite-growth/forms/f-1/targeting",
      body,
    );
  });

  it("throws a 422 validation refusal instead of pretending it saved", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "targeting.status must be draft|published|paused|archived", status: 422 },
    });
    await expect(
      putOnsiteTargeting("f-1", { status: "live" }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
