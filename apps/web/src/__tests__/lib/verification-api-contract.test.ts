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

import {
  cancelVerificationJob,
  deleteVerificationProvider,
  getVerificationCache,
  getVerificationCredits,
  getVerificationJob,
  getVerificationPolicy,
  getVerificationProviders,
  listVerificationJobs,
  saveVerificationPolicy,
  saveVerificationProvider,
  VerificationContractError,
  verifyAddress,
} from "@/lib/verification-api";

const JOB = {
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
  status: "running",
  source: "inline",
  execution_mode: "full",
  total: 10,
  processed: 3,
  cache_hits: 1,
  local_filtered: 1,
  vendor_verified: 1,
  credits_spent: 1,
  duplicates: 0,
  ambiguous: 0,
  attempts: 1,
  created_at: "2026-08-29T00:00:00Z",
  started_at: "2026-08-29T00:00:01Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("verification read contracts", () => {
  it("bounds and parses one billable verification with its caller-owned key", async () => {
    const key = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";
    mocks.post.mockResolvedValue({
      email: "reader@example.test",
      status: "valid",
      provider: "kickbox",
      billable: true,
      cached: false,
      checked_at: "2026-08-29T00:00:00Z",
    });

    await expect(verifyAddress(" Reader@Example.Test ", key)).resolves.toMatchObject({
      email: "reader@example.test",
      status: "valid",
      billable: true,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/verification/verify",
      { email: "reader@example.test" },
      expect.objectContaining({
        idempotencyKey: key,
        maxAttempts: 1,
        requireOnline: true,
      }),
    );

    expect(() => verifyAddress("not-an-email", key)).toThrow("invalid");
    expect(() => verifyAddress("reader@example.test", "weak-key")).toThrow(
      "invalid",
    );
  });

  it("accepts the typed production envelopes", async () => {
    mocks.get
      .mockResolvedValueOnce({ jobs: [JOB] })
      .mockResolvedValueOnce({
        usage: [
          {
            day: "2026-08-29",
            provider: "kickbox",
            verified: 3,
            credits_spent: 1,
            local_filtered: 1,
            cache_hits: 1,
          },
        ],
        totals: {
          verified: 3,
          credits_spent: 1,
          local_filtered: 1,
          cache_hits: 1,
          credits_saved: 2,
        },
        provider: "kickbox",
        balance: 42,
      })
      .mockResolvedValueOnce({
        available: ["zerobounce", "kickbox"],
        providers: [
          {
            provider: "kickbox",
            credential_ref: "primary",
            enabled: true,
            settings: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        modes: ["off", "local", "full"],
        rejectable_statuses: ["invalid", "spamtrap"],
        policy: {
          forms_mode: "local",
          forms_reject_statuses: ["invalid"],
          import_mode: "full",
        },
      })
      .mockResolvedValueOnce({
        total: 3,
        by_status: { valid: 2, unknown: 1 },
        expiring_within_7d: 1,
      });

    await expect(listVerificationJobs()).resolves.toMatchObject([
      { status: "running", total: 10, processed: 3 },
    ]);
    await expect(getVerificationCredits()).resolves.toMatchObject({
      balance: 42,
      totals: { credits_spent: 1 },
    });
    await expect(getVerificationProviders()).resolves.toMatchObject({
      available: ["zerobounce", "kickbox"],
      providers: [{ provider: "kickbox" }],
    });
    await expect(getVerificationPolicy()).resolves.toMatchObject({
      modes: ["off", "local", "full"],
      policy: { forms_mode: "local" },
    });
    await expect(getVerificationCache()).resolves.toEqual({
      total: 3,
      by_status: { valid: 2, unknown: 1 },
      expiring_within_7d: 1,
    });
  });

  it("parses a job detail only when the URL-bound id and reconciled totals agree", async () => {
    mocks.get.mockResolvedValue({
      job: JOB,
      summary: { valid: 2, unknown: 1 },
      credits_saved: 2,
      credits_spent: 1,
      is_terminal: false,
    });

    await expect(getVerificationJob(JOB.id)).resolves.toMatchObject({
      job: { id: JOB.id, status: "running" },
      summary: { valid: 2, unknown: 1 },
      credits_saved: 2,
      is_terminal: false,
    });
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/verification/jobs/${JOB.id}`,
      expect.objectContaining({ signal: undefined }),
    );

    mocks.get.mockResolvedValue({
      job: { ...JOB, id: "118f47f2-9f25-7f73-8ec6-3fd483eb51dd" },
      summary: { valid: 2, unknown: 1 },
      credits_saved: 2,
      credits_spent: 1,
      is_terminal: false,
    });
    await expect(getVerificationJob(JOB.id)).rejects.toBeInstanceOf(
      VerificationContractError,
    );
  });

  it("uses bounded online single-attempt mutations and never accepts a raw credential field", async () => {
    const providerReceipt = {
      id: "018f47f2-9f25-7f73-8ec6-3fd483eb51aa",
      provider: "kickbox",
      credential_ref: "billing-prod",
      enabled: true,
      settings: { cache_ttl_days: 30 },
      last_balance: 20,
      created_at: "2026-08-29T00:00:00Z",
      updated_at: "2026-08-29T00:00:01Z",
    };
    mocks.put.mockResolvedValueOnce(providerReceipt).mockResolvedValueOnce({
      policy: {
        forms_mode: "local",
        forms_reject_statuses: ["invalid"],
        forms_suggest_typos: false,
        import_mode: "off",
        updated_at: "2026-08-29T00:00:01Z",
      },
    });
    mocks.delete.mockResolvedValue(undefined);
    mocks.post.mockResolvedValue(undefined);
    const controller = new AbortController();

    await expect(
      saveVerificationProvider(
        "kickbox",
        {
          credential_ref: "billing-prod",
          enabled: true,
          settings: { cache_ttl_days: 30 },
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      provider: "kickbox",
      credential_ref: "billing-prod",
    });
    expect(mocks.put).toHaveBeenNthCalledWith(
      1,
      "/api/v1/verification/providers/kickbox",
      {
        credential_ref: "billing-prod",
        enabled: true,
        settings: { cache_ttl_days: 30 },
      },
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        timeoutMs: 45_000,
        signal: controller.signal,
      }),
    );
    expect(JSON.stringify(mocks.put.mock.calls[0])).not.toContain("api_key");

    await expect(
      saveVerificationPolicy(
        {
          forms_mode: "local",
          forms_reject_statuses: ["invalid"],
          forms_suggest_typos: false,
          import_mode: "off",
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ policy: { forms_mode: "local" } });
    await deleteVerificationProvider("kickbox", controller.signal);
    await cancelVerificationJob(JOB.id, controller.signal);
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/verification/providers/kickbox",
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/verification/jobs/${JOB.id}/cancel`,
      undefined,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("rejects raw or path-like credential references before transport", async () => {
    await expect(
      saveVerificationProvider("kickbox", {
        credential_ref: "../../actual-secret",
        enabled: true,
        settings: {},
      }),
    ).rejects.toThrow("Credential reference");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each([
    ["jobs", listVerificationJobs, { jobs: [{ ...JOB, status: "queued" }] }],
    [
      "credits",
      getVerificationCredits,
      {
        usage: [],
        totals: {
          verified: 0,
          credits_spent: 0,
          local_filtered: 0,
          cache_hits: 0,
          credits_saved: 1,
        },
        provider: null,
        balance: null,
      },
    ],
    [
      "providers",
      getVerificationProviders,
      { available: ["invented"], providers: [] },
    ],
    [
      "policy",
      getVerificationPolicy,
      {
        modes: ["magic"],
        rejectable_statuses: [],
        policy: {
          forms_mode: "off",
          forms_reject_statuses: [],
          import_mode: "off",
        },
      },
    ],
    [
      "cache",
      getVerificationCache,
      { total: 0, by_status: { valid: -1 }, expiring_within_7d: 0 },
    ],
  ] as const)(
    "rejects malformed %s success payloads",
    async (_name, read, payload) => {
      mocks.get.mockResolvedValue(payload);
      await expect(read()).rejects.toBeInstanceOf(VerificationContractError);
    },
  );
});
