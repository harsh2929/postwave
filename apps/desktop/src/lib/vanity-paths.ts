/**
 * vanity-paths — F04 on the desktop.
 *
 * A short address is the "no tracked link in the email" route: the email may
 * print example.com/go/spring for a reader to type. The recorded request is
 * still only campaign-level provenance; crawlers, prefetchers, and forwarded
 * copies can reach it too.
 *
 * It is not proof of human attention or readership. Codes and addresses get
 * forwarded, screenshotted, read aloud, crawled, and prefetched.
 * readershipCaveat is defined once, here, so no surface can quietly omit it.
 */

import { apiRequest } from "./api-client";
import type { ApiResult } from "./api/result";

const MAX_SLUG = 64;
const MAX_HOST = 253;
const MAX_LABEL = 63;

export type SlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

/** Mirrors NormalizeSlug in apps/api/internal/coderedemption/vanity.go. */
export function normalizeSlug(raw: string): SlugResult {
  const slug = raw.trim().toLowerCase();
  if (slug.length < 1 || slug.length > MAX_SLUG) {
    return { ok: false, reason: `Use between 1 and ${MAX_SLUG} characters.` };
  }
  for (let index = 0; index < slug.length; index += 1) {
    const c = slug[index] ?? "";
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) continue;
    if (c === "-") {
      if (index === 0 || index === slug.length - 1) {
        return {
          ok: false,
          reason:
            "A dash cannot start or end the address — some email clients trim it when they linkify a URL, so readers would land somewhere else.",
        };
      }
      continue;
    }
    return {
      ok: false,
      reason:
        "Use only lowercase letters, numbers and dashes. This is meant to be read aloud and retyped without ambiguity.",
    };
  }
  return { ok: true, slug };
}

/** Mirrors validDestinationHost + ValidateDestinationPath. Every problem. */
export function validateDestination(host: string, path: string): string[] {
  const problems: string[] = [];
  const cleanHost = host.trim().toLowerCase();
  const labels = cleanHost.split(".");
  const hostOk =
    cleanHost !== "" &&
    cleanHost.length <= MAX_HOST &&
    labels.length >= 2 &&
    labels.every((label) => label !== "" && label.length <= MAX_LABEL);
  if (!hostOk) {
    problems.push("Enter a full domain such as shop.example.com.");
  }
  if (path !== path.trim() || path === "" || !path.startsWith("/")) {
    problems.push(
      "The destination path must start with a slash, e.g. /spring.",
    );
  } else if (path.startsWith("//")) {
    // A browser reads "//evil.example" as a different HOST, so accepting it
    // would turn our own domain into an open redirect.
    problems.push(
      "A path starting with two slashes points at a different site, not a page on this one.",
    );
  }
  return problems;
}

export function publicPathFor(slug: string): string {
  return `/go/${slug}`;
}

export function readershipCaveat(): string {
  return (
    "A visit proves only that this address was requested — not that a person " +
    "typed it, arrived, or read the email. Codes and addresses can be forwarded, " +
    "screenshotted, read aloud, crawled, or prefetched. Treat linked outcomes as " +
    "campaign linkage, never proof of human attention or readership."
  );
}

export function outcomeVisibilityCaveat(): string {
  return (
    "This audited register reports campaign linkage, not reader identity. A " +
    "failed or invalid evidence response is never shown as zero, and historical " +
    "redemptions whose event-time click observation was not retained remain " +
    "explicitly unavailable rather than being inferred. Monetary values stay " +
    "on their own receipt with their recorded currency; no cross-currency total " +
    "is shown."
  );
}

export interface CampaignDirectAttributionEvidence {
  campaign_id: string;
  summary: {
    code_allocations: number;
    code_redemptions: number;
    code_linked_outcomes: number;
    no_click_redemptions: number;
    with_click_redemptions: number;
    click_evidence_unavailable: number;
    vanity_visits: number;
    vanity_linked_outcomes: number;
  };
  items: Array<{
    kind: "code_allocation" | "vanity_visit";
    evidence_id: string;
    occurred_at: string;
    status: string;
    expires_at: string | null;
    redeemed_at: string | null;
    redemption_id: number | null;
    conversion_id: number | null;
    amount_cents: number | null;
    currency: string;
    attributed_via: "code_redemption" | "campaign_vanity_path";
    attribution_scope: "campaign_assignment" | "campaign";
    linked_without_recorded_assignment_click: boolean | null;
    readership_proven: false;
  }>;
  page_info: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
}

export function campaignEvidenceOutcomeLabel(
  conversionId: number | null,
  amountCents: number | null,
  currency: string,
): string | null {
  if (conversionId === null) return null;
  if (amountCents === null) {
    return `Linked conversion ${conversionId} · value unavailable`;
  }
  if (currency === "") {
    return `Linked conversion ${conversionId} · ${amountCents} recorded cents; currency unavailable`;
  }
  return `Linked conversion ${conversionId} · ${currency} ${(amountCents / 100).toFixed(2)}`;
}

function evidenceRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function evidenceInteger(value: unknown, minimum?: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (minimum === undefined || value >= minimum)
    ? value
    : null;
}

function evidenceUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function evidenceTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function evidenceExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  );
}

export function parseCampaignDirectAttributionEvidence(
  payload: unknown,
  expectedCampaignId: string,
): CampaignDirectAttributionEvidence | null {
  const root = evidenceRecord(payload);
  const summary = evidenceRecord(root?.summary);
  const page = evidenceRecord(root?.page_info);
  if (
    !root ||
    !summary ||
    !page ||
    !evidenceExactFields(root, [
      "campaign_id",
      "summary",
      "items",
      "page_info",
    ]) ||
    !evidenceUUID(root.campaign_id) ||
    root.campaign_id !== expectedCampaignId ||
    !Array.isArray(root.items) ||
    root.items.length > 100
  ) {
    return null;
  }
  const summaryKeys = [
    "code_allocations",
    "code_redemptions",
    "code_linked_outcomes",
    "no_click_redemptions",
    "with_click_redemptions",
    "click_evidence_unavailable",
    "vanity_visits",
    "vanity_linked_outcomes",
  ] as const;
  if (!evidenceExactFields(summary, summaryKeys)) return null;
  const parsedSummary: Record<string, number> = {};
  for (const key of summaryKeys) {
    const value = evidenceInteger(summary[key], 0);
    if (value === null) return null;
    parsedSummary[key] = value;
  }
  if (
    parsedSummary.code_redemptions > parsedSummary.code_allocations ||
    parsedSummary.code_linked_outcomes > parsedSummary.code_allocations ||
    parsedSummary.no_click_redemptions +
      parsedSummary.with_click_redemptions +
      parsedSummary.click_evidence_unavailable !==
      parsedSummary.code_redemptions ||
    parsedSummary.vanity_linked_outcomes > parsedSummary.vanity_visits
  ) {
    return null;
  }
  const items: CampaignDirectAttributionEvidence["items"] = [];
  for (const raw of root.items) {
    const row = evidenceRecord(raw);
    if (!row) return null;
    if (
      !evidenceExactFields(row, [
        "kind",
        "evidence_id",
        "occurred_at",
        "status",
        "expires_at",
        "redeemed_at",
        "redemption_id",
        "conversion_id",
        "amount_cents",
        "currency",
        "attributed_via",
        "attribution_scope",
        "linked_without_recorded_assignment_click",
        "readership_proven",
      ])
    ) {
      return null;
    }
    const kind = row.kind;
    const via = row.attributed_via;
    const scope = row.attribution_scope;
    if (
      (kind !== "code_allocation" && kind !== "vanity_visit") ||
      (via !== "code_redemption" && via !== "campaign_vanity_path") ||
      (scope !== "campaign_assignment" && scope !== "campaign") ||
      row.readership_proven !== false ||
      !evidenceUUID(row.evidence_id) ||
      !evidenceTimestamp(row.occurred_at) ||
      typeof row.status !== "string" ||
      row.status.trim() === "" ||
      typeof row.currency !== "string" ||
      !/^(?:|[A-Z]{3})$/u.test(row.currency) ||
      (row.expires_at !== null && !evidenceTimestamp(row.expires_at)) ||
      (row.redeemed_at !== null && !evidenceTimestamp(row.redeemed_at)) ||
      (row.linked_without_recorded_assignment_click !== null &&
        typeof row.linked_without_recorded_assignment_click !== "boolean") ||
      (kind === "code_allocation" &&
        (via !== "code_redemption" || scope !== "campaign_assignment")) ||
      (kind === "vanity_visit" &&
        (via !== "campaign_vanity_path" || scope !== "campaign"))
    ) {
      return null;
    }
    const redemptionID =
      row.redemption_id === null ? null : evidenceInteger(row.redemption_id, 1);
    const conversionID =
      row.conversion_id === null ? null : evidenceInteger(row.conversion_id, 1);
    const amount =
      row.amount_cents === null ? null : evidenceInteger(row.amount_cents);
    if (
      (row.redemption_id !== null && redemptionID === null) ||
      (row.conversion_id !== null && conversionID === null) ||
      (row.amount_cents !== null && amount === null)
    ) {
      return null;
    }
    items.push({
      kind,
      evidence_id: row.evidence_id,
      occurred_at: row.occurred_at,
      status: row.status,
      expires_at: row.expires_at as string | null,
      redeemed_at: row.redeemed_at as string | null,
      redemption_id: redemptionID,
      conversion_id: conversionID,
      amount_cents: amount,
      currency: row.currency,
      attributed_via: via,
      attribution_scope: scope,
      linked_without_recorded_assignment_click:
        row.linked_without_recorded_assignment_click as boolean | null,
      readership_proven: false,
    });
  }
  const limit = evidenceInteger(page.limit, 1);
  const offset = evidenceInteger(page.offset, 0);
  const total = evidenceInteger(page.total, 0);
  if (
    limit === null ||
    limit > 100 ||
    offset === null ||
    offset > 10_000 ||
    total === null ||
    typeof page.has_more !== "boolean" ||
    !evidenceExactFields(page, ["limit", "offset", "total", "has_more"])
  ) {
    return null;
  }
  if (
    total !== parsedSummary.code_allocations + parsedSummary.vanity_visits ||
    items.length > limit ||
    page.has_more !== offset + items.length < total
  ) {
    return null;
  }
  return {
    campaign_id: root.campaign_id,
    summary:
      parsedSummary as unknown as CampaignDirectAttributionEvidence["summary"],
    items,
    page_info: { limit, offset, total, has_more: page.has_more },
  };
}

export async function listCampaignDirectAttributionEvidence(
  campaignId: string,
  offset = 0,
  limit = 25,
): Promise<ApiResult<CampaignDirectAttributionEvidence>> {
  const path =
    "/api/v1/campaigns/" +
    encodeURIComponent(campaignId) +
    "/direct-attribution-evidence?limit=" +
    limit +
    "&offset=" +
    offset;
  const result = await apiRequest(path);
  if (result.error) return result;
  const parsed = parseCampaignDirectAttributionEvidence(
    result.data,
    campaignId,
  );
  if (!parsed) {
    return {
      error: {
        kind: "parse",
        code: "invalid_direct_attribution_evidence",
        message:
          "The campaign attribution evidence response was invalid; it was not treated as an empty register.",
      },
      retryability: "manual",
    };
  }
  return { data: parsed };
}

export interface VanityPath {
  id: string;
  slug: string;
  public_path: string;
  destination_host: string;
  destination_path: string;
  status: string;
}

export function listVanityPaths(
  campaignId: string,
): Promise<ApiResult<unknown>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/vanity-paths`,
  );
}
