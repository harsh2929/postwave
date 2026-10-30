import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DUX_025_VISUAL_SOURCES,
  dux025Provenance,
  type Dux025VisualSourceKey,
} from "../../components/charts/dux-025-visual-manifest";

const SOURCE_BY_CONTRACT: Record<Dux025VisualSourceKey, URL> = {
  webhookHealth: new URL(
    "../../components/webhooks/WebhookHealthCard.tsx",
    import.meta.url,
  ),
  engagementScoreDistribution: new URL(
    "../../components/subscribers/EngagementScoreSection.tsx",
    import.meta.url,
  ),
  domainVerificationMix: new URL(
    "../../components/domains/CustomDomainsStatStrip.tsx",
    import.meta.url,
  ),
  suppressionReasonMix: new URL(
    "../../components/suppressions/SuppressionsStatStrip.tsx",
    import.meta.url,
  ),
  subscriberStatusMix: new URL(
    "../../components/subscribers/SubscribersStatStrip.tsx",
    import.meta.url,
  ),
  mcpQuotaUtilization: new URL("../../pages/MCP.tsx", import.meta.url),
  mcpStatusBreakdown: new URL("../../pages/MCP.tsx", import.meta.url),
  segmentOverlap: new URL(
    "../../components/segments/SegmentOverlapCard.tsx",
    import.meta.url,
  ),
  cohortFunnel: new URL(
    "../../components/analytics/CohortFunnelCard.tsx",
    import.meta.url,
  ),
  campaignCompare: new URL(
    "../../components/analytics/CampaignCompareCard.tsx",
    import.meta.url,
  ),
  sendFatigue: new URL(
    "../../components/analytics/FatigueCard.tsx",
    import.meta.url,
  ),
  dashboardBenchmarks: new URL(
    "../../components/dashboard/BenchmarksCard.tsx",
    import.meta.url,
  ),
  goalsProgress: new URL(
    "../../components/dashboard/GoalProgressView.tsx",
    import.meta.url,
  ),
  segmentDecayAttribution: new URL(
    "../../components/segments/SegmentDecaySection.tsx",
    import.meta.url,
  ),
  lifecycleDistribution: new URL(
    "../../components/subscribers/LifecycleDistributionCard.tsx",
    import.meta.url,
  ),
  demographicsConfidence: new URL(
    "../../components/subscribers/DemographicsPanel.tsx",
    import.meta.url,
  ),
  catalogFavoriteCategories: new URL(
    "../../components/subscribers/CatalogAttributesPanel.tsx",
    import.meta.url,
  ),
  predictionConfidence: new URL(
    "../../components/subscribers/SubscriberProfilePanel.tsx",
    import.meta.url,
  ),
  referralConversions: new URL(
    "../../components/referrals/ReferralStatsCards.tsx",
    import.meta.url,
  ),
  referralTopReferrers: new URL(
    "../../components/referrals/ReferralStatsCards.tsx",
    import.meta.url,
  ),
  privacyPortalKpis: new URL(
    "../../components/privacy/PortalDashboard.tsx",
    import.meta.url,
  ),
  privacyDsarBreakdown: new URL(
    "../../components/privacy/PortalDashboard.tsx",
    import.meta.url,
  ),
  privacySuppressionReasons: new URL(
    "../../components/privacy/PortalDashboard.tsx",
    import.meta.url,
  ),
  planSendsProjection: new URL(
    "../../components/settings/SendsProjection.tsx",
    import.meta.url,
  ),
  planResourceUsage: new URL(
    "../../components/settings/PlanSummaryCard.tsx",
    import.meta.url,
  ),
  customFieldUsage: new URL(
    "../../components/settings/CustomFieldGovernance.tsx",
    import.meta.url,
  ),
  sendingRateLimit: new URL("../../pages/SendingSettings.tsx", import.meta.url),
  mcpCallTrend: new URL("../../pages/MCP.tsx", import.meta.url),
};

describe("DUX-025 custom visual source contract", () => {
  it("keeps every migrated visual in a complete, honest source manifest", () => {
    expect(Object.keys(DUX_025_VISUAL_SOURCES)).toHaveLength(28);
    for (const [key, contract] of Object.entries(
      DUX_025_VISUAL_SOURCES,
    ) as Array<
      [
        Dux025VisualSourceKey,
        (typeof DUX_025_VISUAL_SOURCES)[Dux025VisualSourceKey],
      ]
    >) {
      expect(contract.owner, key).not.toBe("");
      expect(contract.title, key).not.toBe("");
      expect(contract.source, key).not.toBe("");
      expect(contract.scope, key).not.toBe("");
      expect(contract.units.length, key).toBeGreaterThan(0);
      expect(contract.asOf, key).toBeNull();
      expect(dux025Provenance(key).asOf).toBeNull();
    }
  });

  it("binds every manifest entry to its production owner", () => {
    for (const [key, url] of Object.entries(SOURCE_BY_CONTRACT) as Array<
      [Dux025VisualSourceKey, URL]
    >) {
      const source = readFileSync(url, "utf8");
      expect(source, key).toContain(`dux025Provenance("${key}"`);
      expect(source, key).toMatch(
        /AccessibleChartData|CategoricalDistributionChart|<Funnel/,
      );
      expect(source, key).toContain('exportPrivacy="confidential"');
    }
  });

  it("keeps custom SVG and residual magnitude bars supplemental", () => {
    const webhook = readFileSync(SOURCE_BY_CONTRACT.webhookHealth, "utf8");
    expect(webhook).toMatch(/<svg[\s\S]*?aria-hidden="true"/);
    expect(webhook).toContain("WebhookHealthData");
    expect(webhook).toContain('role="alert"');

    const overlap = readFileSync(SOURCE_BY_CONTRACT.segmentOverlap, "utf8");
    expect(overlap).toMatch(/<svg[\s\S]*?aria-hidden="true"/);
    expect(overlap).toContain('strokeDasharray="7 4"');

    const campaign = readFileSync(SOURCE_BY_CONTRACT.campaignCompare, "utf8");
    expect(campaign).toContain('aria-hidden="true"');
    expect(campaign).not.toContain('transition: "width');

    const mcp = readFileSync(SOURCE_BY_CONTRACT.mcpQuotaUtilization, "utf8");
    expect(mcp).toContain(
      'className="mcp-status-bar-track" aria-hidden="true"',
    );

    const rateBar = readFileSync(
      new URL("../../components/dashboard/RateBar.tsx", import.meta.url),
      "utf8",
    );
    expect(rateBar).toContain('aria-hidden="true"');
    expect(rateBar).toContain('data-dux025-supplemental="rate-bar"');

    const sparkline = readFileSync(
      new URL("../../components/charts/Sparkline.tsx", import.meta.url),
      "utf8",
    );
    expect(sparkline).toContain("SparklineDataDisclosure");
    expect(sparkline).toContain("ExactSparklineData");

    const chartStyles = readFileSync(
      new URL("../../styles/chart-accessibility.css", import.meta.url),
      "utf8",
    );
    expect(chartStyles).toContain(
      '[data-dux025-supplemental="rate-bar"] > span',
    );
    expect(chartStyles).toContain(".dash-benchmark-value");
  });

  it("keeps every runtime-backed RateBar beside an exact caller-owned value", () => {
    const campaignList = readFileSync(
      new URL("../../pages/campaigns/CampaignListView.tsx", import.meta.url),
      "utf8",
    );
    expect(campaignList.match(/<RateBar\b/g)).toHaveLength(2);
    expect(campaignList).toContain("formatCampaignPercent(campaign.open_rate)");
    expect(campaignList).toContain(
      "formatCampaignPercent(campaign.click_rate)",
    );

    const engagement = readFileSync(
      new URL(
        "../../components/analytics/EngagementPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(engagement.match(/<RateBar\b/g)).toHaveLength(1);
    expect(engagement).toContain("fmtRate(panel.ai_surfacing_score)");

    const sequences = readFileSync(
      new URL("../../pages/Sequences.tsx", import.meta.url),
      "utf8",
    );
    expect(sequences.match(/<RateBar\b/g) ?? []).toHaveLength(0);
    expect(sequences).toContain("SEQUENCE_RUNTIME_UNAVAILABLE_REASON");
    expect(sequences).toContain("Runtime off");
    expect(sequences).not.toContain("active runs in this view");
  });

  it("keeps fetch-owning second-wave visuals explicit about failure and waiting", () => {
    const fetchOwners: Dux025VisualSourceKey[] = [
      "sendFatigue",
      "dashboardBenchmarks",
      "goalsProgress",
      "segmentDecayAttribution",
      "lifecycleDistribution",
      "demographicsConfidence",
      "catalogFavoriteCategories",
      "predictionConfidence",
      "referralConversions",
      "planResourceUsage",
      "customFieldUsage",
      "mcpCallTrend",
    ];
    for (const key of fetchOwners) {
      const source = readFileSync(SOURCE_BY_CONTRACT[key], "utf8");
      expect(source, key).toContain('role="alert"');
      expect(source, key).toContain('role="status"');
    }
  });
});
