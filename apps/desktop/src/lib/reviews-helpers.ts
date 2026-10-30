import type {
  Review,
  ReviewPublicReply,
  ReviewsCatalog,
  ReviewWidget,
} from "./api/reviews";

/** Hard server-side list limit (`Repo.ListReviews ... LIMIT 200`). */
export const REVIEW_LIST_CAP = 200;
/** Desktop safety and usability ceiling for a public-reply body. */
export const REVIEW_REPLY_MAX_CHARS = 4_000;
/** Defensive ceiling for executable or embeddable text returned by the API. */
export const REVIEW_EMBED_MAX_CHARS = 32_768;

const MAX_REPLY_ROWS = REVIEW_LIST_CAP;
const MAX_WIDGET_ROWS = 1_000;
const MAX_CATALOG_VALUES = 100;
const MAX_ID_CHARS = 256;
const MAX_ENUM_CHARS = 128;
const MAX_NAME_CHARS = 256;
const MAX_TITLE_CHARS = 1_024;
const MAX_BODY_CHARS = 32_768;
const MAX_REASON_CHARS = 4_096;
const MAX_TIMESTAMP_CHARS = 128;
const MAX_PUBLIC_URL_CHARS = 4_096;
const MAX_PUBLIC_CONTRACT_CHARS = 2_048;

type UnknownRecord = Record<string, unknown>;

export interface ParsedReviewList {
  items: Review[];
  invalidCount: number;
  envelopeValid: boolean;
}

export interface ParsedReviewDetail {
  review: Review | null;
  invalidCount: number;
}

export interface ParsedWidgetList {
  items: ReviewWidget[];
  invalidCount: number;
  envelopeValid: boolean;
}

export interface ParsedReviewsCatalog {
  catalog: ReviewsCatalog | null;
  invalidCount: number;
}

export type ParsedReviewEmbedSnippet =
  | { ok: true; snippet: string }
  | { ok: false; reason: "empty" | "invalid" | "too-large" };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || Array.from(text).length > maxChars) return null;
  return text;
}

function optionalText(
  value: unknown,
  maxChars: number,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return Array.from(text).length <= maxChars ? text : null;
}

function optionalNullableText(
  value: unknown,
  maxChars: number,
): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = optionalText(value, maxChars);
  return text === null ? false : text;
}

function optionalRecord(value: unknown): UnknownRecord | undefined | null {
  if (value === undefined || value === null) return undefined;
  return isRecord(value) ? value : null;
}

function assignOptionalText(
  target: UnknownRecord,
  source: UnknownRecord,
  key: string,
  maxChars: number,
): boolean {
  const value = optionalText(source[key], maxChars);
  if (value === null) return false;
  if (value !== undefined) target[key] = value;
  return true;
}

function assignOptionalNullableText(
  target: UnknownRecord,
  source: UnknownRecord,
  key: string,
): boolean {
  const value = optionalNullableText(source[key], MAX_TIMESTAMP_CHARS);
  if (value === false) return false;
  if (value !== undefined) target[key] = value;
  return true;
}

function assignOptionalRecord(
  target: UnknownRecord,
  source: UnknownRecord,
  key: string,
): boolean {
  const value = optionalRecord(source[key]);
  if (value === null) return false;
  if (value !== undefined) target[key] = value;
  return true;
}

function parsePublicReply(value: unknown): ReviewPublicReply | null {
  if (!isRecord(value)) return null;
  const body = requiredText(value["body"], REVIEW_REPLY_MAX_CHARS);
  const status = requiredText(value["status"], MAX_ENUM_CHARS);
  if (!body || !status) return null;

  const reply: UnknownRecord = { body, status };
  if (
    !assignOptionalText(reply, value, "id", MAX_ID_CHARS) ||
    !assignOptionalText(reply, value, "tenant_id", MAX_ID_CHARS) ||
    !assignOptionalText(reply, value, "review_id", MAX_ID_CHARS) ||
    !assignOptionalText(reply, value, "author", MAX_NAME_CHARS) ||
    !assignOptionalText(reply, value, "created_at", MAX_TIMESTAMP_CHARS) ||
    !assignOptionalText(reply, value, "updated_at", MAX_TIMESTAMP_CHARS) ||
    !assignOptionalRecord(reply, value, "metadata")
  ) {
    return null;
  }
  return reply as unknown as ReviewPublicReply;
}

function parseReview(value: unknown): Review | null {
  if (!isRecord(value)) return null;
  const id = requiredText(value["id"], MAX_ID_CHARS);
  const status = requiredText(value["status"], MAX_ENUM_CHARS);
  const rating = value["rating"];
  if (
    !id ||
    !status ||
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5 ||
    typeof value["verified_buyer"] !== "boolean" ||
    typeof value["incentivized"] !== "boolean" ||
    typeof value["featured"] !== "boolean"
  ) {
    return null;
  }

  const review: UnknownRecord = {
    id,
    status,
    rating,
    verified_buyer: value["verified_buyer"],
    incentivized: value["incentivized"],
    featured: value["featured"],
  };
  const boundedFields: ReadonlyArray<readonly [string, number]> = [
    ["tenant_id", MAX_ID_CHARS],
    ["product_id", MAX_ID_CHARS],
    ["variant_id", MAX_ID_CHARS],
    ["request_id", MAX_ID_CHARS],
    ["order_id", MAX_ID_CHARS],
    ["customer_id", MAX_ID_CHARS],
    ["source_platform", MAX_NAME_CHARS],
    ["source_ref", MAX_ID_CHARS],
    ["review_type", MAX_ENUM_CHARS],
    ["reviewer_name", MAX_NAME_CHARS],
    ["reviewer_email", 320],
    ["title", MAX_TITLE_CHARS],
    ["body", MAX_BODY_CHARS],
    ["moderation_reason", MAX_REASON_CHARS],
    ["submitted_at", MAX_TIMESTAMP_CHARS],
    ["created_at", MAX_TIMESTAMP_CHARS],
    ["updated_at", MAX_TIMESTAMP_CHARS],
  ];
  if (
    boundedFields.some(
      ([key, maxChars]) => !assignOptionalText(review, value, key, maxChars),
    ) ||
    !assignOptionalNullableText(review, value, "published_at") ||
    !assignOptionalNullableText(review, value, "moderated_at") ||
    !assignOptionalRecord(review, value, "metadata") ||
    !assignOptionalRecord(review, value, "raw_payload")
  ) {
    return null;
  }

  if (value["public_replies"] !== undefined) {
    if (!Array.isArray(value["public_replies"])) return null;
    if (value["public_replies"].length > MAX_REPLY_ROWS) return null;
    const replies = value["public_replies"].map(parsePublicReply);
    if (replies.some((reply) => reply === null)) return null;
    review["public_replies"] = replies as ReviewPublicReply[];
  }
  return review as unknown as Review;
}

function parseWidget(value: unknown): ReviewWidget | null {
  if (!isRecord(value)) return null;
  const id = requiredText(value["id"], MAX_ID_CHARS);
  const name = requiredText(value["name"], MAX_NAME_CHARS);
  const status = requiredText(value["status"], MAX_ENUM_CHARS);
  const widgetType = requiredText(value["widget_type"], MAX_ENUM_CHARS);
  if (!id || !name || !status || !widgetType) return null;

  const widget: UnknownRecord = {
    id,
    name,
    status,
    widget_type: widgetType,
  };
  const boundedFields: ReadonlyArray<readonly [string, number]> = [
    ["tenant_id", MAX_ID_CHARS],
    ["slug", MAX_ID_CHARS],
    ["language", 64],
    ["public_url", MAX_PUBLIC_URL_CHARS],
    ["created_at", MAX_TIMESTAMP_CHARS],
    ["updated_at", MAX_TIMESTAMP_CHARS],
  ];
  const objectFields = [
    "product_filter",
    "display_settings",
    "moderation_settings",
    "styling",
    "metadata",
  ] as const;
  if (
    boundedFields.some(
      ([key, maxChars]) => !assignOptionalText(widget, value, key, maxChars),
    ) ||
    objectFields.some((key) => !assignOptionalRecord(widget, value, key))
  ) {
    return null;
  }
  return widget as unknown as ReviewWidget;
}

function parseCollection<T>(
  value: unknown,
  parser: (row: unknown) => T | null,
  maxRows: number,
): { items: T[]; invalidCount: number; envelopeValid: boolean } {
  if (!isRecord(value) || !Array.isArray(value["items"])) {
    return { items: [], invalidCount: 1, envelopeValid: false };
  }
  const source = value["items"];
  if (source.length > maxRows) {
    return { items: [], invalidCount: source.length, envelopeValid: false };
  }
  const items: T[] = [];
  let invalidCount = 0;
  for (const row of source) {
    const parsed = parser(row);
    if (parsed === null) invalidCount += 1;
    else items.push(parsed);
  }
  return { items, invalidCount, envelopeValid: true };
}

function parseCatalogValues(
  value: unknown,
): { values: string[]; invalidCount: number } | null {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_VALUES) return null;
  const values: string[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  for (const entry of value) {
    const parsed = requiredText(entry, MAX_ENUM_CHARS);
    if (!parsed || seen.has(parsed)) {
      invalidCount += 1;
      continue;
    }
    seen.add(parsed);
    values.push(parsed);
  }
  return { values, invalidCount };
}

/** Strictly parse the current `{items:[Review]}` server envelope. */
export function parseReviewList(value: unknown): ParsedReviewList {
  return parseCollection(value, parseReview, REVIEW_LIST_CAP);
}

/** Strictly parse a single-review response, including all-or-nothing replies. */
export function parseReviewDetail(value: unknown): ParsedReviewDetail {
  const review = parseReview(value);
  return { review, invalidCount: review ? 0 : 1 };
}

/** Strictly parse the current `{items:[Widget]}` server envelope. */
export function parseWidgetList(value: unknown): ParsedWidgetList {
  return parseCollection(value, parseWidget, MAX_WIDGET_ROWS);
}

/** Parse catalog enums without rejecting unknown-but-well-formed enum truth. */
export function parseReviewsCatalog(value: unknown): ParsedReviewsCatalog {
  if (!isRecord(value)) return { catalog: null, invalidCount: 1 };
  const statuses = parseCatalogValues(value["statuses"]);
  const widgetTypes = parseCatalogValues(value["widget_types"]);
  if (
    !statuses ||
    !widgetTypes ||
    !statuses.values.length ||
    !widgetTypes.values.length
  ) {
    return { catalog: null, invalidCount: 1 };
  }

  let invalidCount = statuses.invalidCount + widgetTypes.invalidCount;
  const catalog: ReviewsCatalog = {
    statuses: statuses.values,
    widget_types: widgetTypes.values,
  };
  for (const [key, maxChars] of [
    ["schema_version", MAX_ENUM_CHARS],
    ["public_contract", MAX_PUBLIC_CONTRACT_CHARS],
  ] as const) {
    const text = optionalText(value[key], maxChars);
    if (text === null) return { catalog: null, invalidCount: invalidCount + 1 };
    if (text !== undefined) catalog[key] = text;
  }
  for (const key of [
    "review_types",
    "request_channels",
    "authenticity",
  ] as const) {
    if (value[key] === undefined) continue;
    const parsed = parseCatalogValues(value[key]);
    if (!parsed) return { catalog: null, invalidCount: invalidCount + 1 };
    catalog[key] = parsed.values;
    invalidCount += parsed.invalidCount;
  }
  return { catalog, invalidCount };
}

/** Approved is a storefront publication state, so the UI calls it Published. */
export function statusLabel(status: string | null | undefined): string {
  const value = (status ?? "").trim();
  switch (value) {
    case "pending":
      return "Pending";
    case "approved":
      return "Published";
    case "rejected":
      return "Rejected";
    case "spam":
      return "Spam";
    case "archived":
      return "Archived";
    default:
      return value || "—";
  }
}

export type BadgeTone = "success" | "warning" | "danger" | "neutral";

export function statusBadgeTone(status: string | null | undefined): BadgeTone {
  switch ((status ?? "").trim()) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
    case "spam":
      return "danger";
    default:
      return "neutral";
  }
}

export function statusBadgeClass(status: string | null | undefined): string {
  const tone = statusBadgeTone(status);
  return tone === "neutral" ? "badge" : `badge ${tone}`;
}

export function widgetStatusLabel(status: string | null | undefined): string {
  const value = (status ?? "").trim();
  switch (value) {
    case "draft":
      return "Draft";
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "archived":
      return "Archived";
    default:
      return value || "—";
  }
}

export function widgetStatusBadgeTone(
  status: string | null | undefined,
): BadgeTone {
  switch ((status ?? "").trim()) {
    case "active":
      return "success";
    case "draft":
    case "paused":
      return "warning";
    default:
      return "neutral";
  }
}

export function isReviewDecidable(review: Pick<Review, "status">): boolean {
  return review.status.trim() === "pending";
}

export function widgetTypeLabel(type: string | null | undefined): string {
  const value = (type ?? "").trim();
  switch (value) {
    case "star_rating":
      return "Star rating";
    case "summary":
      return "Summary";
    case "product_reviews":
      return "Product reviews";
    case "featured_carousel":
      return "Featured carousel";
    case "all_reviews":
      return "All reviews";
    case "qna":
      return "Q&A";
    default:
      return value
        ? value
            .replace(/_/g, " ")
            .replace(/\b\w/g, (character) => character.toUpperCase())
        : "—";
  }
}

/**
 * Search intentionally excludes contact and correlation fields (email,
 * reviewer name, customer/order/request IDs and source refs).
 */
export function reviewMatchesQuery(review: Review, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    review.title,
    review.body,
    review.product_id,
    review.source_platform,
    review.review_type,
    review.status,
  ].some((value) => value?.toLocaleLowerCase().includes(query) === true);
}

function timestampMillis(review: Review): number | null {
  for (const value of [
    review.submitted_at,
    review.created_at,
    review.updated_at,
  ]) {
    if (!value) continue;
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  return null;
}

/**
 * Return a stable copy. Queue ordering is oldest-first only for pending work;
 * audit/history views are newest-first unless the operator explicitly chooses.
 */
export function sortReviewsForQueue(
  items: readonly Review[],
  status?: string,
  direction: "queue" | "newest" | "oldest" = "queue",
): Review[] {
  const resolvedDirection =
    direction === "queue"
      ? (status ?? "").trim() === "pending"
        ? "oldest"
        : "newest"
      : direction;
  return items
    .map((review, index) => ({ review, index, time: timestampMillis(review) }))
    .sort((left, right) => {
      if (left.time === null && right.time !== null) return 1;
      if (left.time !== null && right.time === null) return -1;
      if (
        left.time !== null &&
        right.time !== null &&
        left.time !== right.time
      ) {
        return resolvedDirection === "oldest"
          ? left.time - right.time
          : right.time - left.time;
      }
      return left.index - right.index;
    })
    .map(({ review }) => review);
}

/** Return a URL only when the public destination is safe to hand to the shell. */
export function safePublicWidgetUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || Array.from(value).length > MAX_PUBLIC_URL_CHARS) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** Validate text received from the embed endpoint before displaying/copying it. */
export function parseReviewEmbedSnippet(
  raw: unknown,
): ParsedReviewEmbedSnippet {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  if (raw.length > REVIEW_EMBED_MAX_CHARS) {
    return { ok: false, reason: "too-large" };
  }
  if (!raw.trim()) return { ok: false, reason: "empty" };
  return { ok: true, snippet: raw };
}

export function clampRating(rating: number | null | undefined): number {
  const number =
    typeof rating === "number" && Number.isFinite(rating) ? rating : 0;
  return Math.min(5, Math.max(0, Math.round(number)));
}

export function starString(rating: number | null | undefined): string {
  const filled = clampRating(rating);
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

/** Whitespace-normalised excerpt that never splits a grapheme or surrogate. */
export function excerpt(body: string | null | undefined, max = 280): string {
  const value = (body ?? "").replace(/\s+/gu, " ").trim();
  if (!value || max <= 0) return "";
  const segments = graphemes(value);
  if (segments.length <= max) return value;
  return `${segments.slice(0, max).join("").trimEnd()}…`;
}

export function ratingDistribution(
  counts: Record<string, number> | null | undefined,
): Array<{ star: number; count: number }> {
  const map = counts && typeof counts === "object" ? counts : {};
  const output: Array<{ star: number; count: number }> = [];
  for (let star = 5; star >= 1; star -= 1) {
    const value = map[String(star)];
    output.push({
      star,
      count:
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : 0,
    });
  }
  return output;
}
