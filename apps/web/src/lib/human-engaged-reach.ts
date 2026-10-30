// SPDX-License-Identifier: AGPL-3.0-only
//
// human-engaged-reach.ts — F12's client surface.
//
// The API, its OpenAPI contract, and the TypeScript/Python SDKs for this
// report have all existed for a while with no screen rendering them, so the
// number meant to replace the open rate has been invisible to the people it
// was built for. This is the read path.
//
// The one rule that governs everything here: the floor is a LOWER BOUND, and
// it is only defensible while the unknown band travels with it. The server
// renders the sentence itself (ReachReport.Headline) precisely so a client
// cannot show the number alone; this module treats that sentence as the unit
// of output rather than re-deriving one.

import { api, ApiError } from "@/lib/api";

export const REACH_UNAVAILABLE_CODE = "human_engaged_reach_unavailable";
export const REACH_UNAVAILABLE_MESSAGE =
  "Classifier-based engagement reach is unavailable until a passing dual-corpus calibration receipt and a separate cutover approval are present.";

export interface ClassifierVersionCoverage {
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  shadow_mode: boolean;
  event_count: number;
  unclassified: boolean;
}

export interface HumanEngagedReach {
  tenant_id: string;
  campaign_id?: string;
  window_start: string;
  window_end: string;
  generated_at: string;

  /** The server-rendered sentence. Render this, do not rebuild it. */
  headline: string;

  provider_accepted_recipients: number;
  /** Recipients with at least one HUMAN-classified interaction. A floor. */
  human_engaged_reach_floor: number;
  /** Additional recipients whose interactions were all unclassifiable. */
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  /** Delivered recipients who did nothing observable. Usually the largest group. */
  no_interaction_recipients: number;
  machine_by_subtype: Record<string, number>;

  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: ClassifierVersionCoverage[];
  mixed_classifier_versions: boolean;
  /** True while the classifier runs alongside the old filter, not as the answer. */
  shadow_mode: boolean;
  methodology: string;
  incremental_lift?: unknown;
}

/**
 * The sentence to display.
 *
 * Prefers the server's, which is generated from the same constants the
 * computation used and therefore cannot disagree with it. The fallback exists
 * only for an older gateway, and it still carries the band — a fallback that
 * degraded to the bare floor would reintroduce exactly the overstatement the
 * band prevents.
 */
export function reachHeadline(report: HumanEngagedReach): string {
  const served = report.headline.trim();
  if (served !== "") return served;
  if (report.unknown_band === 0) {
    return `human-engaged reach floor: ${report.human_engaged_reach_floor}`;
  }
  return (
    `human-engaged reach floor: ${report.human_engaged_reach_floor}, ` +
    `with up to ${report.unknown_band} additional unclassified`
  );
}

/**
 * Floor and upper bound as shares of provider-accepted recipients.
 *
 * Undefined when nothing was delivered: a percentage of zero is NaN or
 * Infinity, and a headline metric that renders nonsense on an empty window is
 * one people learn to ignore.
 */
export function reachShare(
  report: HumanEngagedReach,
): { floor: number; upper: number } | undefined {
  const delivered = report.provider_accepted_recipients;
  if (!Number.isFinite(delivered) || delivered <= 0) return undefined;
  return {
    floor: report.human_engaged_reach_floor / delivered,
    upper: report.human_engaged_reach_upper_bound / delivered,
  };
}

/**
 * Everything that qualifies the number, in the order it should be read.
 *
 * Shadow mode comes first because it is the only one that makes the figure
 * unusable rather than merely uncertain.
 */
export function reachCaveats(report: HumanEngagedReach): string[] {
  const caveats: string[] = [];

  if (report.shadow_mode) {
    caveats.push(
      "The classifier is in shadow mode: it is running alongside the previous " +
        "filter rather than deciding. Do not publish this figure yet.",
    );
  }

  if (report.mixed_classifier_versions) {
    const versions = report.classifier_version_coverage
      .map((row) => row.classifier_version)
      .join(", ");
    caveats.push(
      `This window spans more than one classifier version (${versions}), so it ` +
        "is not a single measurement. Labelling it with the latest version " +
        "alone would backdate a methodology change onto data it never described.",
    );
  }

  // When the band is wider than the floor, the honest summary is "we mostly do
  // not know" — and that has to be said in words, not left in a number.
  if (report.unknown_band > report.human_engaged_reach_floor) {
    caveats.push(
      `More recipients are unclassified (${report.unknown_band}) than are ` +
        `carrying a human-classified signal (${report.human_engaged_reach_floor}). Treat the floor ` +
        "as a weak lower bound rather than an estimate.",
    );
  }

  return caveats;
}

export interface ReachQueryOptions {
  campaignId?: string;
  since?: string;
  until?: string;
  signal?: AbortSignal;
}

const VERSION = /^[a-z0-9][a-z0-9_.-]{0,95}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Refuse a cached or older-gateway shadow payload even if it arrived with a
 * 200. The server is authoritative, but clients can retain responses across a
 * rollout; a successful status alone must never turn shadow evidence into a
 * customer-facing human claim.
 */
export function isReleasedReachPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const raw = payload as Record<string, unknown>;
  if (
    raw.shadow_mode !== false ||
    !Array.isArray(raw.classifier_version_coverage)
  ) {
    return false;
  }
  const coverage = raw.classifier_version_coverage;
  if (coverage.length === 0) return false;
  return coverage.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return (
      row.shadow_mode === false &&
      row.unclassified === false &&
      typeof row.event_count === "number" &&
      Number.isSafeInteger(row.event_count) &&
      row.event_count > 0 &&
      typeof row.classifier_version === "string" &&
      VERSION.test(row.classifier_version) &&
      typeof row.methodology_version === "string" &&
      VERSION.test(row.methodology_version) &&
      typeof row.registry_version === "string" &&
      VERSION.test(row.registry_version) &&
      typeof row.configuration_hash === "string" &&
      SHA256.test(row.configuration_hash)
    );
  });
}

export function requireReleasedReachPayload<T>(payload: T): T {
  if (!isReleasedReachPayload(payload)) {
    throw new ApiError(REACH_UNAVAILABLE_MESSAGE, 409, undefined, {
      code: REACH_UNAVAILABLE_CODE,
      kind: "http",
    });
  }
  return payload;
}

export async function getHumanEngagedReach(
  opts: ReachQueryOptions = {},
): Promise<HumanEngagedReach> {
  const params = new URLSearchParams();
  if (opts.campaignId) params.set("campaign_id", opts.campaignId);
  if (opts.since) params.set("since", opts.since);
  if (opts.until) params.set("until", opts.until);
  const query = params.toString();
  const report = await api.get<HumanEngagedReach>(
    `/api/v1/analytics/human-engaged-reach${query ? `?${query}` : ""}`,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  return requireReleasedReachPayload(report);
}

/**
 * The evidence export URL. It requires every scope input explicitly, because a
 * saved artifact must not depend on a moving server-time default — the file is
 * meant to still mean the same thing when someone opens it next year.
 */
export function humanEngagedReachExportURL(
  since: string,
  until: string,
  campaignId?: string,
): string {
  const params = new URLSearchParams({ since, until });
  if (campaignId) params.set("campaign_id", campaignId);
  return `/api/v1/analytics/human-engaged-reach/export?${params.toString()}`;
}
