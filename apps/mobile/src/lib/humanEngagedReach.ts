/**
 * humanEngagedReach — F12 on the phone.
 *
 * The open rate is the number people quote, and it counts machines: proxies,
 * prefetchers and security scanners all generate opens. This report replaces
 * it with one we can defend — recipients with at least one interaction we can
 * attribute to a person.
 *
 * It is a FLOOR, not an estimate, and it is only honest with its band attached.
 * The server renders the sentence itself so a client cannot show the number
 * alone; this module treats that sentence as the unit of output and only
 * rebuilds one when an older gateway sends none — and the rebuild still
 * carries the band.
 *
 * Parsing is strict because a phone gets truncated responses far more often
 * than a desktop, and a partially-parsed report rendered as zeros reads as
 * "nobody engaged" rather than "we did not load this".
 */

export interface HumanEngagedReach {
  headline: string;
  provider_accepted_recipients: number;
  human_engaged_reach_floor: number;
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  no_interaction_recipients: number;
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

const COUNT_FIELDS = [
  "provider_accepted_recipients",
  "human_engaged_reach_floor",
  "unknown_band",
  "human_engaged_reach_upper_bound",
  "machine_only_recipients",
  "no_interaction_recipients",
] as const;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function text(value: unknown): string {
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

/** Returns undefined rather than a partial report. */
export function parseReachReport(
  payload: unknown,
): HumanEngagedReach | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = payload as Record<string, unknown>;
  for (const field of COUNT_FIELDS) {
    if (!isCount(raw[field])) return undefined;
  }
  if (
    raw.shadow_mode !== false ||
    !releasedCoverage(raw.classifier_version_coverage)
  ) {
    return undefined;
  }
  return {
    headline: text(raw.headline),
    provider_accepted_recipients: raw.provider_accepted_recipients as number,
    human_engaged_reach_floor: raw.human_engaged_reach_floor as number,
    unknown_band: raw.unknown_band as number,
    human_engaged_reach_upper_bound:
      raw.human_engaged_reach_upper_bound as number,
    machine_only_recipients: raw.machine_only_recipients as number,
    no_interaction_recipients: raw.no_interaction_recipients as number,
    classifier_version: text(raw.classifier_version),
    methodology_version: text(raw.methodology_version),
    registry_version: text(raw.registry_version),
    configuration_hash: text(raw.configuration_hash),
    classifier_version_coverage: raw.classifier_version_coverage,
    mixed_classifier_versions: raw.mixed_classifier_versions === true,
    shadow_mode: false,
    methodology: text(raw.methodology),
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
      "The classifier is in shadow mode — it is running alongside the old filter rather than deciding. Do not publish this figure yet.",
    );
  }
  if (report.mixed_classifier_versions) {
    caveats.push(
      "This window spans more than one classifier version, so it is not a single measurement.",
    );
  }
  if (report.unknown_band > report.human_engaged_reach_floor) {
    caveats.push(
      `More recipients are unclassified (${report.unknown_band}) than carry a human-classified signal (${report.human_engaged_reach_floor}). Treat the floor as a weak lower bound.`,
    );
  }
  return caveats;
}
