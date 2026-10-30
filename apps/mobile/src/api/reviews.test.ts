/**
 * The featured toggle's transport seam. The one property that matters here:
 * PATCH /reviews/{id} is a FULL-COLUMN REPLACE server-side, so the toggle
 * must send back EVERYTHING the GET returned — fields this app never parses
 * included — with only `featured` changed. A sparse body here is the
 * custom_fields-wipe bug class, on a public storefront row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setReviewFeatured } from "./reviews";
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

// A realistic server row, including fields mobile's parser DROPS (metadata,
// order_id, source_ref). Their survival through the round-trip is the test.
const SERVER_REVIEW = {
  id: "rev-1",
  product_id: "prod-1",
  order_id: "ord-77",
  source_platform: "judgeme",
  source_ref: "jm-123",
  review_type: "product",
  reviewer_name: "Ada",
  reviewer_email: "ada@example.com",
  rating: 5,
  title: "Great",
  body: "Loved it",
  status: "approved",
  verified_buyer: true,
  incentivized: false,
  featured: false,
  moderation_reason: "",
  metadata: { locale: "en" },
};

describe("setReviewFeatured", () => {
  it("re-reads the raw record and PATCHes it back verbatim with featured flipped", async () => {
    mockedRaw
      .mockResolvedValueOnce({ data: SERVER_REVIEW, error: null })
      .mockResolvedValueOnce({
        data: { ...SERVER_REVIEW, featured: true },
        error: null,
      });

    const updated = await setReviewFeatured("rev-1", true);

    expect(mockedRaw).toHaveBeenNthCalledWith(1, "GET", "/api/v1/reviews/rev-1");
    expect(mockedRaw).toHaveBeenNthCalledWith(2, "PATCH", "/api/v1/reviews/rev-1", {
      ...SERVER_REVIEW,
      featured: true,
    });
    // The fields the parser drops MUST still be in the PATCH body — the
    // server replaces every column with what this body says.
    const patchBody = mockedRaw.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(patchBody.order_id).toBe("ord-77");
    expect(patchBody.source_ref).toBe("jm-123");
    expect(patchBody.metadata).toEqual({ locale: "en" });
    expect(patchBody.rating).toBe(5);
    expect(updated?.featured).toBe(true);
  });

  it("refuses to PATCH when the pre-read failed — never a blank replace", async () => {
    mockedRaw.mockResolvedValueOnce({
      data: null,
      error: { message: "not found", status: 404 },
    });
    await expect(setReviewFeatured("rev-1", true)).rejects.toMatchObject({
      status: 404,
    });
    expect(mockedRaw).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused PATCH as a throw", async () => {
    mockedRaw
      .mockResolvedValueOnce({ data: SERVER_REVIEW, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "admin role required", status: 403 },
      });
    await expect(setReviewFeatured("rev-1", true)).rejects.toMatchObject({
      status: 403,
    });
  });
});
