// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmsCompliance: vi.fn(),
  getSmsCreditBalance: vi.fn(),
  getSmsDiscountCodes: vi.fn(),
  getSmsMmsReadiness: vi.fn(),
  getSmsPilotReadiness: vi.fn(),
  getSmsProgramRegions: vi.fn(),
  getSmsSetup: vi.fn(),
  getSmsTemplates: vi.fn(),
  listSmsCampaigns: vi.fn(),
  listSmsLists: vi.fn(),
  listSmsSenderPilotCertifications: vi.fn(),
}));

vi.mock("@/lib/sms-api", () => mocks);

import { loadSmsPageData } from "@/app/(dashboard)/app/sms/sms-page-data";

function resolveAll(): void {
  mocks.getSmsSetup.mockResolvedValue({ senders: [] });
  mocks.getSmsCompliance.mockResolvedValue({ status: "ready" });
  mocks.getSmsPilotReadiness.mockResolvedValue({ ready: true });
  mocks.listSmsLists.mockResolvedValue({ items: [] });
  mocks.listSmsCampaigns.mockResolvedValue({ items: [] });
  mocks.getSmsProgramRegions.mockResolvedValue({ items: [] });
  mocks.getSmsTemplates.mockResolvedValue({ items: [] });
  mocks.getSmsDiscountCodes.mockResolvedValue({ items: [] });
  mocks.listSmsSenderPilotCertifications.mockResolvedValue({ items: [] });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  resolveAll();
});

describe("loadSmsPageData", () => {
  it("binds every supporting request to the query cancellation signal", async () => {
    const controller = new AbortController();
    await loadSmsPageData({ signal: controller.signal });

    const called = [
      "getSmsCompliance",
      "getSmsDiscountCodes",
      "getSmsPilotReadiness",
      "getSmsProgramRegions",
      "getSmsSetup",
      "getSmsTemplates",
      "listSmsCampaigns",
      "listSmsLists",
      "listSmsSenderPilotCertifications",
    ] as const;
    for (const name of called) {
      const mock = mocks[name];
      if (name === "getSmsDiscountCodes") {
        expect(mock, name).toHaveBeenCalledWith(undefined, {
          signal: controller.signal,
        });
      } else {
        expect(mock, name).toHaveBeenCalledWith({ signal: controller.signal });
      }
    }
    expect(mocks.getSmsMmsReadiness).not.toHaveBeenCalled();
    expect(mocks.getSmsCreditBalance).not.toHaveBeenCalled();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports failed supporting reads and clears their values", async () => {
    mocks.getSmsTemplates.mockRejectedValue(new Error("templates down"));
    mocks.listSmsSenderPilotCertifications.mockRejectedValue(
      new Error("certifications down"),
    );

    await expect(loadSmsPageData()).resolves.toMatchObject({
      templates: [],
      creditBalance: null,
      senderCertifications: {},
      supportingReadFailures: ["templates", "sender pilot certifications"],
    });
  });
});
