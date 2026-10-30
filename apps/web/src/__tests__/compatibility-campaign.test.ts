// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { selectReportableCampaign } from "@/app/(dashboard)/app/compatibility/compatibility-campaign";
import type { Campaign } from "@/lib/campaigns-api";

function campaign(
  id: string,
  status: Campaign["status"],
  sentAt: string | null = null,
): Campaign {
  return {
    id,
    tenant_id: "tenant-demo",
    name: id,
    subject: "Compatibility evidence",
    status,
    sent_at: sentAt,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
  };
}

describe("selectReportableCampaign", () => {
  it("skips newer draft and scheduled campaigns", () => {
    const sent = campaign("sent", "sent", "2026-08-24T10:00:00Z");

    expect(
      selectReportableCampaign([
        campaign("scheduled", "scheduled"),
        campaign("draft", "draft"),
        sent,
      ]),
    ).toBe(sent);
  });

  it("accepts a sent timestamp while a send is settling", () => {
    const settling = campaign("settling", "sending", "2026-08-25T09:59:00Z");

    expect(selectReportableCampaign([settling])).toBe(settling);
  });

  it("does not send report requests for unsent work", () => {
    expect(
      selectReportableCampaign([
        campaign("scheduled", "scheduled"),
        campaign("draft", "draft"),
      ]),
    ).toBeUndefined();
  });
});
