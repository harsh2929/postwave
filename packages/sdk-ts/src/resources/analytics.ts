// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/**
 * Aggregate report for one campaign. All numerics are over the
 * lifetime of the campaign; rates are computed at query time so a
 * fresh send shows zeros until events start flowing in.
 */
export interface CampaignReport {
  campaign_id: string;
  sent: number;
  delivered: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  open_rate: number;
  click_rate: number;
  click_to_open_rate: number;
  bounce_rate: number;
  unsub_rate: number;
  top_links: Array<{ url: string; clicks: number }>;
}

/**
 * Tenant overview — the tile shape for the dashboard. 30-day windows
 * are rolling.
 */
export interface DashboardStats {
  subscribers_total: number;
  subscribers_added_30d: number;
  subscribers_unsubbed_30d: number;
  campaigns_sent_30d: number;
  opens_total_30d: number;
  /** Distinct (campaign, recipient) open pairs in the active window. */
  unique_opens_30d?: number;
  /** Distinct (campaign, recipient) click pairs in the active window. */
  unique_clicks_30d?: number;
  /** Distinct (campaign, recipient) bounce pairs in the active window. */
  unique_bounces_30d?: number;
  /** Preferred open/click denominator when it covers the numerator. */
  unique_delivered_30d?: number;
  /** Open/click fallback and bounce-rate denominator. */
  unique_sent_30d?: number;
  clicks_total_30d: number;
  bounces_total_30d: number;
  /** Gross sent-event volume retained for backwards-compatible reporting. */
  emails_sent_30d?: number;
  /** Count of active voice sequences in the workspace. */
  active_sequences_count?: number;
  subscribers?: {
    total?: number;
    delta_30d?: number;
  };
  open_rate?: {
    rate?: number;
    delta?: number;
  };
  campaigns_sent?: {
    this_month?: number;
    delta?: number;
  };
  active_sequences?: {
    count?: number;
    delta?: number;
  };
  inbox_health?: {
    score?: number;
    state?: string;
  } | null;
  recent_audit?: Array<{
    id?: string;
    action?: string;
    actor?: string;
    at?: string;
    description?: string;
  }>;
  range?: "7d" | "30d" | "90d";
  previous?: {
    subscribers_added?: number;
    subscribers_unsubbed?: number;
    campaigns_sent?: number;
    emails_sent?: number;
    opens_total?: number;
    clicks_total?: number;
    bounces_total?: number;
    unique_opens?: number;
    unique_clicks?: number;
    unique_bounces?: number;
    unique_delivered?: number;
    unique_sent?: number;
  };
  sparklines?: Record<string, number[]>;
  anomalies?: Record<string, boolean>;
}

export interface LinkReportRow {
  url: string;
  clicks: number;
  unique_clickers: number;
  ctr: number;
}

export interface CampaignCompareRow {
  campaign_id: string;
  total_recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsub_rate: number;
}

export interface GeographyRow {
  country: string;
  opens: number;
  clicks: number;
}

export interface DeviceRow {
  client: string;
  opens: number;
  clicks: number;
}

export interface BounceCounts {
  hard: number;
  soft: number;
  spam_trap: number;
  total: number;
}

export interface CohortRow {
  cohort_label: string;
  cohort_size: number;
  weeks: number[];
}

export type CohortMetric = "open_rate" | "click_rate" | "retention";

export interface RevenueReport {
  attributed_revenue_cents: number;
  currency: string;
  conversions: number;
  attribution_window_days: number;
  note?: string;
}

/** Exact classifier/configuration coverage for a report window. */
export interface EngagementClassifierVersionCoverage {
  classifier_version?: string;
  methodology_version?: string;
  registry_version?: string;
  configuration_hash?: string;
  shadow_mode: boolean;
  event_count: number;
  /** True when these interaction events had no stored classifier decision. */
  unclassified: boolean;
}

export interface EngagementClassificationSummary {
  tenant_id: string;
  campaign_id?: string;
  window_start: string;
  window_end: string;
  generated_at: string;
  unit: "interaction_events";
  methodology: string;
  human: number;
  machine: number;
  unknown: number;
  total: number;
  machine_by_subtype: Record<string, number>;
  /** Empty for mixed or not-yet-classified coverage; inspect the array below. */
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: EngagementClassifierVersionCoverage[];
  mixed_classifier_versions: boolean;
  shadow_mode: boolean;
}

export interface PoweredIncrementalLift {
  evidence_pointer: {
    result_id: string;
    evidence_sha256: string;
  };
  powered: true;
  result_version: string;
  metric: string;
  window_start: string;
  window_end: string;
  n_treatment: number;
  n_control: number;
  conversions_treatment: number;
  conversions_control: number;
  rate_treatment: number;
  rate_control: number;
  absolute_lift: number;
  /** Percentage lift, not a ratio: 10% to 15% is 50; absent at a zero control rate. */
  relative_lift?: number;
  incremental_conversions: number;
  p_value: number;
  ci_low: number;
  ci_high: number;
  minimum_detectable_effect: number;
  methodology_version: string;
  /** Self-contained F02 population, outcome, statistical method, and power-gate explanation. */
  methodology_statement: string;
  generated_at: string;
}

export interface HumanEngagedReachReport {
  tenant_id: string;
  campaign_id?: string;
  window_start: string;
  window_end: string;
  generated_at: string;
  headline: string;
  provider_accepted_recipients: number;
  human_engaged_reach_floor: number;
  /** Mutually-exclusive unknown-only recipients; never allocated to the floor. */
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  no_interaction_recipients: number;
  machine_by_subtype: Record<string, number>;
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: EngagementClassifierVersionCoverage[];
  mixed_classifier_versions: boolean;
  shadow_mode: boolean;
  methodology: string;
  /** Present only for an immutable final F02 result that passed its power gate. */
  incremental_lift?: PoweredIncrementalLift;
}

export interface HumanEngagedReachMachineSubtypeEvidence {
  subtype: string;
  recipients: number;
}

export interface HumanEngagedReachEvidenceIntegrity {
  algorithm: "sha-256";
  digest_sha256: string;
  scope: "evidence_payload";
  canonicalization: string;
  /** A digest detects modification; this artifact is not cryptographically signed. */
  authenticity: "not_signed";
}

export interface HumanEngagedReachEvidenceSemantics {
  observed_evidence: string[];
  inferred_evidence: string[];
  not_observed: string[];
  human_reach_claim: string;
  unknown_treatment: string;
  acceptance_boundary: string;
}

export interface HumanEngagedReachEvidenceReport {
  tenant_id: string;
  campaign_id: string;
  window_start: string;
  window_end: string;
  headline: string;
  provider_accepted_recipients: number;
  human_engaged_reach_floor: number;
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  no_interaction_recipients: number;
  machine_by_subtype: HumanEngagedReachMachineSubtypeEvidence[];
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: EngagementClassifierVersionCoverage[];
  mixed_classifier_versions: boolean;
  shadow_mode: boolean;
  methodology: string;
  incremental_lift?: PoweredIncrementalLift;
}

export interface HumanEngagedReachEvidenceArtifact {
  artifact_schema_version: "postwave.human-engaged-reach-evidence.v1";
  artifact_kind: "human_engaged_reach_evidence";
  artifact_id: string;
  /** Document generation time; excluded from the content-addressed evidence payload. */
  generated_at: string;
  integrity: HumanEngagedReachEvidenceIntegrity;
  evidence_payload: {
    evidence_semantics: HumanEngagedReachEvidenceSemantics;
    report: HumanEngagedReachEvidenceReport;
  };
}

export interface EngagementReportQuery {
  campaignId?: string;
  /** Inclusive RFC3339 timestamp. Defaults to 30 days before `until`. */
  since?: string;
  /** Exclusive RFC3339 timestamp. Defaults to the server request time. */
  until?: string;
}

export interface HumanEngagedReachEvidenceExportQuery {
  campaignId: string;
  /** Inclusive RFC3339 timestamp; required so the artifact has a fixed scope. */
  since: string;
  /** Exclusive RFC3339 timestamp; required so the artifact has a fixed scope. */
  until: string;
}

export interface ReportCSVOptions {
  /** Pagination offset (rows). */
  offset?: number;
  /** Page size (max 50000). */
  limit?: number;
}

export interface ReportCSVResult {
  csv: string;
  truncated: boolean;
  totalRows: number | null;
}

/**
 * AnalyticsResource owns the read-side reporting surface: per-link click
 * reports, CSV export, side-by-side campaign comparison, geography/devices
 * breakdowns, bounce categorization, cohort analysis, and Stripe revenue
 * attribution.
 */
export class AnalyticsResource extends Resource {
  /** Per-campaign aggregate report. */
  campaignReport(campaignID: string): Promise<CampaignReport> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignID)}/report`,
    );
  }

  /** Tenant-level dashboard rollups (30-day windows + total subscribers). */
  dashboardStats(): Promise<DashboardStats> {
    return this.client.request("GET", "/api/v1/dashboard/stats");
  }

  linkReport(campaignId: string): Promise<LinkReportRow[]> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/link-report`,
    );
  }

  /**
   * Stream the per-subscriber lifecycle CSV. Honors offset/limit so callers
   * can page through campaigns larger than the 10 MiB body cap.
   */
  async reportCSV(campaignId: string, opts: ReportCSVOptions = {}): Promise<ReportCSVResult> {
    const csv = await this.client.request<string>(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/report.csv`,
      {
        asText: true,
        headers: { Accept: "text/csv" },
        query: {
          offset: opts.offset ?? undefined,
          limit: opts.limit ?? undefined,
        },
      },
    );
    return { csv, truncated: false, totalRows: null };
  }

  compare(campaignIds: string[]): Promise<CampaignCompareRow[]> {
    return this.client.request("GET", "/api/v1/analytics/campaigns/compare", {
      query: { ids: campaignIds.join(",") },
    });
  }

  geography(campaignId: string): Promise<GeographyRow[]> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/geography`,
    );
  }

  devices(campaignId: string): Promise<DeviceRow[]> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/devices`,
    );
  }

  bounces(campaignId: string): Promise<BounceCounts> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/bounces`,
    );
  }

  cohorts(
    params: { bucket?: "month"; metric?: CohortMetric; weeks?: number } = {},
  ): Promise<CohortRow[]> {
    return this.client.request("GET", "/api/v1/analytics/cohorts", {
      query: {
        bucket: params.bucket ?? "month",
        metric: params.metric ?? "open_rate",
        weeks: params.weeks ?? undefined,
      },
    });
  }

  revenue(campaignId: string): Promise<RevenueReport> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/revenue`,
    );
  }

  /** Event-level human/machine/unknown summary with exact classifier coverage. */
  engagementClassificationSummary(
    params: EngagementReportQuery = {},
  ): Promise<EngagementClassificationSummary> {
    return this.client.request(
      "GET",
      "/api/v1/analytics/engagement-classification/summary",
      {
        query: {
          campaign_id: params.campaignId,
          since: params.since,
          until: params.until,
        },
      },
    );
  }

  /** Recipient-level human-engaged reach floor plus its unknown-only band. */
  humanEngagedReach(
    params: EngagementReportQuery = {},
  ): Promise<HumanEngagedReachReport> {
    return this.client.request(
      "GET",
      "/api/v1/analytics/human-engaged-reach",
      {
        query: {
          campaign_id: params.campaignId,
          since: params.since,
          until: params.until,
        },
      },
    );
  }

  /** Downloadable fixed-window evidence payload with embedded SHA-256 metadata. */
  exportHumanEngagedReachEvidence(
    params: HumanEngagedReachEvidenceExportQuery,
  ): Promise<HumanEngagedReachEvidenceArtifact> {
    return this.client.request(
      "GET",
      "/api/v1/analytics/human-engaged-reach/export",
      {
        headers: {
          Accept:
            "application/vnd.postwave.human-engaged-reach-evidence+json",
        },
        query: {
          campaign_id: params.campaignId,
          since: params.since,
          until: params.until,
        },
      },
    );
  }
}
