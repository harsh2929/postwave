import { describe, expect, it } from "vitest";

import {
  hasDeliveredStatus,
  recentCampaignRowLabel,
  recentCampaignRowSummary,
} from "./recentCampaignRow";

const SENT = "2026-03-14T16:05:00.000Z";

describe("recentCampaignRowSummary", () => {
  it("reports both rates for a sent campaign", () => {
    const { detail, spokenMetrics } = recentCampaignRowSummary({
      status: "sent",
      when: SENT,
      openRate: 0.243,
      clickRate: 0.031,
    });
    expect(detail).toContain("24.3% opened");
    expect(detail).toContain("3.1% clicked");
    expect(spokenMetrics).toBe("24.3% opened, 3.1% clicked");
  });

  it("says nothing about rates for a campaign that has never been mailed", () => {
    // The Go handler omits both fields for a draft, and "0.0% opened" beside a
    // draft is a claim about an event that has not happened.
    const { detail, spokenMetrics } = recentCampaignRowSummary({
      status: "draft",
      when: SENT,
    });
    expect(detail).not.toContain("opened");
    expect(detail).not.toContain("%");
    expect(spokenMetrics).toBe("");
  });

  it("discloses a missing rate on a SENT campaign rather than printing zero", () => {
    const { detail, spokenMetrics } = recentCampaignRowSummary({
      status: "sent",
      when: SENT,
    });
    expect(detail).toContain("— opened");
    expect(detail).not.toContain("0.0%");
    expect(spokenMetrics).toBe(
      "open rate not reported, click rate not reported",
    );
  });

  it("keeps a genuine zero rate distinguishable from an absent one", () => {
    const zero = recentCampaignRowSummary({
      status: "sent",
      when: SENT,
      openRate: 0,
      clickRate: 0,
    });
    expect(zero.detail).toContain("0.0% opened");
    expect(zero.spokenMetrics).toBe("0.0% opened, 0.0% clicked");
  });

  it("refuses impossible rates instead of rendering them", () => {
    const bad = recentCampaignRowSummary({
      status: "sent",
      when: SENT,
      openRate: -0.2,
      clickRate: Number.NaN,
    });
    expect(bad.detail).toContain("— opened");
    expect(bad.detail).toContain("— clicked");
  });

  it("still shows rates when a status is unknown but the server sent them", () => {
    const { detail } = recentCampaignRowSummary({
      status: "some_future_state",
      when: SENT,
      openRate: 0.5,
    });
    expect(detail).toContain("50.0% opened");
  });

  it("treats in-flight sends as delivered enough to have rates", () => {
    expect(hasDeliveredStatus("Sending")).toBe(true);
    expect(hasDeliveredStatus("sent")).toBe(true);
    expect(hasDeliveredStatus("scheduled")).toBe(false);
    expect(hasDeliveredStatus(undefined)).toBe(false);
  });
});

describe("recentCampaignRowLabel", () => {
  it("composes one announcement instead of four fragments", () => {
    const label = recentCampaignRowLabel("Spring launch", {
      status: "sent",
      when: SENT,
      openRate: 0.243,
      clickRate: 0.031,
    });
    expect(label.startsWith("Spring launch, sent, ")).toBe(true);
    expect(label.endsWith("24.3% opened, 3.1% clicked")).toBe(true);
  });

  it("omits the metrics clause entirely for a draft", () => {
    const label = recentCampaignRowLabel("Untitled", { status: "draft" });
    expect(label).toBe("Untitled, draft, no date");
  });
});
