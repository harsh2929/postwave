import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runSmsCampaignVerb,
  SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE,
} from "./smsCampaigns";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("mobile SMS campaign dispatch release hold", () => {
  it.each(["resume", "retry-failed"] as const)(
    "blocks %s locally with zero network or idempotency side effect",
    async (verb) => {
      await expect(
        runSmsCampaignVerb({ id: "campaign/+15552345678/private", verb }),
      ).rejects.toMatchObject({
        code: SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE,
        status: 503,
      });
      expect(rawRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["pause", "cancel"] as const)(
    "preserves the non-dispatch safety verb %s",
    async (verb) => {
      rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
      await runSmsCampaignVerb({ id: "campaign/a", verb });
      expect(rawRequest).toHaveBeenCalledWith(
        "POST",
        `/api/v1/sms/campaigns/campaign%2Fa/${verb}`,
        {},
      );
    },
  );
});
