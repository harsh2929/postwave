// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import {
  SuppressionAdminContractError,
  changeSelectedSuppressionReason,
  mirrorSuppressionsFromProvider,
  selectedSuppressionTargets,
} from "@/lib/suppressions-admin-api";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: mocks.post },
  };
});

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "018f0f5e-7b2d-7000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selectedSuppressionTargets", () => {
  it("normalizes and freezes unique canonical row identities", () => {
    expect(
      selectedSuppressionTargets([
        {
          id: ID_A.toUpperCase(),
          email: " Ada@Example.COM ",
          reason: "hard_bounce",
        },
      ]),
    ).toEqual([{ id: ID_A, email: "ada@example.com", reason: "hard_bounce" }]);
  });

  it.each([
    { entries: [{ id: "legacy_1", email: "a@example.com" }] },
    { entries: [{ id: ID_A, email: "not-an-email" }] },
    {
      entries: [
        { id: ID_A, email: "erased@example.com", reason: "dsar_deletion" },
      ],
    },
    {
      entries: [
        { id: ID_A, email: "a@example.com" },
        { id: ID_A, email: "b@example.com" },
      ],
    },
    {
      entries: [
        { id: ID_A, email: "a@example.com" },
        { id: ID_B, email: "A@example.com" },
      ],
    },
  ])(
    "rejects an ambiguous or non-canonical scope ($entries)",
    ({ entries }) => {
      expect(() => selectedSuppressionTargets(entries)).toThrow(
        SuppressionAdminContractError,
      );
    },
  );
});

describe("changeSelectedSuppressionReason", () => {
  it("sends only reviewed canonical IDs with stable online-only options", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({ updated_count: 1, errors: [] });

    await expect(
      changeSelectedSuppressionReason(
        [{ id: ID_A, email: "a@example.com", reason: "hard_bounce" }],
        "manual_unsubscribe",
        { idempotencyKey: IDEMPOTENCY_KEY, signal },
      ),
    ).resolves.toEqual({
      requested: 1,
      updated: 1,
      failed: 0,
      missing: 0,
      errors: [],
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/suppressions/bulk-action",
      {
        ids: [ID_A],
        action: "change_reason",
        reason: "manual_unsubscribe",
      },
      {
        signal,
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        timeoutMs: 65_000,
      },
    );
  });

  it("reports lookup failures and silently missing rows separately", async () => {
    mocks.post.mockResolvedValue({
      updated_count: 1,
      errors: [`${ID_B}: lookup failed`],
    });
    await expect(
      changeSelectedSuppressionReason(
        [
          { id: ID_A, email: "a@example.com" },
          { id: ID_B, email: "b@example.com" },
          {
            id: "33333333-3333-4333-8333-333333333333",
            email: "c@example.com",
          },
        ],
        "list_manual",
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).resolves.toMatchObject({
      requested: 3,
      updated: 1,
      failed: 1,
      missing: 1,
    });
  });

  it.each([
    { updated_count: 2, errors: [] },
    { updated_count: 1, errors: ["one", "two"] },
    { updated_count: -1, errors: [] },
    { updated_count: 0, errors: "none" },
  ])("rejects a response that cannot reconcile (%j)", async (wire) => {
    mocks.post.mockResolvedValue(wire);
    await expect(
      changeSelectedSuppressionReason(
        [{ id: ID_A, email: "a@example.com" }],
        "list_manual",
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toBeInstanceOf(SuppressionAdminContractError);
  });

  it("rejects invalid idempotency before issuing a request", async () => {
    await expect(
      changeSelectedSuppressionReason(
        [{ id: ID_A, email: "a@example.com" }],
        "list_manual",
        { idempotencyKey: "retry-me" },
      ),
    ).rejects.toBeInstanceOf(SuppressionAdminContractError);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("refuses to create or rewrite DSAR evidence through reclassification", async () => {
    await expect(
      changeSelectedSuppressionReason(
        [{ id: ID_A, email: "a@example.com", reason: "list_manual" }],
        "dsar_deletion",
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toThrow(/canonical suppression reason/i);
    await expect(
      changeSelectedSuppressionReason(
        [{ id: ID_A, email: "a@example.com", reason: "dsar_deletion" }],
        "list_manual",
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toThrow(/permanent/i);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("mirrorSuppressionsFromProvider", () => {
  it("strictly reconciles a bounded provider summary", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({
      provider: "sendgrid",
      fetched: 5,
      imported: 2,
      skipped: 2,
      errors: 1,
      window_from: "2026-08-23T10:00:00Z",
      window_to: "2026-08-30T10:00:00Z",
    });

    await expect(
      mirrorSuppressionsFromProvider("sendgrid", {
        idempotencyKey: IDEMPOTENCY_KEY,
        signal,
      }),
    ).resolves.toMatchObject({
      provider: "sendgrid",
      fetched: 5,
      imported: 2,
      skipped: 2,
      errors: 1,
      not_configured: false,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/suppressions/mirror/sendgrid",
      {},
      expect.objectContaining({
        signal,
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );
  });

  it("returns a validated 503 not-configured state without hiding other failures", async () => {
    mocks.post.mockRejectedValue(
      new ApiError("unavailable", 503, {
        provider: "mailchimp",
        fetched: 0,
        imported: 0,
        skipped: 0,
        errors: 0,
        window_from: "",
        window_to: "",
        not_configured: true,
        not_configured_reason: "credential not configured",
      }),
    );
    await expect(
      mirrorSuppressionsFromProvider("mailchimp", {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toEqual({
      provider: "mailchimp",
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      not_configured: true,
      not_configured_reason: "credential not configured",
    });

    const genuine = new ApiError("provider failed", 502, {
      error: "provider_failed",
    });
    mocks.post.mockRejectedValueOnce(genuine);
    await expect(
      mirrorSuppressionsFromProvider("mailchimp", {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBe(genuine);

    const genericUnavailable = new ApiError("temporarily unavailable", 503, {
      error: "provider_unavailable",
    });
    mocks.post.mockRejectedValueOnce(genericUnavailable);
    await expect(
      mirrorSuppressionsFromProvider("mailchimp", {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBe(genericUnavailable);
  });

  it.each([
    {
      provider: "mailchimp",
      fetched: 4,
      imported: 1,
      skipped: 1,
      errors: 1,
      window_from: "2026-08-23T10:00:00Z",
      window_to: "2026-08-30T10:00:00Z",
    },
    {
      provider: "sendgrid",
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      window_from: "2026-08-23T10:00:00Z",
      window_to: "2026-08-30T10:00:00Z",
    },
    {
      provider: "mailchimp",
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      window_from: "later",
      window_to: "earlier",
    },
  ])("rejects malformed or substituted mirror evidence (%j)", async (wire) => {
    mocks.post.mockResolvedValue(wire);
    await expect(
      mirrorSuppressionsFromProvider("mailchimp", {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(SuppressionAdminContractError);
  });
});
