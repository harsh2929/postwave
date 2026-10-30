import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_STATUSES,
  campaignCount,
  campaignRate,
  campaignRatePercent,
  campaignRowDate,
  campaignStatusLabel,
  campaignTone,
  isTerminalCampaignStatus,
} from "./campaignFormat";

describe("campaignTone", () => {
  it("treats sent/running/finished as success", () => {
    expect(campaignTone("sent")).toBe("success");
    expect(campaignTone("running")).toBe("success");
    expect(campaignTone("FINISHED")).toBe("success");
  });

  it("treats paused as a warning on every surface (the list/detail divergence)", () => {
    expect(campaignTone("paused")).toBe("warning");
    expect(campaignTone("scheduled")).toBe("warning");
    expect(campaignTone("sending")).toBe("warning");
  });

  it("treats cancelled and failed as danger", () => {
    expect(campaignTone("cancelled")).toBe("danger");
    expect(campaignTone("failed")).toBe("danger");
  });

  it("falls back to draft/neutral for absent or unknown states", () => {
    expect(campaignTone(undefined)).toBe("neutral");
    expect(campaignTone(null)).toBe("neutral");
    expect(campaignTone("")).toBe("neutral");
    expect(campaignTone("queued_for_reprocess")).toBe("neutral");
  });
});

describe("campaignStatusLabel", () => {
  it("never leaks raw engine jargon for a known status", () => {
    expect(campaignStatusLabel("running")).toBe("Sent");
    expect(campaignStatusLabel("finished")).toBe("Sent");
    expect(campaignStatusLabel("sending")).toBe("Sending");
    expect(campaignStatusLabel("cancelled")).toBe("Cancelled");
  });

  it("title-cases an unknown future status instead of rendering it raw", () => {
    expect(campaignStatusLabel("queued_for_reprocess")).toBe(
      "Queued For Reprocess",
    );
    expect(campaignStatusLabel("weird-state")).toBe("Weird State");
  });

  it("labels every documented backend status without returning lowercase", () => {
    for (const status of CAMPAIGN_STATUSES) {
      const label = campaignStatusLabel(status);
      expect(label.length).toBeGreaterThan(0);
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });

  it("defaults an absent status to Draft", () => {
    expect(campaignStatusLabel(undefined)).toBe("Draft");
    expect(campaignStatusLabel(null)).toBe("Draft");
  });
});

describe("isTerminalCampaignStatus", () => {
  it("covers success and failure terminals", () => {
    expect(isTerminalCampaignStatus("sent")).toBe(true);
    expect(isTerminalCampaignStatus("failed")).toBe(true);
    expect(isTerminalCampaignStatus("sending")).toBe(false);
    expect(isTerminalCampaignStatus("draft")).toBe(false);
  });
});

describe("campaignRate", () => {
  it("scales a 0..1 fraction from the list endpoint", () => {
    expect(campaignRate(0.423, { scale: "fraction" })).toContain("42.3");
    expect(campaignRate(1, { scale: "fraction" })).toContain("100.0");
  });

  it("passes an already-scaled percent from the report endpoint through", () => {
    expect(campaignRate(42.3, { scale: "percent" })).toContain("42.3");
  });

  /**
   * The regression this signature exists for. Under the old magnitude guess
   * (`value > 1 ? value : value * 100`) BOTH of these rendered as a triumph:
   * a report open_rate of 1.0 — one percent — printed "100.0%", and a genuine
   * half a percent printed "50.0%". Those are the exact numbers an operator
   * checks their phone for after a bad send.
   */
  it("does not inflate a sub-1 report percent into a sub-1 fraction", () => {
    expect(campaignRate(1, { scale: "percent" })).toContain("1.0");
    expect(campaignRate(1, { scale: "percent" })).not.toContain("100.0");
    expect(campaignRate(0.5, { scale: "percent" })).toContain("0.5");
    expect(campaignRate(0.5, { scale: "percent" })).not.toContain("50.0");
  });

  it("clamps a malformed negative or absurd rate rather than rendering it", () => {
    expect(campaignRate(-0.5, { scale: "fraction" })).toContain("0.0");
    expect(campaignRate(4200, { scale: "percent" })).toContain("100.0");
  });

  it("renders a measured zero, not a dash", () => {
    expect(campaignRate(0, { scale: "fraction" })).toContain("0.0");
  });

  it("falls back for NaN / absent values", () => {
    expect(campaignRate(Number.NaN, { scale: "fraction" })).toBe("—");
    expect(campaignRate(undefined, { scale: "fraction" })).toBe("—");
    expect(campaignRate(null, { scale: "percent" })).toBe("—");
    expect(campaignRate("42", { scale: "percent" })).toBe("—");
  });
});

describe("campaignRatePercent", () => {
  it("returns null — never 0 — for an absent measurement", () => {
    expect(campaignRatePercent(undefined, "fraction")).toBeNull();
    expect(campaignRatePercent(Number.NaN, "percent")).toBeNull();
    expect(campaignRatePercent(0, "fraction")).toBe(0);
  });

  it("agrees with the printed string, so a bar can never contradict its label", () => {
    expect(campaignRatePercent(0.423, "fraction")).toBeCloseTo(42.3, 5);
    expect(campaignRatePercent(42.3, "percent")).toBeCloseTo(42.3, 5);
  });
});

describe("campaignCount", () => {
  it("formats and falls back consistently", () => {
    expect(campaignCount(1234)).toBe("1,234");
    expect(campaignCount(0)).toBe("0");
    expect(campaignCount(undefined)).toBe("—");
  });
});

describe("campaignRowDate", () => {
  const now = new Date("2026-07-25T12:00:00.000Z").toISOString();

  it("shows the SEND time for a scheduled campaign, not the creation date", () => {
    const out = campaignRowDate({
      status: "scheduled",
      scheduled_at: "2026-07-28T09:00:00.000Z",
      created_at: now,
    });
    expect(out?.prefix).toBe("Sends");
    expect(out?.iso).toBe("2026-07-28T09:00:00.000Z");
  });

  it("labels a sent campaign's date as Sent", () => {
    const out = campaignRowDate({
      status: "sent",
      sent_at: "2026-07-20T09:00:00.000Z",
      created_at: now,
    });
    expect(out?.prefix).toBe("Sent");
  });

  it("labels a draft's date as Created", () => {
    const out = campaignRowDate({ status: "draft", created_at: now });
    expect(out?.prefix).toBe("Created");
    expect(out?.iso).toBe(now);
  });

  it("falls back to created_at when a scheduled campaign has no scheduled_at", () => {
    const out = campaignRowDate({ status: "scheduled", created_at: now });
    expect(out?.prefix).toBe("Created");
  });

  it("returns null when the campaign carries no timestamp at all", () => {
    expect(campaignRowDate({ status: "draft" })).toBeNull();
    expect(campaignRowDate(null)).toBeNull();
    expect(campaignRowDate(undefined)).toBeNull();
  });

  it("always exposes an absolute rendering for the accessibility label", () => {
    const out = campaignRowDate({ status: "sent", sent_at: now });
    expect(out?.absolute).not.toBe("—");
    expect(out?.absolute.length).toBeGreaterThan(0);
  });
});
