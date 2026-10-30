/**
 * human-engaged-reach — F12 on the desktop.
 *
 * The desktop is where a number gets copied into a board deck, which makes it
 * the surface where an overstated figure does the most damage. So the rule
 * from the server holds hardest here: the reach floor is a LOWER BOUND and is
 * only defensible with its unknown band attached.
 *
 * The API renders the sentence itself (ReachReport.Headline) precisely so no
 * client can show the number alone. This module renders that sentence and only
 * rebuilds one for an older gateway — and the rebuild still carries the band.
 */

import { apiRequest } from "./api-client";
import type { ApiResult } from "./api/result";

export interface HumanEngagedReach {
  headline: string;
  provider_accepted_recipients: number;
  human_engaged_reach_floor: number;
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  no_interaction_recipients: number;
  machine_by_subtype: Record<string, number>;
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: ClassifierVersionCoverage[];
  mixed_classifier_versions: boolean;
  shadow_mode: boolean;
  methodology: string;
}

export interface ClassifierVersionCoverage {
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  shadow_mode: boolean;
  event_count: number;
  unclassified: boolean;
}

export const REACH_UNAVAILABLE_MESSAGE =
  "Classifier-based engagement reach is unavailable until a passing dual-corpus calibration receipt and a separate cutover approval are present.";

const COUNTS = [
  "provider_accepted_recipients",
  "human_engaged_reach_floor",
  "unknown_band",
  "human_engaged_reach_upper_bound",
  "machine_only_recipients",
  "no_interaction_recipients",
] as const;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const VERSION = /^[a-z0-9][a-z0-9_.-]{0,95}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function releasedCoverage(
  value: unknown,
): value is ClassifierVersionCoverage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => {
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
    })
  );
}

/**
 * Returns undefined rather than a partial report. A half-parsed report drawn
 * as zeros reads as "nobody engaged", which is a claim rather than the absence
 * of one.
 */
export function parseReachReport(
  payload: unknown,
): HumanEngagedReach | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = payload as Record<string, unknown>;
  for (const field of COUNTS) {
    if (!count(raw[field])) return undefined;
  }
  // A native cache or older gateway can retain a successful shadow payload
  // across a rollout. Refuse it locally as well as at the server boundary.
  if (
    raw.shadow_mode !== false ||
    !releasedCoverage(raw.classifier_version_coverage)
  ) {
    return undefined;
  }
  const subtypes: Record<string, number> = {};
  if (raw.machine_by_subtype && typeof raw.machine_by_subtype === "object") {
    for (const [key, value] of Object.entries(
      raw.machine_by_subtype as object,
    )) {
      if (count(value)) subtypes[key] = value;
    }
  }
  return {
    headline: str(raw.headline),
    provider_accepted_recipients: raw.provider_accepted_recipients as number,
    human_engaged_reach_floor: raw.human_engaged_reach_floor as number,
    unknown_band: raw.unknown_band as number,
    human_engaged_reach_upper_bound:
      raw.human_engaged_reach_upper_bound as number,
    machine_only_recipients: raw.machine_only_recipients as number,
    no_interaction_recipients: raw.no_interaction_recipients as number,
    machine_by_subtype: subtypes,
    classifier_version: str(raw.classifier_version),
    methodology_version: str(raw.methodology_version),
    registry_version: str(raw.registry_version),
    configuration_hash: str(raw.configuration_hash),
    classifier_version_coverage: raw.classifier_version_coverage,
    mixed_classifier_versions: raw.mixed_classifier_versions === true,
    shadow_mode: false,
    methodology: str(raw.methodology),
  };
}

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

/** Everything qualifying the number, worst first. */
export function reachCaveats(report: HumanEngagedReach): string[] {
  const caveats: string[] = [];
  if (report.shadow_mode) {
    caveats.push(
      "The classifier is in shadow mode — running alongside the previous filter rather than deciding. Do not publish this figure yet.",
    );
  }
  if (report.mixed_classifier_versions) {
    caveats.push(
      "This window spans more than one classifier version, so it is not a single measurement. Labelling it with the latest alone would backdate a methodology change onto data it never described.",
    );
  }
  if (report.unknown_band > report.human_engaged_reach_floor) {
    caveats.push(
      `More recipients are unclassified (${report.unknown_band}) than carry a human-classified signal (${report.human_engaged_reach_floor}). Treat the floor as a weak lower bound rather than an estimate.`,
    );
  }
  return caveats;
}

export function getHumanEngagedReach(): Promise<ApiResult<unknown>> {
  return apiRequest("/api/v1/analytics/human-engaged-reach");
}
