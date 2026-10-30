// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/reviews-helpers.ts — pure moderation-queue and installation helpers.
 *
 * Ported from apps/desktop/src/lib/reviews-helpers.ts so both clients agree on
 * the queue vocabulary ("approved" is shown as Published because it is a
 * storefront publication state), the queue ordering (oldest pending first,
 * newest first everywhere else) and the copy-safety gate for installation
 * snippets. Kept free of React so it can be unit-tested under node.
 */
import type { Review } from "@/lib/reviews-api";

/** Hard server-side list limit (`Repo.ListReviews ... LIMIT 200`). */
export const REVIEW_LIST_CAP = 200;
/** Safety and usability ceiling for a public-reply body, shared with desktop. */
export const REVIEW_REPLY_MAX_CHARS = 4_000;
/** Defensive ceiling for executable or embeddable text returned by the API. */
export const REVIEW_EMBED_MAX_CHARS = 32_768;

export type ReviewSortDirection = "queue" | "newest" | "oldest";

export const EMBED_FLAVORS = ["iframe", "script"] as const;
export type EmbedFlavor = (typeof EMBED_FLAVORS)[number];

export type StatusBadgeVariant =
  | "success"
  | "warning"
  | "destructive"
  | "secondary";

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

export function statusBadgeVariant(
  status: string | null | undefined,
): StatusBadgeVariant {
  switch ((status ?? "").trim()) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
    case "spam":
      return "destructive";
    default:
      return "secondary";
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
      return value ? evidenceLabel(value) : "—";
  }
}

/** "not_supplied" → "Not Supplied"; null → "Not supplied". */
export function evidenceLabel(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not supplied";
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Search intentionally excludes contact and correlation fields (reviewer
 * name, customer/order/request ids and source refs), matching desktop.
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
  direction: ReviewSortDirection = "queue",
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

/** Whitespace-normalised excerpt that never splits a surrogate pair. */
export function excerpt(body: string | null | undefined, max = 280): string {
  const value = (body ?? "").replace(/\s+/gu, " ").trim();
  if (!value || max <= 0) return "";
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}

/** Locale date-time for a service-reported timestamp, or "" when unparseable. */
export function formatDateTime(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(millis));
}

const MAX_PUBLIC_URL_CHARS = 4_096;

/** Return a URL only when the public destination is safe to hand to a browser. */
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

export type ParsedReviewEmbedSnippet =
  | { ok: true; snippet: string }
  | { ok: false; reason: "empty" | "invalid" | "too-large" };

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

export function invalidSnippetMessage(
  reason: "empty" | "invalid" | "too-large",
): string {
  switch (reason) {
    case "empty":
      return "The service returned no installation code for this method.";
    case "too-large":
      return "The installation code exceeded Moosewave's 32 KiB safety limit.";
    case "invalid":
    default:
      return "Moosewave could not verify the installation code returned for this method.";
  }
}

export interface EmbedMarkupInspection {
  valid: boolean;
  iframeHasTitle: boolean | null;
  iframeTargetsHtml: boolean | null;
}

/**
 * Lexical inspection only. Installation code is never fed to DOMParser or a
 * temporary element: even a detached parsed document can initiate subresource
 * loads, and this admin surface must stay network-silent and inert.
 */
export function inspectEmbedMarkup(
  flavor: EmbedFlavor,
  snippet: string,
  reportedEndpoint: string,
): EmbedMarkupInspection {
  const iframeOpenings = snippet.match(/<iframe\b/giu) ?? [];
  const scriptOpenings = snippet.match(/<script\b/giu) ?? [];
  if (flavor === "iframe") {
    const iframeTag = snippet.match(/<iframe\b[^>]*>/iu)?.[0] ?? "";
    const title = iframeTag.match(
      /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const src = iframeTag.match(
      /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const rawSrc = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").trim();
    let iframeTargetsHtml = false;
    try {
      const destination = new URL(rawSrc);
      const endpoint = new URL(reportedEndpoint);
      const expectedPath = `${endpoint.pathname.replace(/\/+$/u, "")}/html`;
      iframeTargetsHtml =
        (destination.protocol === "https:" ||
          destination.protocol === "http:") &&
        !destination.username &&
        !destination.password &&
        destination.origin === endpoint.origin &&
        destination.pathname === expectedPath &&
        !destination.search &&
        !destination.hash;
    } catch {
      iframeTargetsHtml = false;
    }
    return {
      valid:
        iframeOpenings.length === 1 &&
        scriptOpenings.length === 0 &&
        /<\/iframe\s*>/iu.test(snippet),
      iframeHasTitle:
        iframeOpenings.length === 1 &&
        Boolean((title?.[1] ?? title?.[2] ?? title?.[3] ?? "").trim()),
      iframeTargetsHtml,
    };
  }
  return {
    valid:
      scriptOpenings.length === 1 &&
      iframeOpenings.length === 0 &&
      /<\/script\s*>/iu.test(snippet),
    iframeHasTitle: null,
    iframeTargetsHtml: null,
  };
}

/**
 * The sentence explaining why copy is withheld, or null when copy is allowed.
 *
 * Copy is available only for an iframe that names its content and targets the
 * rendered /html view; script delivery has no certified cross-origin contract
 * yet, so it is inspectable but never copied. Same gate as desktop.
 */
export function embedCopyBlocker(
  flavor: EmbedFlavor,
  inspection: EmbedMarkupInspection,
): string | null {
  if (flavor === "script") {
    return "This code executes remote JavaScript and then requests widget JSON from the customer's origin context. The service has no certified cross-origin delivery contract for that request, so copy stays unavailable.";
  }
  const titleBlocked = inspection.iframeHasTitle === false;
  const targetBlocked = inspection.iframeTargetsHtml === false;
  if (titleBlocked && targetBlocked) {
    return "The iframe needs a non-empty title and must target the rendered /html view. Current code clears neither requirement.";
  }
  if (titleBlocked) {
    return "The iframe has no non-empty title. Copy stays unavailable until the generated code names the embedded review content.";
  }
  if (targetBlocked) {
    return "The iframe does not target the rendered /html view. Copy stays unavailable because the reported destination is not a human-facing widget.";
  }
  return null;
}

export function inactiveWidgetReason(status: string): string {
  switch (status) {
    case "draft":
      return "This widget is a draft. Installation review stays hidden until it is active.";
    case "paused":
      return "This widget is paused. Installation review stays hidden until it is active again.";
    case "archived":
      return "This widget is archived. Installation review is no longer available here.";
    default:
      return "Moosewave cannot verify this widget's lifecycle state, so installation review is hidden.";
  }
}
