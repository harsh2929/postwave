// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

import { ApiError } from "@/lib/api";
import {
  createVerificationJob,
  listVerificationJobResults,
  parseVerificationAddressList,
  retainVerificationJobAttemptKey,
  VerificationContractError,
} from "@/lib/verification-api";

const KEY = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";
const JOB_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51ee";
const RECEIPT = {
  id: JOB_ID,
  status: "pending",
  source: "tag",
  execution_mode: "full",
  total: 42,
  processed: 0,
  cache_hits: 0,
  local_filtered: 0,
  vendor_verified: 0,
  credits_spent: 0,
  duplicates: 0,
  ambiguous: 0,
  attempts: 0,
  created_at: "2026-08-29T00:05:00Z",
};

function processedRow(email: string, status: string, extra: object = {}) {
  return {
    email,
    processed: true,
    status,
    billable: false,
    cached: true,
    checked_at: "2026-08-29T00:00:02Z",
    attempt_state: "succeeded",
    ...extra,
  };
}

const PENDING_ROW = {
  email: "queued@example.test",
  processed: false,
  status: "unknown",
  billable: false,
  cached: false,
  attempt_state: "pending",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("POST /api/v1/verification/jobs", () => {
  it("sends a tag run as {source, source_ref} under the caller-owned key", async () => {
    mocks.post.mockResolvedValue(RECEIPT);

    await expect(
      createVerificationJob({ source: "tag", source_ref: " vip " }, KEY),
    ).resolves.toMatchObject({ id: JOB_ID, status: "pending", source: "tag" });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/verification/jobs",
      { source: "tag", source_ref: "vip" },
      expect.objectContaining({
        idempotencyKey: KEY,
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
  });

  it("sends pasted addresses normalised and de-duplicated as an inline run", async () => {
    mocks.post.mockResolvedValue({ ...RECEIPT, source: "inline", total: 2 });

    await createVerificationJob(
      {
        source: "inline",
        emails: ["A@Example.Test", " b@example.test ", "a@example.test"],
      },
      KEY,
    );

    expect(mocks.post.mock.calls[0]?.[1]).toStrictEqual({
      source: "inline",
      emails: ["a@example.test", "b@example.test"],
    });
  });

  it("sends the whole-directory scope as exactly {source: all_subscribers}", async () => {
    mocks.post.mockResolvedValue({ ...RECEIPT, source: "all_subscribers" });

    await createVerificationJob({ source: "all_subscribers" }, KEY);

    expect(mocks.post.mock.calls[0]?.[1]).toStrictEqual({
      source: "all_subscribers",
    });
  });

  it("refuses a malformed draft or key before any request is sent", async () => {
    await expect(
      createVerificationJob({ source: "inline", emails: [] }, KEY),
    ).rejects.toThrow("at least one address");
    await expect(
      createVerificationJob({ source: "inline", emails: ["nope"] }, KEY),
    ).rejects.toThrow("well-formed email");
    await expect(
      createVerificationJob({ source: "tag", source_ref: "   " }, KEY),
    ).rejects.toThrow("exact tag");
    await expect(
      createVerificationJob({ source: "all_subscribers" }, " padded "),
    ).rejects.toThrow("idempotency key");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose source is not the one requested", async () => {
    mocks.post.mockResolvedValue({ ...RECEIPT, source: "inline" });

    await expect(
      createVerificationJob({ source: "tag", source_ref: "vip" }, KEY),
    ).rejects.toBeInstanceOf(VerificationContractError);
  });

  it("keeps the billing key only when the request may have crossed the wire", () => {
    expect(
      retainVerificationJobAttemptKey(
        new ApiError("mismatch", 422, undefined, {
          code: "idempotency_key_request_mismatch",
        }),
      ),
    ).toBe(false);
    expect(
      retainVerificationJobAttemptKey(
        new ApiError("held", 503, undefined, {
          code: "verification_bulk_unavailable",
        }),
      ),
    ).toBe(true);
    expect(retainVerificationJobAttemptKey(new Error("contract"))).toBe(true);
  });
});

describe("GET /api/v1/verification/jobs/{id}/results", () => {
  it("requests one page plus a sentinel row under the status filter and offset", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      processedRow(`bad${index}@example.test`, "invalid"),
    );
    mocks.get.mockResolvedValue({ results: rows });

    const page = await listVerificationJobResults(JOB_ID, {
      status: "invalid",
      offset: 100,
    });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls[0]?.[0]).toBe(
      `/api/v1/verification/jobs/${JOB_ID}/results?limit=101&offset=100&status=invalid`,
    );
    expect(page.results).toHaveLength(100);
    expect(page.has_more).toBe(true);
    expect(page.offset).toBe(100);
    expect(page.results[0]).toMatchObject({
      email: "bad0@example.test",
      status: "invalid",
      processed: true,
    });
  });

  it("omits the status parameter for the unfiltered page and reports no more rows", async () => {
    mocks.get.mockResolvedValue({
      results: [
        processedRow("ok@example.test", "valid", {
          billable: true,
          cached: false,
          provider: "kickbox",
          score: 9,
        }),
        processedRow("bad@example.test", "invalid", {
          sub_status: "mailbox_not_found",
          did_you_mean: "bad@example.com",
        }),
        PENDING_ROW,
      ],
    });

    const page = await listVerificationJobResults(JOB_ID);

    expect(mocks.get.mock.calls[0]?.[0]).toBe(
      `/api/v1/verification/jobs/${JOB_ID}/results?limit=101&offset=0`,
    );
    expect(page.has_more).toBe(false);
    expect(page.results.map((row) => row.email)).toEqual([
      "ok@example.test",
      "bad@example.test",
      "queued@example.test",
    ]);
    expect(page.results[1]).toMatchObject({
      sub_status: "mailbox_not_found",
      did_you_mean: "bad@example.com",
    });
    expect(page.results[2]).toMatchObject({
      processed: false,
      attempt_state: "pending",
    });
  });

  it("fails closed on rows outside the filter or the stored-row invariants", async () => {
    mocks.get.mockResolvedValue({
      results: [processedRow("ok@example.test", "valid")],
    });
    await expect(
      listVerificationJobResults(JOB_ID, { status: "invalid" }),
    ).rejects.toBeInstanceOf(VerificationContractError);

    mocks.get.mockResolvedValue({
      results: [{ ...processedRow("x@example.test", "valid"), checked_at: undefined }],
    });
    await expect(listVerificationJobResults(JOB_ID)).rejects.toBeInstanceOf(
      VerificationContractError,
    );

    mocks.get.mockResolvedValue({
      results: [{ ...PENDING_ROW, attempt_state: "retrying" }],
    });
    await expect(listVerificationJobResults(JOB_ID)).rejects.toBeInstanceOf(
      VerificationContractError,
    );

    await expect(listVerificationJobResults("not-a-uuid")).rejects.toThrow(
      "invalid",
    );
  });
});

describe("parseVerificationAddressList", () => {
  it("splits on separators, folds case, and reports duplicates and non-addresses", () => {
    expect(
      parseVerificationAddressList(
        "A@x.test, a@x.test; b@x.test\nnot-an-email  c@x.test",
      ),
    ).toEqual({
      emails: ["a@x.test", "b@x.test", "c@x.test"],
      invalid: ["not-an-email"],
      duplicates: 1,
    });
  });
});
