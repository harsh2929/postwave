/**
 * The demographics read's transport seam: the {data, error} ENVELOPE is
 * unwrapped here and an error becomes a THROW — a failed read must never
 * reach the parser as a payload (the silently-empty-screen class from the
 * mobile logic audit).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import { fetchSubscriberDemographics } from "./subscribersDemographics";

beforeEach(() => rawRequest.mockReset());

describe("GET /subscribers/{id}/demographics", () => {
  it("unwraps the envelope and returns data", async () => {
    rawRequest.mockResolvedValue({
      data: { gender: { value: "female" } },
      error: null,
    });
    await expect(fetchSubscriberDemographics("sub 1")).resolves.toEqual({
      gender: { value: "female" },
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub%201/demographics",
    );
  });

  it("surfaces the envelope's error as a throw carrying its fields", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(fetchSubscriberDemographics("sub-1")).rejects.toMatchObject({
      message: "forbidden",
      status: 403,
    });
  });
});
