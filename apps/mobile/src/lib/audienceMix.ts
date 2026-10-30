/**
 * lib/audienceMix.ts — the workspace-wide "where do opens come from, and what
 * got clicked" rollup, as PURE merge rules.
 *
 * Desktop answers this on the analytics page by reading the SAME per-campaign
 * endpoints the phone already reads one campaign at a time
 * (`/devices`, `/geography`, `/link-report`) across its five most recent
 * campaigns and summing them client-side
 * (apps/desktop/src/pages/analytics/useAnalyticsDashboardController.ts:369-445,
 * rendered by AnalyticsAudiencePanels.tsx). There is no workspace-level route
 * for any of the three, so the aggregation is the client's own arithmetic —
 * which is exactly why it lives here, where it can be tested, rather than
 * inside a component.
 *
 * THREE RULES THIS MODULE EXISTS TO HOLD:
 *
 *  1. ONLY CAMPAIGNS THAT ACTUALLY SENT. A draft contributes no opens, so
 *     including it in the denominator would silently shrink the scope
 *     sentence ("across 5 campaigns" when two of them never went out).
 *     Desktop takes the first five list rows unfiltered; the phone reads a
 *     10-row list and picks the five most recent SENT ones, which is the same
 *     intent applied honestly.
 *  2. RATES ARE NEVER SUMMED. `link-report` carries a per-campaign `ctr` whose
 *     denominator is that campaign's own recipients. Adding two of them, or
 *     keeping one of them on a merged row, would print a number no send ever
 *     had. Merged link rows therefore carry counts ONLY and drop `ctr` — the
 *     renderer then has nothing to mislabel.
 *  3. A PARTIAL ROLLUP SAYS SO. If one campaign's geography read fails, the
 *     other four still produce a chart, and a chart that quietly omits a fifth
 *     of the opens is worse than one that names what is missing.
 *
 * Import-free by construction (the type-only import erases at compile time) so
 * it runs in the node vitest environment.
 */
import type { CampaignLinkRow, CampaignNamedRow } from "@/lib/campaignInsights";

/** How many campaigns the rollup reads. Matches desktop's `slice(0, 5)`. */
export const AUDIENCE_MIX_CAMPAIGNS = 5;

export interface AudienceMixCampaign {
  id: string;
  name?: string | undefined;
  status?: string | undefined;
  sent_at?: string | null | undefined;
}

/**
 * Statuses that mean messages have left the building. `cancelled` is NOT here:
 * a cancelled campaign may have sent part of its audience, but only its
 * `sent_at` can say so, and the check below reads that independently.
 */
const SENT_STATUSES = new Set(["sending", "paused", "finished", "sent"]);

export function hasSendHappened(campaign: AudienceMixCampaign): boolean {
  const sentAt = typeof campaign.sent_at === "string" ? campaign.sent_at.trim() : "";
  if (sentAt !== "") return true;
  return SENT_STATUSES.has((campaign.status ?? "").trim().toLowerCase());
}

/**
 * The campaigns the rollup reads, newest first (the list endpoint's own
 * order), capped. Rows without an id are dropped rather than fetched as
 * `/api/v1/campaigns//devices`.
 */
export function audienceMixSources<T extends AudienceMixCampaign>(
  campaigns: readonly T[] | null | undefined,
  limit: number = AUDIENCE_MIX_CAMPAIGNS,
): T[] {
  const rows = Array.isArray(campaigns) ? campaigns : [];
  const bounded = Math.max(0, Math.trunc(limit));
  const out: T[] = [];
  for (const row of rows) {
    if (out.length >= bounded) break;
    if (!row || typeof row.id !== "string" || row.id.trim() === "") continue;
    if (!hasSendHappened(row)) continue;
    out.push(row);
  }
  return out;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sum `devices` (keyed by `client`) or `geography` (keyed by `country`) across
 * campaigns. A blank or missing name becomes "Unknown" — the same bucket the
 * per-campaign card uses — so two campaigns' unnamed rows land together
 * instead of producing two nameless entries.
 */
export function mergeNamedTotals(
  payloads: readonly unknown[],
  field: "client" | "country",
): CampaignNamedRow[] {
  const totals = new Map<string, CampaignNamedRow>();
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    for (const row of Array.isArray(payload) ? payload : []) {
      if (!isRecord(row)) continue;
      const raw = row[field];
      const key = (typeof raw === "string" ? raw.trim() : "") || "Unknown";
      const current =
        totals.get(key) ??
        (field === "client"
          ? { client: key, opens: 0, clicks: 0 }
          : { country: key, opens: 0, clicks: 0 });
      current.opens = finite(current.opens) + finite(row.opens);
      current.clicks = finite(current.clicks) + finite(row.clicks);
      totals.set(key, current);
    }
  }
  return [...totals.values()];
}

/**
 * Sum `link-report` rows by URL. `ctr` is deliberately absent from the result:
 * see rule 2 above. `unique_clickers` IS summed, with the caveat that one
 * person who clicked in two campaigns counts twice — there is no cross-campaign
 * identity in these payloads, so the honest thing is to keep the field off the
 * merged row entirely rather than present a "unique" number that is not.
 */
export function mergeLinkTotals(payloads: readonly unknown[]): CampaignLinkRow[] {
  const totals = new Map<string, { url: string; clicks: number }>();
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    for (const row of Array.isArray(payload) ? payload : []) {
      if (!isRecord(row)) continue;
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (url === "") continue;
      const current = totals.get(url) ?? { url, clicks: 0 };
      current.clicks += finite(row.clicks);
      totals.set(url, current);
    }
  }
  return [...totals.values()];
}

/**
 * The provenance line under each panel. Desktop prints "n of m recent
 * campaigns"; this says the same thing and names the send filter, because
 * "3 of 10" without it reads as a failure rather than as a choice.
 */
export function audienceMixScopeCaption(read: number, listed: number): string {
  const n = Math.max(0, Math.trunc(read));
  const m = Math.max(0, Math.trunc(listed));
  if (n === 0) return "No sent campaigns in the recent list.";
  return `Across ${n} sent campaign${n === 1 ? "" : "s"} of the ${m} most recent.`;
}

/**
 * Names the reads that failed, so a rollup missing one campaign's opens never
 * passes as complete. Returns "" when nothing failed.
 */
export function audienceMixUnavailableNote(
  labels: readonly string[] | null | undefined,
): string {
  const rows = (Array.isArray(labels) ? labels : []).filter(
    (label) => typeof label === "string" && label.trim() !== "",
  );
  if (rows.length === 0) return "";
  const unique = [...new Set(rows.map((label) => label.trim()))];
  return `Couldn't read ${unique.join(", ")} — those opens are missing from these totals.`;
}

export const AUDIENCE_MIX_EMPTY =
  "No opens or clicks recorded on recent campaigns yet.";

/**
 * Offline, the scope caption would read "No sent campaigns in the recent
 * list." — which is a claim about the workspace made from a phone that could
 * not ask. The rollup is fifteen live aggregate reads with nothing cached
 * behind it, so the honest answer offline is that it cannot be answered.
 */
export const AUDIENCE_MIX_OFFLINE =
  "The audience mix needs a connection — it's summed live across recent sends.";

/* --------------------------------------------------------- assembly ----- */

export type AudienceMixRead = "devices" | "geography" | "links";

/** One vocabulary for the three reads, used in every sentence about them. */
export const AUDIENCE_MIX_READ_LABELS: Record<AudienceMixRead, string> = {
  devices: "mail clients",
  geography: "countries",
  links: "links",
};

/** The three reads in render order, so no sentence can name a fourth. */
export const AUDIENCE_MIX_READS: readonly AudienceMixRead[] = [
  "devices",
  "geography",
  "links",
];

/**
 * The read names are EARNED, not asserted. `buildAudienceMix` is handed the
 * api layer's own results, but a react-query cache restored from an older
 * build can carry a read name this version no longer has — and indexing the
 * label record with it would print `undefined` into a sentence about missing
 * data.
 */
function isAudienceMixRead(value: unknown): value is AudienceMixRead {
  return (
    typeof value === "string" &&
    (AUDIENCE_MIX_READS as readonly string[]).includes(value)
  );
}

/**
 * A panel whose read FAILED must never borrow the empty copy: "no opens
 * recorded" is a claim about the workspace, and this is a claim about the
 * request.
 */
export function audienceMixPanelUnavailable(read: AudienceMixRead): string {
  return `Couldn't read ${AUDIENCE_MIX_READ_LABELS[read]} for these sends. This is not a reading of zero.`;
}

/**
 * Structurally what `api/audienceMix` returns per campaign. Declared here
 * rather than imported so this module keeps no edge into `api/*` (which
 * reaches react-native through the SDK client) and stays node-testable.
 */
export interface AudienceMixResultLike {
  campaignId: string;
  devices: unknown;
  geography: unknown;
  links: unknown;
  failures: readonly { read: AudienceMixRead; status: number }[];
  absent: readonly AudienceMixRead[];
}

export interface AudienceMixView {
  devices: CampaignNamedRow[];
  geography: CampaignNamedRow[];
  links: CampaignLinkRow[];
  /** Panels this deployment does not expose at all — render nothing for them. */
  absent: AudienceMixRead[];
  /**
   * Reads that failed for at least one campaign. A panel in here whose rows
   * came back empty must say the read failed, not that nothing was recorded.
   */
  failedReads: AudienceMixRead[];
  /** "" when every read succeeded; otherwise names what is missing. */
  missing: string;
  /** Campaigns whose reads all succeeded — the honest scope numerator. */
  campaignsRead: number;
}

/**
 * Merge every campaign's three payloads into the three panels.
 *
 * A read is only reported ABSENT when every campaign said so: one campaign
 * 404ing (deleted mid-rollup) is a gap in the totals, not a missing feature.
 */
export function buildAudienceMix(
  results: readonly AudienceMixResultLike[] | null | undefined,
): AudienceMixView {
  const rows: readonly unknown[] = Array.isArray(results) ? results : [];
  const failedLabels: string[] = [];
  const failed = new Set<AudienceMixRead>();
  const absentCounts: Record<AudienceMixRead, number> = {
    devices: 0,
    geography: 0,
    links: 0,
  };
  let clean = 0;
  for (const row of rows) {
    const result = isRecord(row) ? row : {};
    const failures: readonly unknown[] = Array.isArray(result.failures)
      ? result.failures
      : [];
    const absentReads: readonly unknown[] = Array.isArray(result.absent)
      ? result.absent
      : [];
    for (const failure of failures) {
      const read = isRecord(failure) ? failure.read : undefined;
      if (!isAudienceMixRead(read)) continue;
      failed.add(read);
      failedLabels.push(AUDIENCE_MIX_READ_LABELS[read]);
    }
    for (const read of absentReads) {
      if (isAudienceMixRead(read)) absentCounts[read] += 1;
    }
    if (failures.length === 0) clean += 1;
  }
  const absent: AudienceMixRead[] = AUDIENCE_MIX_READS.filter(
    (read) => rows.length > 0 && absentCounts[read] === rows.length,
  );
  const payloads = (field: AudienceMixRead): unknown[] =>
    rows.map((row) => (isRecord(row) ? row[field] : []));
  return {
    devices: mergeNamedTotals(payloads("devices"), "client"),
    geography: mergeNamedTotals(payloads("geography"), "country"),
    links: mergeLinkTotals(payloads("links")),
    absent,
    failedReads: AUDIENCE_MIX_READS.filter((read) => failed.has(read)),
    missing: audienceMixUnavailableNote(failedLabels),
    campaignsRead: clean,
  };
}

/** What the panels are, said once, above them. */
export const AUDIENCE_MIX_SUBTITLE =
  "Mail clients, countries and links summed across recent sends.";
