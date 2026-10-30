// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
    get: mocks.get,
    patch: vi.fn(),
    post: mocks.post,
  },
}));

import {
  checkoutSmsCreditTopUp,
  getSmsCreditBalance,
  getSmsCreditUsageSeries,
  getSmsMmsReadiness,
  previewSmsCredits,
  quoteSmsCreditTopUp,
} from "@/lib/sms-api";

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe("web SMS financial and MMS source holds", () => {
  it("rejects all financial-ledger methods locally without serializing inputs", async () => {
    const privateBody = "private customer body +15552345678";
    const operations = [
      () =>
        previewSmsCredits({
          body: privateBody,
          country: "US",
          sender_type: "10dlc",
        }),
      () => getSmsCreditBalance(),
      () => getSmsCreditUsageSeries(30),
      () => quoteSmsCreditTopUp({ credits: 1_000, plan: privateBody }),
      () => checkoutSmsCreditTopUp({ credits: 1_000, plan: privateBody }),
    ];

    for (const operation of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        status: 503,
        code: "sms_financial_ledger_release_held",
      });
      expect(String(error)).not.toContain(privateBody);
      expect(String(error)).not.toContain("+15552345678");
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects MMS readiness locally with zero request", async () => {
    await expect(getSmsMmsReadiness()).rejects.toMatchObject({
      status: 503,
      code: "sms_mms_readiness_release_held",
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
