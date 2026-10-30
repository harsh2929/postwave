/**
 * The Data-cluster transport seam: five viewer reads, one envelope rule —
 * `rawRequest` resolves to {data, error}, and error becomes a THROW so a
 * failed ledger read can never render as an empty-but-healthy card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import {
  fetchSubscriberCatalogAttributes,
  fetchSubscriberCustomObjectLinks,
  fetchSubscriberDecisionExplanations,
  fetchSubscriberGpp,
  fetchSubscriberSegmentMembership,
} from "./subscribersProfileData";

beforeEach(() => rawRequest.mockReset());

describe("the five profile-data reads", () => {
  it("hit their exact paths with the id encoded", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await fetchSubscriberGpp("sub 1");
    await fetchSubscriberCustomObjectLinks("sub 1");
    await fetchSubscriberCatalogAttributes("sub 1");
    await fetchSubscriberSegmentMembership("sub 1");
    await fetchSubscriberDecisionExplanations("sub 1");
    expect(rawRequest.mock.calls.map((c) => c[1])).toEqual([
      "/api/v1/subscribers/sub%201/gpp",
      "/api/v1/subscribers/sub%201/custom-objects",
      "/api/v1/subscribers/sub%201/catalog-attributes",
      "/api/v1/subscribers/sub%201/segment-membership",
      "/api/v1/subscribers/sub%201/decision-explanations",
    ]);
    expect(rawRequest.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  });

  it("throws the envelope's error with its fields attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "nope", status: 403 },
    });
    await expect(fetchSubscriberGpp("sub-1")).rejects.toMatchObject({
      message: "nope",
      status: 403,
    });
  });
});
