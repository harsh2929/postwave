// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: { get: mocks.get } }));

import { listSmsCampaignVariants } from "@/lib/sms-api";

function row(variant: string) {
  return {
    variant,
    total: 10,
    sent: 7,
    failed: 1,
    blocked: 1,
    segments: 9,
    cost_micros: 100_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SMS campaign variant response contract", () => {
  it("encodes the campaign identity and forwards query cancellation", async () => {
    const controller = new AbortController();
    mocks.get.mockResolvedValueOnce({ items: [row("A")] });

    await expect(
      listSmsCampaignVariants("campaign/one", controller.signal),
    ).resolves.toEqual([row("A")]);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/campaigns/campaign%2Fone/variants",
      { signal: controller.signal },
    );
  });

  it("rejects unsafe identities before transport", async () => {
    await expect(listSmsCampaignVariants("   ")).rejects.toThrow(
      /campaign id/iu,
    );
    await expect(listSmsCampaignVariants("x".repeat(161))).rejects.toThrow(
      /campaign id/iu,
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, or negative rows", async () => {
    mocks.get.mockResolvedValueOnce([]);
    await expect(listSmsCampaignVariants("campaign-1")).rejects.toThrow(
      /response/iu,
    );

    mocks.get.mockResolvedValueOnce({ items: [row("A"), row("A")] });
    await expect(listSmsCampaignVariants("campaign-1")).rejects.toThrow(
      /identity/iu,
    );

    mocks.get.mockResolvedValueOnce({
      items: [{ ...row("A"), cost_micros: -1 }],
    });
    await expect(listSmsCampaignVariants("campaign-1")).rejects.toThrow(
      /cost_micros/iu,
    );
  });

  it("enforces the server's five-variant and recipient-outcome invariants", async () => {
    mocks.get.mockResolvedValueOnce({
      items: Array.from({ length: 6 }, (_, index) => row(String(index + 1))),
    });
    await expect(listSmsCampaignVariants("campaign-1")).rejects.toThrow(
      /variants response/iu,
    );

    mocks.get.mockResolvedValueOnce({
      items: [{ ...row("A"), total: 2, sent: 2, failed: 1, blocked: 1 }],
    });
    await expect(listSmsCampaignVariants("campaign-1")).rejects.toThrow(
      /outcome/iu,
    );
  });
});
