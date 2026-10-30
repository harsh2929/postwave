// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: mocks.post,
  },
}));

import {
  pollSmsA2PRegistration,
  submitSmsBrandRegistration,
  submitSmsCampaignRegistration,
  upsertSmsSender,
} from "@/lib/sms-api";

beforeEach(() => mocks.post.mockReset());

describe("web SMS A2P release hold", () => {
  it("rejects submit and poll locally without serializing private inputs", async () => {
    const privateId = "sender/+15552345678/private";
    const operations = [
      () =>
        submitSmsBrandRegistration(privateId, {
          company_name: "Private company",
        }),
      () =>
        submitSmsCampaignRegistration(privateId, {
          description: "Private message flow",
        }),
      () => pollSmsA2PRegistration(privateId),
    ];

    for (const operation of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        status: 503,
        code: "sms_a2p_registration_release_held",
      });
      expect(String(error)).not.toContain(privateId);
      expect(String(error)).not.toContain("+15552345678");
      expect(String(error)).not.toContain("Private");
    }
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied registration evidence before sender upsert", async () => {
    const privateSid = "BN_PRIVATE_15552345678";
    await expect(
      upsertSmsSender({
        provider: "twilio",
        country: "US",
        sender_type: "10dlc",
        phone_number: "+15552345678",
        brand_registration_sid: privateSid,
        registration_status: "approved",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "sms_registration_evidence_authority_required",
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
