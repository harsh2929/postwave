import type { RequiredChartSupportProps } from "./AccessibleChartData";

export interface Dux025VisualSourceContract {
  owner: string;
  title: string;
  units: readonly string[];
  source: string;
  scope: string;
  /** Null means the endpoint does not expose an authoritative snapshot time. */
  asOf: null;
  note: string;
}

/**
 * Auditable source inventory for the DUX-025 custom-visual migration wave.
 *
 * Keeping the endpoint family, scope, units and missing-as-of disclosure in
 * one typed manifest makes a new visual harder to ship with a generic or
 * invented provenance claim. Runtime scope details are appended by callers.
 */
export const DUX_025_VISUAL_SOURCES = {
  webhookHealth: {
    owner: "components/webhooks/WebhookHealthCard.tsx",
    title: "Webhook health, trailing 24 hours",
    units: ["deliveries", "percent", "milliseconds"],
    source: "Moosewave webhook health API",
    scope: "Selected webhook · trailing 24 hours",
    asOf: null,
    note: "The endpoint reports a rolling window rather than a fixed snapshot.",
  },
  engagementScoreDistribution: {
    owner: "components/subscribers/EngagementScoreSection.tsx",
    title: "Engagement score distribution",
    units: ["subscribers", "score range", "percent"],
    source: "Moosewave engagement-score distribution API",
    scope: "Current workspace · scored subscribers only",
    asOf: null,
    note: "Unscored subscribers are excluded from the server-provided buckets.",
  },
  domainVerificationMix: {
    owner: "components/domains/CustomDomainsStatStrip.tsx",
    title: "Domain verification distribution",
    units: ["domains", "percent"],
    source: "Moosewave custom-domain API",
    scope: "Current workspace · currently loaded domains",
    asOf: null,
    note: "Counts are derived from the domain rows supplied by the parent view.",
  },
  suppressionReasonMix: {
    owner: "components/suppressions/SuppressionsStatStrip.tsx",
    title: "Suppression reason distribution",
    units: ["loaded suppressions", "percent"],
    source: "Moosewave suppressions API",
    scope: "Current workspace · current reason filter · loaded rows",
    asOf: null,
    note: "The table and export cover the loaded sample, not an unseen server remainder.",
  },
  subscriberStatusMix: {
    owner: "components/subscribers/SubscribersStatStrip.tsx",
    title: "Loaded subscriber status distribution",
    units: ["loaded subscribers", "percent"],
    source: "Moosewave subscribers API and pending-mutation cache",
    scope: "Current workspace · loaded subscriber page plus pending creates",
    asOf: null,
    note: "Server rows are combined with explicitly pending local creates.",
  },
  mcpQuotaUtilization: {
    owner: "pages/MCP.tsx",
    title: "MCP per-tool quota utilization today",
    units: ["calls", "daily limit", "percent", "USD per call"],
    source: "Moosewave MCP quotas API",
    scope: "Current workspace · current UTC quota day",
    asOf: null,
    note: "Quota utilization is a live counter and has no snapshot timestamp.",
  },
  mcpStatusBreakdown: {
    owner: "pages/MCP.tsx",
    title: "MCP HTTP status distribution",
    units: ["calls", "percent"],
    source: "Moosewave MCP statistics API",
    scope: "Current workspace · active MCP history filters",
    asOf: null,
    note: "The selected history window is rolling and has no snapshot timestamp.",
  },
  segmentOverlap: {
    owner: "components/segments/SegmentOverlapCard.tsx",
    title: "Segment membership overlap",
    units: ["subscribers", "Jaccard percent"],
    source: "Moosewave segment-overlap API",
    scope: "Current workspace · two selected saved segments",
    asOf: null,
    note: "Membership is evaluated when the comparison request runs.",
  },
  cohortFunnel: {
    owner: "components/analytics/CohortFunnelCard.tsx",
    title: "Signup-to-repeat-purchase cohort funnel",
    units: ["subscribers", "percent", "monthly cohorts"],
    source: "Moosewave subscriber-funnel analytics API",
    scope: "Current workspace · trailing signup cohorts · selected audience",
    asOf: null,
    note: "The response is cohort-scoped and does not expose a snapshot timestamp.",
  },
  campaignCompare: {
    owner: "components/analytics/CampaignCompareCard.tsx",
    title: "Selected campaign rate comparison",
    units: ["recipients", "percent", "confidence"],
    source: "Moosewave campaign-comparison analytics API",
    scope: "Current workspace · selected campaigns",
    asOf: null,
    note: "Rates use the returned recipient denominators and have no snapshot timestamp.",
  },
  sendFatigue: {
    owner: "components/analytics/FatigueCard.tsx",
    title: "Send-frequency fatigue by recipient decile",
    units: ["subscribers", "emails received", "percent"],
    source: "Moosewave send-fatigue analytics API",
    scope: "Current workspace · selected trailing-day window",
    asOf: null,
    note: "Rates are returned as fractions for server-defined send-frequency buckets.",
  },
  dashboardBenchmarks: {
    owner: "components/dashboard/BenchmarksCard.tsx",
    title: "Workspace rates compared with industry benchmarks",
    units: ["percent", "emails sent"],
    source: "Moosewave dashboard benchmarks API and dashboard statistics API",
    scope: "Current workspace · trailing 30 days · supplied benchmark cohort",
    asOf: null,
    note: "The benchmark endpoint supplies illustrative comparison values without a snapshot timestamp.",
  },
  goalsProgress: {
    owner: "components/dashboard/GoalProgressView.tsx",
    title: "Goal progress and pacing",
    units: ["goal-native value", "percent", "period"],
    source: "Moosewave goals progress API",
    scope: "Current workspace · active goal periods",
    asOf: null,
    note: "Current value, target, progress and pace are computed by the server per goal period.",
  },
  segmentDecayAttribution: {
    owner: "components/segments/SegmentDecaySection.tsx",
    title: "Segment-decay clause attribution",
    units: ["leavers", "percent", "clause index"],
    source: "Moosewave segment-decay events API",
    scope: "Current workspace · selected segment · expanded decay event",
    asOf: null,
    note: "Clause contributions may overlap and are estimates rather than exclusive causation.",
  },
  lifecycleDistribution: {
    owner: "components/subscribers/LifecycleDistributionCard.tsx",
    title: "Subscriber lifecycle-stage distribution",
    units: ["subscribers", "percent"],
    source: "Moosewave lifecycle distribution and stage-catalog APIs",
    scope: "Current workspace · subscribers with lifecycle-stage records",
    asOf: null,
    note: "The stage catalog supplies ordering and zero-filled stages; the distribution supplies counts.",
  },
  demographicsConfidence: {
    owner: "components/subscribers/DemographicsPanel.tsx",
    title: "Inferred demographic confidence",
    units: ["confidence fraction", "percent", "computed trait"],
    source: "Moosewave subscriber demographics API",
    scope: "Selected subscriber · inferred traits",
    asOf: null,
    note: "Values are model predictions, not subscriber-reported demographics.",
  },
  catalogFavoriteCategories: {
    owner: "components/subscribers/CatalogAttributesPanel.tsx",
    title: "Favorite-category event frequency",
    units: ["catalog events", "relative magnitude"],
    source: "Moosewave subscriber catalog-attributes API",
    scope: "Selected subscriber · up to three returned favorite categories",
    asOf: null,
    note: "Bars compare returned event counts with the largest returned category; they are not percentages of all catalog activity.",
  },
  predictionConfidence: {
    owner: "components/subscribers/SubscriberProfilePanel.tsx",
    title: "Subscriber prediction confidence",
    units: ["confidence fraction", "percent", "model version"],
    source: "Moosewave subscriber prediction-metadata API",
    scope: "Selected subscriber · current per-score-type metadata",
    asOf: null,
    note: "Null confidence means the model did not meet its minimum-data threshold.",
  },
  referralConversions: {
    owner: "components/referrals/ReferralStatsCards.tsx",
    title: "Referral conversions by rolling window",
    units: ["conversions", "days"],
    source: "Moosewave referral statistics API",
    scope: "Current workspace · rolling 7-, 30- and 90-day windows",
    asOf: null,
    note: "Rolling-window counts overlap and must not be summed.",
  },
  referralTopReferrers: {
    owner: "components/referrals/ReferralStatsCards.tsx",
    title: "Top referrers by conversion count",
    units: ["conversions", "timestamp"],
    source: "Moosewave referral statistics API",
    scope: "Current workspace · top referrers returned by the API",
    asOf: null,
    note: "Magnitude bars are normalized to the largest returned referrer, not to all conversions.",
  },
  privacyDsarBreakdown: {
    owner: "components/privacy/PortalDashboard.tsx",
    title: "DSAR requests by request type and status",
    units: ["requests", "request type", "status"],
    source: "Moosewave privacy-portal summary API",
    scope: "Current workspace · all summary request types",
    asOf: null,
    note: "Open, overdue and closed are server-supplied status counts.",
  },
  privacyPortalKpis: {
    owner: "components/privacy/PortalDashboard.tsx",
    title: "Privacy-portal summary indicators",
    units: ["requests", "subscribers", "pending confirmations"],
    source: "Moosewave privacy-portal summary API",
    scope: "Current workspace · current privacy summary",
    asOf: null,
    note: "Indicators use the server-supplied summary and do not invent a snapshot timestamp.",
  },
  privacySuppressionReasons: {
    owner: "components/privacy/PortalDashboard.tsx",
    title: "Privacy-portal suppression reasons",
    units: ["suppressions", "relative magnitude"],
    source: "Moosewave privacy-portal summary API",
    scope: "Current workspace · top four returned suppression reasons",
    asOf: null,
    note: "Magnitude bars are normalized to the largest displayed reason and do not imply share of all suppressions.",
  },
  planSendsProjection: {
    owner: "components/settings/SendsProjection.tsx",
    title: "Monthly sends usage and projection",
    units: ["sends", "sends per day", "percent", "date"],
    source: "Moosewave billing plan-summary API",
    scope: "Current workspace · current billing period",
    asOf: null,
    note: "Projection fields are server-provided estimates based on usage so far in the period; callers use the returned as_of timestamp when present.",
  },
  planResourceUsage: {
    owner: "components/settings/PlanSummaryCard.tsx",
    title: "Plan resource usage",
    units: ["resource-native count", "limit", "percent"],
    source: "Moosewave billing plan-summary API",
    scope: "Current workspace · current plan and billing period",
    asOf: null,
    note: "Non-positive limits are treated as explicitly unmetered rather than zero-cap resources.",
  },
  customFieldUsage: {
    owner: "components/settings/CustomFieldGovernance.tsx",
    title: "Custom-field limit usage",
    units: ["fields", "limit", "percent"],
    source: "Moosewave custom-field settings API",
    scope: "Current workspace · effective tenant limits",
    asOf: null,
    note: "Effective limits include any tenant override resolved by the server.",
  },
  sendingRateLimit: {
    owner: "pages/SendingSettings.tsx",
    title: "Hourly sending rate-limit usage",
    units: ["sends", "hourly limit", "percent", "reset time"],
    source: "Moosewave sending-settings status API",
    scope: "Current workspace · active hourly rate-limit bucket",
    asOf: null,
    note: "The visual clamps at full width while exact text and export retain any overage.",
  },
  mcpCallTrend: {
    owner: "pages/MCP.tsx",
    title: "MCP calls by hourly bucket",
    units: ["calls", "hourly bucket"],
    source: "Moosewave MCP trend API",
    scope: "Current workspace · active MCP history window and traffic filter",
    asOf: null,
    note: "The endpoint supplies rolling hourly buckets without an authoritative snapshot timestamp.",
  },
} as const satisfies Record<string, Dux025VisualSourceContract>;

export type Dux025VisualSourceKey = keyof typeof DUX_025_VISUAL_SOURCES;

export function dux025Provenance(
  key: Dux025VisualSourceKey,
  override: { scope?: string; note?: string; asOf?: string | null } = {},
): RequiredChartSupportProps["provenance"] {
  const contract = DUX_025_VISUAL_SOURCES[key];
  return {
    source: contract.source,
    asOf: override.asOf ?? contract.asOf,
    scope: override.scope ?? contract.scope,
    note: [contract.note, override.note].filter(Boolean).join(" "),
  };
}
