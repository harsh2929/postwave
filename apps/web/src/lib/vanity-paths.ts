// SPDX-License-Identifier: AGPL-3.0-only
//
// vanity-paths.ts — F04's client surface: campaign codes and direct navigation.
//
// A vanity path is the "no link in the email" route. Instead of a tracked
// link, the email says: go to example.com/go/spring. A reader may type it.
//
// The public path is useful campaign-level provenance, but a request to it is
// not inherently human: the address can be forwarded, crawled, or prefetched.
// The product must never promote the request into human-attention evidence.
//
// It is still NOT proof of readership, and the UI must say so. A code can be
// forwarded, screenshotted, or read aloud; the person who arrives may never
// have opened the email. The blueprint is explicit that codes prove REDEMPTION
// LINKAGE, not reader identity, and readershipCaveat() is that sentence in one
// place so no surface can quietly omit it.

import { api } from "@/lib/api";

const MAX_SLUG_LENGTH = 64;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

export type SlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

/**
 * Mirrors NormalizeSlug in apps/api/internal/coderedemption/vanity.go:
 * lowercase, 1..64 chars, [a-z0-9-], no leading or trailing dash.
 *
 * The dash rule is not cosmetic: some clients trim a trailing dash when they
 * linkify a URL, so the path a reader lands on would not be the one published.
 */
export function normalizeSlug(raw: string): SlugResult {
  const slug = raw.trim().toLowerCase();
  if (slug.length < 1 || slug.length > MAX_SLUG_LENGTH) {
    return {
      ok: false,
      reason: `Use between 1 and ${MAX_SLUG_LENGTH} characters.`,
    };
  }
  for (let index = 0; index < slug.length; index += 1) {
    const c = slug[index]!;
    const alphanumeric = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (alphanumeric) continue;
    if (c === "-") {
      if (index === 0 || index === slug.length - 1) {
        return {
          ok: false,
          reason:
            "A dash cannot start or end the path — it reads as a typo and some email clients trim it out of the link.",
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

/** Mirrors validDestinationHost + ValidateDestinationPath. Returns every problem. */
export function validateDestination(host: string, path: string): string[] {
  const problems: string[] = [];

  const cleanHost = host.trim().toLowerCase();
  const labels = cleanHost.split(".");
  const hostOk =
    cleanHost !== "" &&
    cleanHost.length <= MAX_HOST_LENGTH &&
    labels.length >= 2 &&
    labels.every((label) => label !== "" && label.length <= MAX_LABEL_LENGTH);
  if (!hostOk) {
    problems.push(
      "Enter a full domain such as shop.example.com. A bare hostname has no public meaning.",
    );
  }

  if (path !== path.trim() || path === "" || !path.startsWith("/")) {
    problems.push(
      "The destination path must start with a slash, for example /spring.",
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

/**
 * The sentence every code and direct-navigation surface must carry.
 *
 * Defined once so no screen can quietly leave it off: the whole point of F04
 * is campaign provenance that is honest about what it does not prove.
 */
export function readershipCaveat(): string {
  return (
    "A visit proves only that this address was requested — not that a person " +
    "typed it, arrived, or read the email. Codes and addresses can be forwarded, " +
    "screenshotted, read aloud, crawled, or prefetched. Treat linked outcomes as " +
    "campaign linkage, never proof of human attention or readership."
  );
}

/** The claim boundary that must travel with the audited outcome register. */
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

export interface CampaignDirectAttributionSummary {
  code_allocations: number;
  code_redemptions: number;
  code_linked_outcomes: number;
  no_click_redemptions: number;
  with_click_redemptions: number;
  click_evidence_unavailable: number;
  vanity_visits: number;
  vanity_linked_outcomes: number;
}

export interface CampaignDirectAttributionItem {
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
}

export interface CampaignDirectAttributionPage {
  campaign_id: string;
  summary: CampaignDirectAttributionSummary;
  items: CampaignDirectAttributionItem[];
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

function evidenceRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid campaign attribution ${label}.`);
  }
  return value as Record<string, unknown>;
}

function evidenceString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid campaign attribution ${label}.`);
  }
  return value;
}

function evidenceInteger(
  value: unknown,
  label: string,
  minimum?: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    throw new Error(`Invalid campaign attribution ${label}.`);
  }
  return value as number;
}

function evidenceNullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : evidenceInteger(value, label);
}

function evidenceUUID(value: unknown, label: string): string {
  const uuid = evidenceString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      uuid,
    )
  ) {
    throw new Error(`Invalid campaign attribution ${label}.`);
  }
  return uuid;
}

function evidenceTimestamp(value: unknown, label: string): string {
  const timestamp = evidenceString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error(`Invalid campaign attribution ${label}.`);
  }
  return timestamp;
}

function evidenceExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))
  ) {
    throw new Error(`Invalid campaign attribution ${label} fields.`);
  }
}

export function parseCampaignDirectAttributionPage(
  payload: unknown,
  expectedCampaignId: string,
): CampaignDirectAttributionPage {
  const root = evidenceRecord(payload, "response");
  evidenceExactFields(
    root,
    ["campaign_id", "summary", "items", "page_info"],
    "response",
  );
  const campaignId = evidenceUUID(root.campaign_id, "campaign id");
  if (campaignId !== expectedCampaignId) {
    throw new Error(
      "Campaign attribution evidence did not match the requested campaign.",
    );
  }
  const summaryRaw = evidenceRecord(root.summary, "summary");
  const summaryKeys: Array<keyof CampaignDirectAttributionSummary> = [
    "code_allocations",
    "code_redemptions",
    "code_linked_outcomes",
    "no_click_redemptions",
    "with_click_redemptions",
    "click_evidence_unavailable",
    "vanity_visits",
    "vanity_linked_outcomes",
  ];
  evidenceExactFields(summaryRaw, summaryKeys, "summary");
  const summary = {} as CampaignDirectAttributionSummary;
  for (const key of summaryKeys) {
    summary[key] = evidenceInteger(summaryRaw[key], `summary.${key}`, 0);
  }
  if (
    summary.code_redemptions > summary.code_allocations ||
    summary.code_linked_outcomes > summary.code_allocations ||
    summary.no_click_redemptions +
      summary.with_click_redemptions +
      summary.click_evidence_unavailable !==
      summary.code_redemptions ||
    summary.vanity_linked_outcomes > summary.vanity_visits
  ) {
    throw new Error("Inconsistent campaign attribution summary.");
  }
  const rawItems = root.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100) {
    throw new Error("Invalid campaign attribution items.");
  }
  const items = rawItems.map((value, index): CampaignDirectAttributionItem => {
    const row = evidenceRecord(value, `item ${index + 1}`);
    evidenceExactFields(
      row,
      [
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
      ],
      `item ${index + 1}`,
    );
    const kind = evidenceString(row.kind, "item kind");
    const attributedVia = evidenceString(row.attributed_via, "item provenance");
    const scope = evidenceString(row.attribution_scope, "item scope");
    if (kind !== "code_allocation" && kind !== "vanity_visit") {
      throw new Error("Invalid campaign attribution item kind.");
    }
    if (
      attributedVia !== "code_redemption" &&
      attributedVia !== "campaign_vanity_path"
    ) {
      throw new Error("Invalid campaign attribution provenance.");
    }
    if (scope !== "campaign_assignment" && scope !== "campaign") {
      throw new Error("Invalid campaign attribution scope.");
    }
    if (
      (kind === "code_allocation" &&
        (attributedVia !== "code_redemption" ||
          scope !== "campaign_assignment")) ||
      (kind === "vanity_visit" &&
        (attributedVia !== "campaign_vanity_path" || scope !== "campaign"))
    ) {
      throw new Error("Inconsistent campaign attribution provenance.");
    }
    if (row.readership_proven !== false) {
      throw new Error("Campaign attribution response overstates readership.");
    }
    if (
      row.linked_without_recorded_assignment_click !== null &&
      typeof row.linked_without_recorded_assignment_click !== "boolean"
    ) {
      throw new Error("Invalid campaign attribution click observation.");
    }
    const nullableDate = (raw: unknown, label: string): string | null =>
      raw === null ? null : evidenceTimestamp(raw, label);
    if (
      typeof row.currency !== "string" ||
      !/^(?:|[A-Z]{3})$/u.test(row.currency)
    ) {
      throw new Error("Invalid campaign attribution currency.");
    }
    return {
      kind,
      evidence_id: evidenceUUID(row.evidence_id, "item receipt"),
      occurred_at: evidenceTimestamp(row.occurred_at, "item time"),
      status: evidenceString(row.status, "item status"),
      expires_at: nullableDate(row.expires_at, "item expiry"),
      redeemed_at: nullableDate(row.redeemed_at, "item redemption time"),
      redemption_id:
        row.redemption_id === null
          ? null
          : evidenceInteger(row.redemption_id, "item redemption id", 1),
      conversion_id:
        row.conversion_id === null
          ? null
          : evidenceInteger(row.conversion_id, "item conversion id", 1),
      amount_cents: evidenceNullableInteger(row.amount_cents, "item amount"),
      currency: row.currency,
      attributed_via: attributedVia,
      attribution_scope: scope,
      linked_without_recorded_assignment_click:
        row.linked_without_recorded_assignment_click as boolean | null,
      readership_proven: false,
    };
  });
  const pageRaw = evidenceRecord(root.page_info, "page info");
  evidenceExactFields(
    pageRaw,
    ["limit", "offset", "total", "has_more"],
    "page info",
  );
  const limit = evidenceInteger(pageRaw.limit, "page limit", 1);
  const offset = evidenceInteger(pageRaw.offset, "page offset", 0);
  const total = evidenceInteger(pageRaw.total, "page total", 0);
  if (limit > 100 || offset > 10_000 || typeof pageRaw.has_more !== "boolean") {
    throw new Error("Invalid campaign attribution page bounds.");
  }
  if (
    total !== summary.code_allocations + summary.vanity_visits ||
    items.length > limit ||
    pageRaw.has_more !== offset + items.length < total
  ) {
    throw new Error("Inconsistent campaign attribution pagination.");
  }
  return {
    campaign_id: campaignId,
    summary,
    items,
    page_info: { limit, offset, total, has_more: pageRaw.has_more },
  };
}

export async function listCampaignDirectAttributionEvidence(
  campaignId: string,
  offset = 0,
  limit = 25,
): Promise<CampaignDirectAttributionPage> {
  const payload = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/direct-attribution-evidence?limit=${limit}&offset=${offset}`,
  );
  return parseCampaignDirectAttributionPage(payload, campaignId);
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
): Promise<{ items: VanityPath[] }> {
  return api.get<{ items: VanityPath[] }>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/vanity-paths`,
  );
}

export function createVanityPath(
  campaignId: string,
  input: { slug: string; destinationHost: string; destinationPath: string },
): Promise<VanityPath> {
  return api.post<VanityPath>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/vanity-paths`,
    {
      slug: input.slug,
      destination_host: input.destinationHost,
      destination_path: input.destinationPath,
    },
  );
}
