/**
 * The PII-findings transport seam, with `rawRequest` mocked (the
 * audienceDestinations idiom): the list routes REJECT unknown query
 * parameters outright (findingFilterFromRequest fails closed), so the exact
 * query string is part of the contract — and envelopes are unwrapped with
 * errors surfaced as throws, so a refused decision can never look recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchPiiFindings,
  fetchSubscriberPiiFindings,
  reviewPiiFinding,
} from "./subscribersPiiFindings";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("the queue read", () => {
  it("sends ONLY the documented parameters, clamped to the server's bounds", async () => {
    rawRequest.mockResolvedValue({ data: { items: [], total: 0 }, error: null });
    await fetchPiiFindings({ status: "pending", page: 2, perPage: 500 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/pii-findings?status=pending&page=2&per_page=200",
    );
  });

  it("omits an empty status instead of sending status=", async () => {
    rawRequest.mockResolvedValue({ data: { items: [], total: 0 }, error: null });
    await fetchPiiFindings({ status: "", page: 1, perPage: 50 });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/pii-findings?page=1&per_page=50",
    );
  });

  it("unwraps the envelope and throws the error with its status attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(
      fetchPiiFindings({ status: "pending", page: 1, perPage: 50 }),
    ).rejects.toMatchObject({ message: "forbidden", status: 403 });
  });
});

describe("the per-subscriber read", () => {
  it("hits the profile-scoped route", async () => {
    rawRequest.mockResolvedValue({ data: { items: [], total: 0 }, error: null });
    await fetchSubscriberPiiFindings("sub 9");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub%209/pii-findings",
    );
  });
});

describe("the decision write", () => {
  const BODY = {
    status: "dismissed",
    reason: "false_positive",
    comment: "Store-issued code.",
    evidence_reference: "ticket:DPO-123",
    expected_updated_at: "2026-08-20T10:00:00Z",
  };

  it("PATCHes the body untouched", async () => {
    rawRequest.mockResolvedValue({ data: { id: "f-1" }, error: null });
    await reviewPiiFinding("f-1", BODY);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/pii-findings/f-1",
      BODY,
    );
  });

  it("surfaces a stale-row refusal as a throw", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "finding changed", status: 409 },
    });
    await expect(reviewPiiFinding("f-1", BODY)).rejects.toMatchObject({
      status: 409,
    });
  });
});
