// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scheduleByBestTime,
  setCampaignRecurrence,
  upsertTimezoneSchedule,
} from "@/lib/campaigns-api";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign scheduling release hold", () => {
  it("rejects every retained scheduling adapter before transport", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);

    for (const request of [
      setCampaignRecurrence("campaign/one", "0 9 * * 1"),
      scheduleByBestTime("campaign?two", { within_days: 7 }),
      upsertTimezoneSchedule("campaign#three", {
        local_time: "09:00",
        date: "2026-09-12",
      }),
    ]) {
      await expect(request).rejects.toMatchObject({
        code: "campaign_scheduling_unqualified",
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps both active campaign surfaces out of the scheduling runtime", () => {
    const list = source("app/(dashboard)/app/campaigns/campaigns-client.tsx");
    const detail = source(
      "app/(dashboard)/app/campaigns/[id]/campaign-detail-client.tsx",
    );
    const selected = source(
      "app/(dashboard)/app/campaigns/selected-campaign-actions.tsx",
    );
    const defensiveDialog = source(
      "app/(dashboard)/app/campaigns/campaign-send-dialogs.tsx",
    );

    for (const activeSurface of [list, detail, selected]) {
      expect(activeSurface).not.toContain("setScheduleOpen(true)");
      expect(activeSurface).not.toContain("CampaignScheduleDialog");
      expect(activeSurface).not.toContain('status: "scheduled"');
      expect(activeSurface).not.toContain('toast.success("Scheduled.")');
    }
    expect(list).toContain("SelectedCampaignActions");
    expect(detail).toContain("Scheduling unavailable");
    expect(selected).toContain("Scheduling unavailable");
    expect(defensiveDialog).not.toContain('type="datetime-local"');
    expect(defensiveDialog).not.toContain('value="best_time"');
    expect(defensiveDialog).not.toContain('value="timezone"');
    expect(defensiveDialog).toContain("No delivery schedule will be created");
  });
});
