// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  campaignStatusVariant,
  countCampaignStatuses,
  DEFAULT_CAMPAIGN_BODY_HTML,
  localDateTimeMin,
} from "../app/(dashboard)/app/campaigns/campaign-list-helpers";

describe("campaign list helpers", () => {
  it("counts campaign statuses used by the dashboard stat strip", () => {
    expect(
      countCampaignStatuses([
        { status: "draft" },
        { status: "draft" },
        { status: "scheduled" },
        { status: "sending" },
        { status: "sent" },
      ]),
    ).toEqual({ drafts: 2, scheduled: 1, sent: 1 });
  });

  it("maps campaign statuses to badge variants", () => {
    expect(campaignStatusVariant("sent")).toBe("success");
    expect(campaignStatusVariant("scheduled")).toBe("secondary");
    expect(campaignStatusVariant("sending")).toBe("secondary");
    expect(campaignStatusVariant("paused")).toBe("warning");
    expect(campaignStatusVariant("draft")).toBe("outline");
  });

  it("formats datetime-local minimums from local date components", () => {
    expect(localDateTimeMin(new Date(2026, 0, 9, 5, 7))).toBe(
      "2026-01-09T05:07",
    );
  });

  it("keeps the default campaign body compliant", () => {
    expect(DEFAULT_CAMPAIGN_BODY_HTML).toContain("unsubscribe_url");
  });
});
