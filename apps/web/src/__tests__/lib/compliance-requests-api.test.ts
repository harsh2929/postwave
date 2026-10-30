// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));

import * as sarApi from "@/lib/compliance-requests-api";
import {
  ARTICLE_17_ERASURE_HOLD_CODE,
  ARTICLE_17_ERASURE_HOLD_REASON,
  createSarAccessRequest,
  listSarRequests,
  listSarStoreResponses,
  normalizeSarEmail,
  sarAccessDownloadPath,
  SarContractError,
  SarInputError,
} from "@/lib/compliance-requests-api";

const REQUEST_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51aa";
const STORE_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51bb";
const REQUESTED_AT = "2026-09-03T10:00:00Z";
const READY_AT = "2026-09-03T10:00:01Z";

const REQUEST = {
  id: REQUEST_ID,
  kind: "access",
  subscriber_email: "reader@example.com",
  status: "ready",
  event_count: 12,
  consent_count: 2,
  bundle_bytes: 2048,
  requested_by: "admin:owner@example.com",
  requested_at: REQUESTED_AT,
  ready_at: READY_AT,
  region: "GDPR",
  error: "",
};

const STORE_RESPONSE = {
  id: STORE_ID,
  provider: "shopify",
  customer_id: "gid://shopify/Customer/7",
  status: "returned",
  receipt_url: "https://receipts.example.test/sar/7",
  created_at: READY_AT,
};

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
});

describe("subject-access browser contract", () => {
  it("parses a bounded list without converting a failed read into empty", async () => {
    const controller = new AbortController();
    apiMocks.get.mockResolvedValue({ requests: [REQUEST], count: 1 });

    await expect(
      listSarRequests({
        email: " Reader@Example.com ",
        limit: 25,
        signal: controller.signal,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: REQUEST_ID,
        kind: "access",
        subscriberEmail: "reader@example.com",
        requestedAt: REQUESTED_AT,
        bundleBytes: 2048,
      }),
    ]);
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/sar/requests?email=reader%40example.com&limit=25",
      { cache: "no-store", signal: controller.signal },
    );

    const failure = new Error("inventory unavailable");
    apiMocks.get.mockRejectedValueOnce(failure);
    await expect(listSarRequests()).rejects.toBe(failure);
  });

  it("creates only an explicit read-only access request with one stable key", async () => {
    const controller = new AbortController();
    apiMocks.post.mockResolvedValue({
      id: REQUEST_ID,
      kind: "access",
      subscriber_email: "reader@example.com",
      status: "ready",
      event_count: 12,
      consent_count: 2,
      bundle_bytes: 2048,
      download_url: `/api/v1/sar/requests/${REQUEST_ID}.zip`,
      store_responses: [
        {
          provider: "shopify",
          customer_id: "gid://shopify/Customer/7",
          status: "returned",
          action_taken: "return_only",
          receipt_url: "https://receipts.example.test/sar/7",
        },
      ],
    });

    await expect(
      createSarAccessRequest(
        {
          email: " Reader@Example.com ",
          fanoutEnabled: true,
          notes: "  support ticket 42  ",
          region: "GDPR",
        },
        {
          idempotencyKey: "018f47f2-access-intent",
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({
      id: REQUEST_ID,
      kind: "access",
      subscriberEmail: "reader@example.com",
      status: "ready",
      downloadPath: `/api/v1/sar/requests/${REQUEST_ID}.zip`,
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sar/requests",
      {
        kind: "access",
        email: "reader@example.com",
        fanout_enabled: true,
        notes: "support ticket 42",
        region: "GDPR",
      },
      {
        idempotencyKey: "018f47f2-access-intent",
        maxAttempts: 1,
        requireOnline: true,
        signal: controller.signal,
      },
    );
  });

  it("rejects invalid input before transport and preserves ambiguous failures", async () => {
    expect(() => normalizeSarEmail("not-an-email")).toThrow(SarInputError);
    await expect(
      createSarAccessRequest(
        { email: "reader@example.com", fanoutEnabled: true },
        { idempotencyKey: "" },
      ),
    ).rejects.toBeInstanceOf(SarInputError);
    expect(apiMocks.post).not.toHaveBeenCalled();

    const ambiguous = Object.assign(new Error("request outcome unknown"), {
      code: "network",
    });
    apiMocks.post.mockRejectedValueOnce(ambiguous);
    await expect(
      createSarAccessRequest(
        { email: "reader@example.com", fanoutEnabled: false },
        { idempotencyKey: "stable-ambiguous-intent" },
      ),
    ).rejects.toBe(ambiguous);
  });

  it("rejects malformed or destructive response claims", async () => {
    apiMocks.get.mockResolvedValueOnce({ requests: [REQUEST], count: 2 });
    await expect(listSarRequests()).rejects.toBeInstanceOf(SarContractError);

    apiMocks.post.mockResolvedValueOnce({
      id: REQUEST_ID,
      kind: "access",
      subscriber_email: "reader@example.com",
      status: "ready",
      event_count: 1,
      consent_count: 1,
      bundle_bytes: 10,
      download_url: "javascript:alert(1)",
    });
    await expect(
      createSarAccessRequest(
        { email: "reader@example.com", fanoutEnabled: false },
        { idempotencyKey: "malformed-receipt" },
      ),
    ).rejects.toBeInstanceOf(SarContractError);

    apiMocks.get.mockResolvedValueOnce({
      request_id: REQUEST_ID,
      store_responses: [
        { ...STORE_RESPONSE, status: "deleted", action_taken: "auto_delete" },
      ],
      count: 1,
    });
    await expect(listSarStoreResponses(REQUEST_ID)).rejects.toBeInstanceOf(
      SarContractError,
    );
  });

  it("reads bounded store receipts and allows downloads only for ready access bundles", async () => {
    apiMocks.get.mockResolvedValue({
      request_id: REQUEST_ID,
      store_responses: [STORE_RESPONSE],
      count: 1,
    });
    await expect(listSarStoreResponses(REQUEST_ID)).resolves.toEqual([
      expect.objectContaining({
        id: STORE_ID,
        provider: "shopify",
        status: "returned",
      }),
    ]);
    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/sar/requests/${REQUEST_ID}/store-responses`,
      { cache: "no-store", signal: undefined },
    );

    apiMocks.get.mockClear();
    await expect(listSarStoreResponses(`${REQUEST_ID}/other`)).rejects.toThrow(
      /bounded text|canonical UUID/i,
    );
    expect(apiMocks.get).not.toHaveBeenCalled();

    const parsed = (await listSarRequestsFromWire()).at(0)!;
    expect(sarAccessDownloadPath(parsed)).toBe(
      `/api/v1/sar/requests/${REQUEST_ID}.zip`,
    );
    expect(() =>
      sarAccessDownloadPath({ ...parsed, kind: "erase" }),
    ).toThrow(SarInputError);
  });

  it("publishes the exact fail-closed Article 17 hold without an erasure client", () => {
    expect(ARTICLE_17_ERASURE_HOLD_CODE).toBe(
      "erasure_coverage_incomplete",
    );
    expect(ARTICLE_17_ERASURE_HOLD_REASON).toBe(
      "erasure is temporarily unavailable while retained-history coverage is being completed",
    );
    expect("createSarErasureRequest" in sarApi).toBe(false);
  });
});

async function listSarRequestsFromWire() {
  apiMocks.get.mockResolvedValueOnce({ requests: [REQUEST], count: 1 });
  return listSarRequests();
}
