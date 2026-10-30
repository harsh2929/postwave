// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
    get: mocks.get,
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

import {
  getSmsCampaignReport,
  listSmsConsent,
  listSmsListMembers,
  SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
  smsCampaignReportExportPath,
  smsConsentExportPath,
} from "@/lib/sms-api";

beforeEach(() => mocks.get.mockReset());

describe("web SMS evidence release hold", () => {
  it("fails every confidential read locally without serializing its identity", async () => {
    const secret = "campaign/+15552345678/private";

    await expect(listSmsListMembers(secret)).rejects.toMatchObject({
      code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
      status: 503,
    });
    await expect(getSmsCampaignReport(secret)).rejects.toMatchObject({
      code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
      status: 503,
    });
    await expect(listSmsConsent("granted", "+15552345678")).rejects.toMatchObject(
      {
        code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
        status: 503,
      },
    );

    for (const buildPath of [
      () => smsCampaignReportExportPath(secret),
      () => smsConsentExportPath("granted", "+15552345678"),
    ]) {
      try {
        buildPath();
        throw new Error("expected release hold");
      } catch (error) {
        expect(error).toMatchObject({
          code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
          status: 503,
        });
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("+15552345678");
      }
    }

    expect(mocks.get).not.toHaveBeenCalled();
  });
});
