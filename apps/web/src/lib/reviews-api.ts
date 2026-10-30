/**
 * lib/reviews-api.ts — review collection, moderation vocabulary, the
 * moderation inbox verbs (list / evidence / publish / reject / reply) and
 * public widgets with their installation snippets.
 *
 * `public_contract` IS A SERVER-AUTHORED SENTENCE ABOUT WHAT LEAVES THE
 * BUILDING: "Public widgets expose approved reviews only and redact reviewer
 * email/raw moderation metadata." It is rendered verbatim rather than
 * paraphrased. A paraphrase of a privacy guarantee drifts from the guarantee
 * the server actually enforces, and the drift is invisible — the UI keeps
 * claiming whatever it was written to claim while the server changes
 * underneath it.
 *
 * The vocabularies (`statuses`, `widget_types`, `authenticity`,
 * `request_channels`) are the server's, not ours. Hard-coding a copy in the
 * client is how a UI ends up silently missing a status the backend has
 * started emitting, so they are read from the catalogue and rendered as
 * given.
 */
import { api } from "@/lib/api";
import {
  REVIEW_WIDGET_AUTHORING_AVAILABLE,
  ReviewWidgetAuthoringUnavailableError,
} from "@/lib/reviews-operational-availability";

export interface ReviewRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function liveOptions(options: ReviewRequestOptions = {}) {
  return {
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

export interface ReviewsCatalog {
  statuses: string[];
  widget_types: string[];
  authenticity: string[];
  request_channels: string[];
  /** Verbatim server statement about public exposure. Do not paraphrase. */
  public_contract: string;
  schema_version: string;
}

export interface ReviewWidget {
  id: string;
  slug: string;
  name: string;
  status: string;
  widget_type: string;
  language: string;
  public_url: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function getReviewsCatalog(): Promise<ReviewsCatalog> {
  const r = await api.get<Partial<ReviewsCatalog>>("/api/v1/reviews/catalog");
  return {
    statuses: asArray<string>(r?.statuses),
    widget_types: asArray<string>(r?.widget_types),
    authenticity: asArray<string>(r?.authenticity),
    request_channels: asArray<string>(r?.request_channels),
    public_contract: str(r?.public_contract),
    schema_version: str(r?.schema_version),
  };
}

function parseReviewWidget(widget: Partial<ReviewWidget> | null | undefined) {
  return {
    id: str(widget?.id),
    slug: str(widget?.slug),
    name: str(widget?.name) || "Untitled widget",
    status: str(widget?.status) || "unknown",
    widget_type: str(widget?.widget_type) || "unknown",
    language: str(widget?.language),
    public_url: str(widget?.public_url),
  };
}

export async function listReviewWidgets(): Promise<ReviewWidget[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/reviews/widgets");
  return asArray<Partial<ReviewWidget>>(r?.items).map(parseReviewWidget);
}

/* ---------- Widget authoring (reviews.CreateWidget) ------------------- */

/** Server allowlists (reviews.go ValidateWidget). Fallbacks only: the page
 *  prefers the catalog's `widget_types` when the server advertises them. */
export const REVIEW_WIDGET_TYPES = [
  "star_rating",
  "summary",
  "product_reviews",
  "featured_carousel",
  "all_reviews",
  "qna",
] as const;
export const REVIEW_WIDGET_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;

export interface ReviewWidgetInput {
  name: string;
  widget_type: string;
  status: string;
  language?: string;
}

/**
 * POST /api/v1/reviews/widgets — a one-shot create (admin). Release-held: the
 * transport refuses before any request while
 * REVIEW_WIDGET_AUTHORING_AVAILABLE is false, so a held verb cannot reach the
 * network from any path, exactly as desktop withholds it.
 */
export async function createReviewWidget(
  input: ReviewWidgetInput,
  options: ReviewRequestOptions = {},
): Promise<ReviewWidget> {
  if (!REVIEW_WIDGET_AUTHORING_AVAILABLE) {
    throw new ReviewWidgetAuthoringUnavailableError();
  }
  const name = input.name.trim();
  if (!name) throw new Error("A widget name is required.");
  const language = input.language?.trim();
  const raw = await api.post<Partial<ReviewWidget>>(
    "/api/v1/reviews/widgets",
    {
      name,
      widget_type: input.widget_type,
      status: input.status,
      ...(language ? { language } : {}),
    },
    liveOptions(options),
  );
  const widget = parseReviewWidget(raw);
  if (!widget.id || widget.name !== name) {
    throw new Error(
      "The service accepted the widget but returned a record that could not be verified.",
    );
  }
  return widget;
}

/* ---------- Moderation inbox (reviews.Review) --------------------------- */

/** A public store reply attached to a review (reviews.PublicReply). */
export interface ReviewPublicReply {
  id?: string;
  review_id?: string;
  author?: string;
  body: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * A product/store review as this moderation surface is allowed to see it.
 *
 * DELIBERATELY NARROWER THAN THE SERVER RECORD. `reviewer_email`,
 * `customer_id`, `order_id`, `request_id`, `source_ref`, `metadata` and
 * `raw_payload` are dropped at the parse boundary below, not merely left
 * un-rendered: a field that never reaches the component tree cannot leak
 * through a future "show everything" refactor, a search index, or a copied
 * evidence block. Desktop hides the same fields (ReviewDetailModal's
 * "Sensitive fields hidden from this view").
 */
export interface Review {
  id: string;
  product_id?: string;
  variant_id?: string;
  source_platform?: string;
  review_type?: string;
  reviewer_name?: string;
  rating: number;
  title?: string;
  body?: string;
  /** pending | approved | rejected | spam | archived (server vocabulary). */
  status: string;
  verified_buyer: boolean;
  incentivized: boolean;
  featured: boolean;
  moderation_reason?: string;
  submitted_at?: string;
  published_at?: string | null;
  moderated_at?: string | null;
  created_at?: string;
  updated_at?: string;
  public_replies?: ReviewPublicReply[];
}

export interface ReviewList {
  items: Review[];
  /** Rows the server sent that lacked a stable id or a status; withheld. */
  invalidCount: number;
}

export interface ReviewWidgetEmbed {
  flavor: string;
  snippet: string;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function nullableStr(v: unknown): string | null | undefined {
  if (v === null) return null;
  return optStr(v);
}

function parsePublicReply(v: unknown): ReviewPublicReply | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const body = optStr(r.body);
  const status = optStr(r.status);
  if (!body || !status) return null;
  return {
    id: optStr(r.id),
    review_id: optStr(r.review_id),
    author: optStr(r.author),
    body,
    status,
    created_at: optStr(r.created_at),
    updated_at: optStr(r.updated_at),
  };
}

/**
 * Whitelist copy of a server review row. Returns null when the row cannot be
 * moderated safely (no stable id or no status) — the caller counts those
 * rather than guessing.
 */
export function parseReview(v: unknown): Review | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = optStr(r.id)?.trim();
  const status = optStr(r.status)?.trim();
  if (!id || !status) return null;
  const rating =
    typeof r.rating === "number" && Number.isFinite(r.rating)
      ? Math.min(5, Math.max(0, Math.round(r.rating)))
      : 0;
  const review: Review = {
    id,
    status,
    rating,
    verified_buyer: r.verified_buyer === true,
    incentivized: r.incentivized === true,
    featured: r.featured === true,
    product_id: optStr(r.product_id),
    variant_id: optStr(r.variant_id),
    source_platform: optStr(r.source_platform),
    review_type: optStr(r.review_type),
    reviewer_name: optStr(r.reviewer_name),
    title: optStr(r.title),
    body: optStr(r.body),
    moderation_reason: optStr(r.moderation_reason),
    submitted_at: optStr(r.submitted_at),
    published_at: nullableStr(r.published_at),
    moderated_at: nullableStr(r.moderated_at),
    created_at: optStr(r.created_at),
    updated_at: optStr(r.updated_at),
  };
  if (Array.isArray(r.public_replies)) {
    review.public_replies = r.public_replies
      .map(parsePublicReply)
      .filter((reply): reply is ReviewPublicReply => reply !== null);
  }
  return review;
}

/** GET /api/v1/reviews?status= → `{items}`; omit `status` for every state. */
export async function listReviews(
  status?: string,
  options: Pick<ReviewRequestOptions, "signal"> = {},
): Promise<ReviewList> {
  const trimmed = status?.trim();
  const r = trimmed
    ? await api.get<{ items?: unknown }>("/api/v1/reviews", {
        query: { status: trimmed },
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      })
    : await api.get<{ items?: unknown }>("/api/v1/reviews", {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      });
  const rows = asArray<unknown>(r?.items);
  const items: Review[] = [];
  let invalidCount = 0;
  for (const row of rows) {
    const parsed = parseReview(row);
    if (parsed) items.push(parsed);
    else invalidCount += 1;
  }
  return { items, invalidCount };
}

function verifiedReview(raw: unknown, expectedId: string): Review {
  const parsed = parseReview(raw);
  if (!parsed || parsed.id !== expectedId) {
    throw new Error(
      "The service returned a review record that could not be verified against the one requested.",
    );
  }
  return parsed;
}

/** GET /api/v1/reviews/{id} — the complete record including public replies. */
export async function getReview(
  id: string,
  options: Pick<ReviewRequestOptions, "signal"> = {},
): Promise<Review> {
  const raw = await api.get<unknown>(
    `/api/v1/reviews/${encodeURIComponent(id)}`,
    {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    },
  );
  return verifiedReview(raw, id);
}

/** POST /api/v1/reviews/{id}/approve — immediate server-side publication (admin). */
export async function approveReview(
  id: string,
  options: ReviewRequestOptions = {},
): Promise<Review> {
  const raw = await api.post<unknown>(
    `/api/v1/reviews/${encodeURIComponent(id)}/approve`,
    {},
    liveOptions(options),
  );
  const review = verifiedReview(raw, id);
  if (review.status !== "approved") {
    throw new Error("The service did not confirm that the review is approved.");
  }
  return review;
}

/** POST /api/v1/reviews/{id}/reject — leaves the pending queue; no restore path (admin). */
export async function rejectReview(
  id: string,
  options: ReviewRequestOptions = {},
): Promise<Review> {
  const raw = await api.post<unknown>(
    `/api/v1/reviews/${encodeURIComponent(id)}/reject`,
    {},
    liveOptions(options),
  );
  const review = verifiedReview(raw, id);
  if (review.status !== "rejected") {
    throw new Error("The service did not confirm that the review is rejected.");
  }
  return review;
}

/** POST /api/v1/reviews/{id}/reply — a public store reply, stored public immediately (admin). */
export async function replyToReview(
  id: string,
  body: string,
  options: ReviewRequestOptions = {},
): Promise<ReviewPublicReply> {
  const raw = await api.post<unknown>(
    `/api/v1/reviews/${encodeURIComponent(id)}/reply`,
    { body },
    liveOptions(options),
  );
  const reply = parsePublicReply(raw);
  if (
    !reply ||
    reply.review_id !== id ||
    reply.body !== body ||
    reply.status !== "published"
  ) {
    throw new Error(
      "The service accepted the reply but returned a record that could not be verified.",
    );
  }
  return reply;
}

/** GET /api/v1/reviews/widgets/{id}/embed/{flavor} → `{flavor, snippet}`. */
export async function getReviewWidgetEmbed(
  widgetId: string,
  flavor: string,
): Promise<ReviewWidgetEmbed> {
  const r = await api.get<Partial<ReviewWidgetEmbed>>(
    `/api/v1/reviews/widgets/${encodeURIComponent(widgetId)}/embed/${encodeURIComponent(flavor)}`,
  );
  return {
    flavor: str(r?.flavor),
    // Left unvalidated here on purpose: the caller applies the size/shape gate
    // (parseReviewEmbedSnippet) so an over-long or wrong-flavor snippet is
    // rendered as a named refusal rather than thrown away as a transport error.
    snippet: typeof r?.snippet === "string" ? r.snippet : "",
  };
}
