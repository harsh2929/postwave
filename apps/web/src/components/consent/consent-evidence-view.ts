// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure view model for the loaded consent receipt/proof register: the filters,
// search, and ordering desktop applies client-side over loaded rows
// (apps/desktop/src/pages/Consent.tsx:137-218, 996-1029). Nothing here sends a
// request — every filter narrows rows ALREADY loaded, and the UI says so.

import type { ConsentReceipt } from "@/lib/consent-receipts-api";
import { consentReceiptIdentity } from "@/lib/consent-receipts-api";

export type ConsentSourceFilter =
  | "all"
  | "form"
  | "api"
  | "import"
  | "public-record"
  | "other";
export type ConsentOutcomeFilter =
  | "all"
  | "opt-in"
  | "opt-out"
  | "pending"
  | "other";
export type ConsentEvidenceFilter = "all" | "receipt" | "proof";
export type ConsentPeriodFilter = "all" | "7d" | "30d" | "90d";
export type ConsentSortDirection = "desc" | "asc";

export interface ConsentEvidenceView {
  source: ConsentSourceFilter;
  outcome: ConsentOutcomeFilter;
  evidence: ConsentEvidenceFilter;
  period: ConsentPeriodFilter;
  query: string;
  direction: ConsentSortDirection;
}

export const DEFAULT_CONSENT_VIEW: ConsentEvidenceView = {
  source: "all",
  outcome: "all",
  evidence: "all",
  period: "all",
  query: "",
  direction: "desc",
};

export const CONSENT_SOURCE_FILTERS: ReadonlyArray<{
  id: ConsentSourceFilter;
  label: string;
}> = [
  { id: "all", label: "All sources" },
  { id: "form", label: "Forms" },
  { id: "api", label: "API" },
  { id: "import", label: "Imports" },
  { id: "public-record", label: "Migration / public" },
  { id: "other", label: "Other" },
];

export const CONSENT_OUTCOME_FILTERS: ReadonlyArray<{
  id: ConsentOutcomeFilter;
  label: string;
}> = [
  { id: "all", label: "All outcomes" },
  { id: "opt-in", label: "Opt-in" },
  { id: "opt-out", label: "Opt-out" },
  { id: "pending", label: "Pending" },
  { id: "other", label: "Other recorded state" },
];

export const CONSENT_EVIDENCE_FILTERS: ReadonlyArray<{
  id: ConsentEvidenceFilter;
  label: string;
}> = [
  { id: "all", label: "All evidence" },
  { id: "receipt", label: "State-change receipt" },
  { id: "proof", label: "Structured proof" },
];

export const CONSENT_PERIOD_FILTERS: ReadonlyArray<{
  id: ConsentPeriodFilter;
  label: string;
}> = [
  { id: "all", label: "Any loaded time" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
];

export const CONSENT_QUERY_MAX = 256;

export function consentSourceBucket(
  source: string | undefined,
): ConsentSourceFilter {
  const normalized = (source ?? "").trim().toLowerCase();
  if (normalized.startsWith("form")) return "form";
  if (normalized.startsWith("api")) return "api";
  if (normalized === "csv_import" || normalized.startsWith("import")) {
    return "import";
  }
  if (normalized.startsWith("migration") || normalized.startsWith("public")) {
    return "public-record";
  }
  return "other";
}

export function consentOutcomeGroup(
  state: string | undefined,
): Exclude<ConsentOutcomeFilter, "all"> {
  const normalized = (state ?? "").trim().toLowerCase();
  if (normalized === "granted" || normalized === "subscribed") return "opt-in";
  if (normalized === "unsubscribed" || normalized === "withdrawn") {
    return "opt-out";
  }
  if (normalized === "pending") return "pending";
  return "other";
}

export function consentOutcomeLabel(receipt: ConsentReceipt): string {
  switch (consentOutcomeGroup(receipt.new_state)) {
    case "opt-in":
      return "Opt-in";
    case "opt-out":
      return "Opt-out";
    case "pending":
      return "Pending";
    default:
      return receipt.new_state || "Unknown recorded state";
  }
}

export function evidenceKindLabel(kind: string | undefined): string {
  return kind === "proof" ? "Structured proof" : "State-change receipt";
}

function periodDays(period: ConsentPeriodFilter): number | null {
  if (period === "7d") return 7;
  if (period === "30d") return 30;
  if (period === "90d") return 90;
  return null;
}

/** Future-dated rows never satisfy a bounded window — they cannot be "recent". */
function withinPeriod(
  value: string,
  period: ConsentPeriodFilter,
  now: number,
): boolean {
  const days = periodDays(period);
  if (days === null) return true;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= now && parsed >= now - days * 86_400_000;
}

function recordedOrder(left: ConsentReceipt, right: ConsentReceipt): number {
  const l = Date.parse(left.recorded_at);
  const r = Date.parse(right.recorded_at);
  // An unverifiable recording time sorts after every verifiable one.
  if (Number.isFinite(l) !== Number.isFinite(r)) {
    return Number.isFinite(l) ? -1 : 1;
  }
  const time = Number.isFinite(l) ? r - l : 0;
  if (time !== 0) return time;
  return consentReceiptIdentity(right).localeCompare(
    consentReceiptIdentity(left),
  );
}

/** The loaded rows this view shows, in its order. */
export function filterConsentReceipts(
  rows: readonly ConsentReceipt[],
  view: ConsentEvidenceView,
  now: number = Date.now(),
): ConsentReceipt[] {
  const needle = view.query.trim().toLowerCase();
  const matched = rows.filter((receipt) => {
    if (
      view.source !== "all" &&
      consentSourceBucket(receipt.source) !== view.source
    ) {
      return false;
    }
    if (
      view.outcome !== "all" &&
      consentOutcomeGroup(receipt.new_state) !== view.outcome
    ) {
      return false;
    }
    if (view.evidence !== "all" && receipt.kind !== view.evidence) {
      return false;
    }
    if (!withinPeriod(receipt.at, view.period, now)) return false;
    if (!needle) return true;
    return [
      receipt.subscriber_email,
      consentReceiptIdentity(receipt),
      receipt.source,
      receipt.source_detail,
      receipt.privacy_policy_version,
      receipt.new_state,
    ].some((value) => (value ?? "").toLowerCase().includes(needle));
  });
  matched.sort((left, right) => {
    const ordered = recordedOrder(left, right);
    return view.direction === "asc" ? -ordered : ordered;
  });
  return matched;
}

export function consentSourceCounts(
  rows: readonly ConsentReceipt[],
): Record<ConsentSourceFilter, number> {
  const counts: Record<ConsentSourceFilter, number> = {
    all: 0,
    form: 0,
    api: 0,
    import: 0,
    "public-record": 0,
    other: 0,
  };
  for (const receipt of rows) {
    counts.all += 1;
    counts[consentSourceBucket(receipt.source)] += 1;
  }
  return counts;
}

export function activeConsentFilterCount(view: ConsentEvidenceView): number {
  return [
    view.source !== "all",
    view.outcome !== "all",
    view.evidence !== "all",
    view.period !== "all",
    Boolean(view.query.trim()),
    view.direction !== "desc",
  ].filter(Boolean).length;
}
