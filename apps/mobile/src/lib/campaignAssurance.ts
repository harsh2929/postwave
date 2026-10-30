import { webHandoffUrl } from "./webHandoff";

export type MobileAssuranceSourceClass =
  | "deterministic"
  | "modeled"
  | "controlled_observation";

export const MOBILE_ASSURANCE_SOURCE_LABELS = {
  deterministic: "Deterministic",
  modeled: "Modeled prediction",
  controlled_observation: "Controlled observation",
  unavailable: "Unavailable evidence",
} as const;

export const MOBILE_ASSURANCE_SOURCE_ORDER: MobileAssuranceSourceClass[] = [
  "deterministic",
  "modeled",
  "controlled_observation",
];

export function mobileAssuranceUnavailableMeaning(
  missingSources: readonly { class: MobileAssuranceSourceClass }[],
  unavailableExtractionCount: number,
  evidenceMissing: boolean,
): string {
  if (missingSources.length > 0) {
    const names = missingSources
      .map((source) => MOBILE_ASSURANCE_SOURCE_LABELS[source.class])
      .join(", ");
    return `${names} missing from this measurement.`;
  }
  if (unavailableExtractionCount > 0) {
    return `${unavailableExtractionCount} extraction(s) are unavailable or errored.`;
  }
  if (evidenceMissing) {
    return "Finding and extraction details could not be loaded on this read; the server gate remains authoritative.";
  }
  return "No source class is declared missing; extraction failures can still make a run incomplete.";
}

export function mobileAssuranceNoReceiptCopy(canStart: boolean): string {
  const base =
    "Campaign Assurance hasn't run for this campaign yet, so a send will be refused until it has.";
  return canStart ? base : `${base} Starting a run needs an editor.`;
}

export interface MobileAssuranceLatestLike {
  detail: {
    run: {
      state: string;
      gate_decision: string;
      terminal_extraction_count: number;
      required_extraction_count: number;
      blocking_finding_count: number;
    };
  };
  applicability: {
    applicable_to_frozen_snapshot: boolean;
    freshness: string;
  };
}

export function mobileAssuranceVerdict(latest: MobileAssuranceLatestLike): {
  label: string;
  detail: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  const run = latest.detail.run;
  if (
    !latest.applicability.applicable_to_frozen_snapshot ||
    latest.applicability.freshness !== "frozen_snapshot_current" ||
    run.state === "stale" ||
    run.state === "cancelled"
  ) {
    return {
      label: "Stale",
      detail: "This receipt is not applicable to the current frozen snapshot.",
      tone: "warning",
    };
  }
  if (
    run.state === "queued" ||
    run.state === "running" ||
    run.gate_decision === "pending"
  ) {
    return {
      label: "Running",
      detail: `${run.terminal_extraction_count}/${run.required_extraction_count} required extractions are terminal.`,
      tone: "neutral",
    };
  }
  if (run.state !== "complete" || run.gate_decision === "unavailable") {
    return {
      label: "Incomplete",
      detail:
        "Required evidence is incomplete or unavailable; this is not a passing receipt.",
      tone: "warning",
    };
  }
  if (run.gate_decision === "block") {
    return {
      label: "Blocked",
      detail: `${run.blocking_finding_count} blocking finding(s) remain.`,
      tone: "danger",
    };
  }
  if (run.gate_decision === "warn") {
    return {
      label: "Warnings",
      detail: "The exact receipt is current, with advisory findings to review.",
      tone: "warning",
    };
  }
  if (run.gate_decision === "pass") {
    return {
      label: "Current receipt",
      detail:
        "Complete and current for the exact frozen revision, plan, and artifact set.",
      tone: "success",
    };
  }
  return {
    label: "Unavailable",
    detail:
      "The receipt decision is not recognized and cannot be treated as passing.",
    tone: "warning",
  };
}

export function campaignAssuranceWebUrl(
  appBaseUrl: string,
  campaignId: string | undefined,
): string | null {
  const base = webHandoffUrl(appBaseUrl, "campaign", campaignId);
  return base ? `${base}#campaign-assurance` : null;
}

export function shortAssuranceHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-7)}` : value;
}
