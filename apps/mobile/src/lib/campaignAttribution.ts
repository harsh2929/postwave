/**
 * campaignAttribution — the audited campaign-linkage register behind F04, and
 * the wire rules that decide whether a page of it may be shown at all.
 *
 * Split out of `lib/vanityPaths.ts` (which keeps the short addresses
 * themselves) so each half stays readable; the whole surface is re-exported
 * from there, so `@/lib/vanityPaths` remains the import site callers use.
 *
 * The honesty rule this file enforces is the same one the caveat states: a
 * malformed or arithmetically inconsistent register is REJECTED, never shown
 * with the bad field zeroed. Import-free of react-native, so it is node-tested.
 */
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

export interface CampaignDirectAttributionPage {
  campaignId: string;
  summary: {
    codeAllocations: number;
    codeRedemptions: number;
    codeLinkedOutcomes: number;
    noClickRedemptions: number;
    withClickRedemptions: number;
    clickEvidenceUnavailable: number;
    vanityVisits: number;
    vanityLinkedOutcomes: number;
  };
  items: {
    kind: "code_allocation" | "vanity_visit";
    evidenceId: string;
    occurredAt: string;
    status: string;
    expiresAt: string | null;
    redeemedAt: string | null;
    redemptionId: number | null;
    conversionId: number | null;
    amountCents: number | null;
    currency: string;
    attributedVia: "code_redemption" | "campaign_vanity_path";
    attributionScope: "campaign_assignment" | "campaign";
    linkedWithoutRecordedAssignmentClick: boolean | null;
    readershipProven: false;
  }[];
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | undefined;
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

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInt(value: unknown, minimum?: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (minimum === undefined || value >= minimum)
    ? value
    : null;
}

function isUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function hasExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  );
}

const SUMMARY_FIELDS = [
  "code_allocations",
  "code_redemptions",
  "code_linked_outcomes",
  "no_click_redemptions",
  "with_click_redemptions",
  "click_evidence_unavailable",
  "vanity_visits",
  "vanity_linked_outcomes",
] as const;

const EVIDENCE_ROW_FIELDS = [
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
] as const;

/**
 * The counters, and the arithmetic they have to satisfy before any of them is
 * shown. A redemption breakdown that does not add up to the redemption count
 * is a register that would misreport how much click evidence was retained,
 * which is the one thing this panel exists to be honest about.
 */
function parseAttributionSummary(
  summary: Record<string, unknown>,
): CampaignDirectAttributionPage["summary"] | null {
  if (!hasExactFields(summary, SUMMARY_FIELDS)) return null;
  const readCount = (key: string): number | null => safeInt(summary[key], 0);
  const codeAllocations = readCount("code_allocations");
  const codeRedemptions = readCount("code_redemptions");
  const codeLinkedOutcomes = readCount("code_linked_outcomes");
  const noClickRedemptions = readCount("no_click_redemptions");
  const withClickRedemptions = readCount("with_click_redemptions");
  const clickEvidenceUnavailable = readCount("click_evidence_unavailable");
  const vanityVisits = readCount("vanity_visits");
  const vanityLinkedOutcomes = readCount("vanity_linked_outcomes");
  if (
    codeAllocations === null ||
    codeRedemptions === null ||
    codeLinkedOutcomes === null ||
    noClickRedemptions === null ||
    withClickRedemptions === null ||
    clickEvidenceUnavailable === null ||
    vanityVisits === null ||
    vanityLinkedOutcomes === null
  ) {
    return null;
  }
  if (
    codeRedemptions > codeAllocations ||
    codeLinkedOutcomes > codeAllocations ||
    noClickRedemptions + withClickRedemptions + clickEvidenceUnavailable !==
      codeRedemptions ||
    vanityLinkedOutcomes > vanityVisits
  ) {
    return null;
  }
  return {
    codeAllocations,
    codeRedemptions,
    codeLinkedOutcomes,
    noClickRedemptions,
    withClickRedemptions,
    clickEvidenceUnavailable,
    vanityVisits,
    vanityLinkedOutcomes,
  };
}

/**
 * A row's identity fields, once `isAttributionEvidenceRow` has vouched for
 * them. Everything else stays `unknown`: nullable and numeric fields are each
 * checked at the point they are read.
 */
type AttributionEvidenceRow = {
  kind: "code_allocation" | "vanity_visit";
  evidence_id: string;
  occurred_at: string;
  status: string;
  currency: string;
  attributed_via: "code_redemption" | "campaign_vanity_path";
  attribution_scope: "campaign_assignment" | "campaign";
  expires_at: unknown;
  redeemed_at: unknown;
  redemption_id: unknown;
  conversion_id: unknown;
  amount_cents: unknown;
  linked_without_recorded_assignment_click: unknown;
  readership_proven: unknown;
};

/** Exactly the expected keys, and the identity fields they must carry. */
function hasAttributionRowShape(row: Record<string, unknown>): boolean {
  return (
    hasExactFields(row, EVIDENCE_ROW_FIELDS) &&
    (row.kind === "code_allocation" || row.kind === "vanity_visit") &&
    isUUID(row.evidence_id) &&
    isTimestamp(row.occurred_at) &&
    typeof row.status === "string" &&
    row.status.trim() !== "" &&
    typeof row.currency === "string" &&
    /^(?:|[A-Z]{3})$/u.test(row.currency)
  );
}

/**
 * How the row claims to be attributed, and that the claim matches its kind: a
 * code allocation is only ever a code redemption scoped to one assignment, a
 * vanity visit is only ever campaign-scoped. `readership_proven` must be the
 * literal `false` the server sends — the register never claims readership.
 */
function hasAttributionRowLinkage(row: Record<string, unknown>): boolean {
  return (
    (row.expires_at === null || isTimestamp(row.expires_at)) &&
    (row.redeemed_at === null || isTimestamp(row.redeemed_at)) &&
    (row.attributed_via === "code_redemption" ||
      row.attributed_via === "campaign_vanity_path") &&
    (row.attribution_scope === "campaign_assignment" ||
      row.attribution_scope === "campaign") &&
    (row.kind !== "code_allocation" ||
      (row.attributed_via === "code_redemption" &&
        row.attribution_scope === "campaign_assignment")) &&
    (row.kind !== "vanity_visit" ||
      (row.attributed_via === "campaign_vanity_path" &&
        row.attribution_scope === "campaign")) &&
    row.readership_proven === false &&
    (row.linked_without_recorded_assignment_click === null ||
      typeof row.linked_without_recorded_assignment_click === "boolean")
  );
}

function isAttributionEvidenceRow(
  row: Record<string, unknown>,
): row is AttributionEvidenceRow {
  return hasAttributionRowShape(row) && hasAttributionRowLinkage(row);
}

/** One malformed row rejects the page; a partial register is a wrong one. */
function parseAttributionItem(
  raw: unknown,
): CampaignDirectAttributionPage["items"][number] | null {
  const row = obj(raw);
  if (!row || !isAttributionEvidenceRow(row)) return null;
  const redemptionId =
    row.redemption_id === null ? null : safeInt(row.redemption_id, 1);
  const conversionId =
    row.conversion_id === null ? null : safeInt(row.conversion_id, 1);
  const amountCents =
    row.amount_cents === null ? null : safeInt(row.amount_cents);
  if (
    (row.redemption_id !== null && redemptionId === null) ||
    (row.conversion_id !== null && conversionId === null) ||
    (row.amount_cents !== null && amountCents === null)
  ) {
    return null;
  }
  return {
    kind: row.kind,
    evidenceId: row.evidence_id,
    occurredAt: row.occurred_at,
    status: row.status,
    expiresAt: row.expires_at as string | null,
    redeemedAt: row.redeemed_at as string | null,
    redemptionId,
    conversionId,
    amountCents,
    currency: row.currency,
    attributedVia: row.attributed_via,
    attributionScope: row.attribution_scope,
    linkedWithoutRecordedAssignmentClick:
      row.linked_without_recorded_assignment_click as boolean | null,
    readershipProven: false,
  };
}

interface AttributionPageInfo {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

function parseAttributionPageInfo(
  page: Record<string, unknown>,
): AttributionPageInfo | null {
  const limit = safeInt(page.limit, 1);
  const offset = safeInt(page.offset, 0);
  const total = safeInt(page.total, 0);
  if (
    limit === null ||
    limit > 100 ||
    offset === null ||
    offset > 10_000 ||
    total === null ||
    typeof page.has_more !== "boolean" ||
    !hasExactFields(page, ["limit", "offset", "total", "has_more"])
  ) {
    return null;
  }
  return { limit, offset, total, hasMore: page.has_more };
}

export function parseCampaignDirectAttributionPage(
  payload: unknown,
  expectedCampaignId: string,
): CampaignDirectAttributionPage | null {
  const root = obj(payload);
  const rawSummary = obj(root?.summary);
  const rawPage = obj(root?.page_info);
  const rawItems = root?.items;
  if (
    !root ||
    !rawSummary ||
    !rawPage ||
    !hasExactFields(root, ["campaign_id", "summary", "items", "page_info"]) ||
    !isUUID(root.campaign_id) ||
    root.campaign_id !== expectedCampaignId ||
    !Array.isArray(rawItems) ||
    rawItems.length > 100
  ) {
    return null;
  }

  const summary = parseAttributionSummary(rawSummary);
  if (summary === null) return null;

  const items: CampaignDirectAttributionPage["items"] = [];
  for (const raw of rawItems) {
    const item = parseAttributionItem(raw);
    if (item === null) return null;
    items.push(item);
  }

  const page = parseAttributionPageInfo(rawPage);
  if (page === null) return null;
  if (
    page.total !== summary.codeAllocations + summary.vanityVisits ||
    items.length > page.limit ||
    page.hasMore !== page.offset + items.length < page.total
  ) {
    return null;
  }

  return {
    campaignId: root.campaign_id,
    summary,
    items,
    limit: page.limit,
    offset: page.offset,
    total: page.total,
    nextOffset: page.hasMore ? page.offset + page.limit : undefined,
  };
}
