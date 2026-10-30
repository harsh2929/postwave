import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  campaignArchiveUrl,
  CampaignPerformancePanel,
  campaignReportTopLinks,
  CampaignWebVersionCard,
  resendSubject,
} from "../../components/CampaignDetailPanels";
import type { CampaignReport } from "../../lib/api-client";

describe("campaign detail presentation panels", () => {
  it("selects the appropriate raw or bot-filtered link series", () => {
    const report = campaignReport();
    expect(campaignReportTopLinks(report, "raw")).toEqual([
      { url: "https://example.com/raw", clicks: 8 },
    ]);
    expect(campaignReportTopLinks(report, "human")).toEqual([
      { url: "https://example.com/human", clicks: 5 },
    ]);
    expect(
      campaignReportTopLinks(
        { ...report, human_top_links: undefined },
        "human",
      ),
    ).toEqual(report.top_links);
    expect(campaignReportTopLinks(null, "human")).toEqual([]);
  });

  it("renders human engagement evidence and the live status", () => {
    const html = renderToStaticMarkup(
      <CampaignPerformancePanel
        loading={false}
        isDraft={false}
        hasReport
        liveStatus="open"
        report={campaignReport()}
        reportErr={null}
        engagementMode="human"
        onEngagementModeChange={() => undefined}
      />,
    );
    expect(html).toContain("Performance");
    expect(html).toContain("MPP-stripped");
    expect(html).toContain("https://example.com/human");
    expect(html).toContain("50.0%");
  });

  it("fails honestly between loading, empty draft, and report errors", () => {
    const loading = renderToStaticMarkup(
      <CampaignPerformancePanel
        loading
        isDraft
        hasReport={false}
        liveStatus="closed"
        report={null}
        reportErr={null}
        engagementMode="human"
        onEngagementModeChange={() => undefined}
      />,
    );
    const empty = renderToStaticMarkup(
      <CampaignPerformancePanel
        loading={false}
        isDraft
        hasReport={false}
        liveStatus="closed"
        report={null}
        reportErr={null}
        engagementMode="human"
        onEngagementModeChange={() => undefined}
      />,
    );
    const failed = renderToStaticMarkup(
      <CampaignPerformancePanel
        loading={false}
        isDraft={false}
        hasReport={false}
        liveStatus="closed"
        report={null}
        reportErr="gateway offline"
        engagementMode="raw"
        onEngagementModeChange={() => undefined}
      />,
    );
    expect(loading.match(/class="skel"/g)).toHaveLength(3);
    expect(empty).toContain("Performance metrics appear after");
    expect(failed).toContain("Report unavailable: gateway offline");
  });

  it("builds encoded public archive URLs and honest unresolved states", () => {
    expect(
      campaignArchiveUrl("https://archive.example", "summer / launch"),
    ).toBe("https://archive.example/summer%20%2F%20launch");
    expect(campaignArchiveUrl(null, "launch")).toBeNull();
    const resolving = renderToStaticMarkup(
      <CampaignWebVersionCard
        archiveBase={null}
        archiveSettingsLoaded={false}
        archiveSlug="launch"
      />,
    );
    const unconfigured = renderToStaticMarkup(
      <CampaignWebVersionCard
        archiveBase={null}
        archiveSettingsLoaded
        archiveSlug="launch"
      />,
    );
    expect(resolving).toContain("Resolving public URL");
    expect(unconfigured).toContain("Set your archive slug");
  });

  it("derives a fresh resend subject without inventing campaign content", () => {
    expect(resendSubject("Launch day")).toBe("Re: Launch day");
    expect(resendSubject(undefined)).toBe("Re: your last campaign");
  });
});

function campaignReport(): CampaignReport {
  return {
    campaign_id: "campaign-1",
    sent: 10,
    delivered: 9,
    opens: 6,
    unique_opens: 5,
    clicks: 4,
    unique_clicks: 3,
    bounces: 1,
    complaints: 0,
    unsubscribes: 1,
    open_rate: 0.6,
    click_rate: 0.4,
    click_to_open_rate: 0.66,
    bounce_rate: 0.1,
    unsub_rate: 0.1,
    top_links: [{ url: "https://example.com/raw", clicks: 8 }],
    human_opens: 5,
    human_open_rate: 0.5,
    human_click_rate: 0.3,
    human_top_links: [{ url: "https://example.com/human", clicks: 5 }],
    bot_signatures_applied: ["apple_mpp"],
  };
}
