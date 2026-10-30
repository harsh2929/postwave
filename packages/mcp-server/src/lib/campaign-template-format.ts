// SPDX-License-Identifier: MIT

/** Fields returned by search/list surfaces; full HTML/MJML stays behind get. */
const SUMMARY_FIELDS = [
  "id",
  "slug",
  "name",
  "description",
  "category",
  "goal",
  "subject",
  "preview_text",
  "tags",
  "style",
  "layout",
  "industry",
  "thumbnail_url",
  "preview_url",
  "template_kind",
  "source_provider",
  "source_external_id",
  "source_url",
  "source_brand",
  "source_captured_at",
  "source_license_status",
  "review_status",
  "quality_score",
  "imported_at",
  "reference_template_ids",
  "capabilities",
  "recommended_action",
  "warnings",
  "preview_assets",
  "is_featured",
  "is_favorited",
  "usage_count",
  "last_used_at",
  "updated_at",
] as const;

export interface CompactCampaignTemplateSearch {
  items: Array<Record<string, unknown>>;
  total: number;
  page?: number;
  per_page?: number;
  has_more?: boolean;
  /** One-based page to request next; omitted on the final page. */
  next_page?: number;
  next_cursor?: string;
  facets?: Record<string, unknown>;
}

/**
 * Normalize both legacy array responses and paginated search envelopes while
 * deliberately dropping body_html/body_mjml. Agents fetch one selected design
 * through campaign_template_get or the item resource instead of loading every
 * template's source into context.
 */
export function compactCampaignTemplateSearch(
  value: unknown,
): CompactCampaignTemplateSearch {
  const envelope = isRecord(value) ? value : undefined;
  const sourceItems = Array.isArray(value)
    ? value
    : firstArray(envelope, ["items", "templates", "results", "data"]);
  const items = sourceItems.filter(isRecord).map(compactCampaignTemplate);
  const total = numberValue(envelope?.total) ?? items.length;
  const page = numberValue(envelope?.page);
  const perPage =
    numberValue(envelope?.per_page) ?? numberValue(envelope?.perPage);
  const explicitHasMore = booleanValue(envelope?.has_more);
  const nextCursor = stringValue(envelope?.next_cursor);
  const hasMore =
    explicitHasMore ??
    (nextCursor !== undefined ? true : undefined) ??
    (page !== undefined && perPage !== undefined
      ? page * perPage < total
      : undefined);
  const cursorPage = positiveIntegerValue(nextCursor);
  const nextPage =
    hasMore === false
      ? undefined
      : (cursorPage ??
        (hasMore === true && page !== undefined ? page + 1 : undefined));
  const facets = isRecord(envelope?.facets) ? envelope.facets : undefined;

  return {
    items,
    total,
    ...(page !== undefined ? { page } : {}),
    ...(perPage !== undefined ? { per_page: perPage } : {}),
    ...(hasMore !== undefined ? { has_more: hasMore } : {}),
    ...(nextPage !== undefined ? { next_page: nextPage } : {}),
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    ...(facets !== undefined ? { facets } : {}),
  };
}

export function compactCampaignTemplate(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SUMMARY_FIELDS) {
    if (value[field] !== undefined) out[field] = value[field];
  }
  if (typeof value.id === "string" && value.id !== "") {
    out.resource_uri = `moosewave://campaign-templates/${encodeURIComponent(value.id)}`;
  }
  return out;
}

function firstArray(
  value: Record<string, unknown> | undefined,
  keys: string[],
): unknown[] {
  if (!value) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function positiveIntegerValue(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
