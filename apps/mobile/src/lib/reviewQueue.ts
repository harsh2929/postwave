/**
 * lib/reviewQueue.ts — every decision the review-moderation queue makes,
 * expressed without a single React Native import so it can be unit-tested in
 * the node vitest environment (the pattern documented in lib/paletteItems.ts).
 *
 * The wire shapes here are read off the Go source, not guessed:
 * `apps/api/internal/reviews/reviews.go` declares `Review` and `PublicReply`,
 * and `repo.go` decides what actually comes back. Three of those decisions
 * shape this module and are easy to get wrong:
 *
 *  1. THE LIST DOES NOT CARRY REPLIES. `Repo.ListReviews` runs `reviewSelect()`
 *     alone; only `Repo.GetReview` also runs `listRepliesTx` and populates
 *     `public_replies`. So a row can never honestly say "already replied" —
 *     that fact only exists after the detail read. `hasLoadedReplies` makes the
 *     difference explicit instead of letting `[]` masquerade as "none".
 *  2. A REPLY IS PUBLISHED, NOT DRAFTED. `normalizeReply` defaults
 *     `status` to "published" (repo.go:701), so posting one puts it on the
 *     storefront widget immediately. The composer copy has to say that.
 *  3. APPROVE IS A PUBLISH. `Repo.ModerateReview` stamps `published_at` on the
 *     approve branch and recomputes the product aggregate, so approving is the
 *     act that makes a stranger's words appear on the store.
 *
 * Ordering is a product decision, not a server one: the API returns
 * `submitted_at DESC` for every filter. Newest-first is right for auditing what
 * was already decided, and wrong for a queue — it starves the oldest complaint,
 * which is the one whose author has been waiting longest. `orderForQueue`
 * flips pending to oldest-first for exactly that reason.
 */

/** Statuses the server's own catalog endpoint enumerates (reviews.go:231). */
export const REVIEW_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "spam",
  "archived",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The triage filters worth a segment on a phone. */
export const REVIEW_QUEUE_FILTERS = [
  "pending",
  "approved",
  "rejected",
] as const;

export type ReviewQueueFilter = (typeof REVIEW_QUEUE_FILTERS)[number];

export interface MobileReviewReply {
  id: string;
  author: string;
  body: string;
  status: string;
  createdAt: string | null;
}

export interface MobileReview {
  id: string;
  productId: string;
  reviewerName: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus | string;
  verifiedBuyer: boolean;
  incentivized: boolean;
  featured: boolean;
  sourcePlatform: string;
  moderationReason: string;
  submittedAt: string | null;
  publishedAt: string | null;
  /**
   * Replies are only ever populated by the single-review read. `null` means
   * "not loaded", which is a different claim from `[]` ("loaded, none").
   */
  replies: readonly MobileReviewReply[] | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

/** ISO timestamp or null. The Go zero time serialises as "0001-01-01T…". */
function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** Ratings are `int` server-side and unvalidated on ingest; clamp to 0–5. */
export function clampRating(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(0, Math.round(n)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseReviewReply(value: unknown): MobileReviewReply | null {
  const row = record(value);
  const id = str(row["id"]);
  const body = str(row["body"]);
  if (!id || !body) return null;
  return {
    id,
    // repo.go defaults an empty author to "Store owner" on write, but a row
    // written before that default existed can still be blank.
    author: str(row["author"]) || "Store owner",
    body,
    status: str(row["status"]) || "published",
    createdAt: timestamp(row["created_at"]),
  };
}

export function parseReview(value: unknown): MobileReview | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const rawReplies = row["public_replies"];
  const replies = Array.isArray(rawReplies)
    ? rawReplies
        .map(parseReviewReply)
        .filter((reply): reply is MobileReviewReply => reply !== null)
    : null;
  return {
    id,
    productId: str(row["product_id"]),
    reviewerName: str(row["reviewer_name"]),
    rating: clampRating(row["rating"]),
    title: str(row["title"]),
    body: str(row["body"]),
    status: str(row["status"]) || "pending",
    verifiedBuyer: bool(row["verified_buyer"]),
    incentivized: bool(row["incentivized"]),
    featured: bool(row["featured"]),
    sourcePlatform: str(row["source_platform"]),
    moderationReason: str(row["moderation_reason"]),
    submittedAt: timestamp(row["submitted_at"]),
    publishedAt: timestamp(row["published_at"]),
    replies,
  };
}

/**
 * `GET /api/v1/reviews` answers `{"items": [...]}`. Accepting a bare array too
 * costs one line and means an envelope change cannot silently empty the queue —
 * the failure mode this repo has hit repeatedly on mobile (see the SDK/envelope
 * drift class in docs/logic-audit-2026-07/mobile.md).
 */
export function parseReviewList(payload: unknown): MobileReview[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["items"])
      ? (record(payload)["items"] as unknown[])
      : [];
  return source
    .map(parseReview)
    .filter((review): review is MobileReview => review !== null);
}

export interface ReviewStatusPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

export function reviewStatusPresentation(
  status: string,
): ReviewStatusPresentation {
  switch (status.trim().toLowerCase()) {
    case "approved":
      return { label: "Published", tone: "success" };
    case "rejected":
      return { label: "Rejected", tone: "danger" };
    case "spam":
      return { label: "Spam", tone: "danger" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    case "pending":
      return { label: "Awaiting review", tone: "warning" };
    default:
      // An unrecognised status must never read as approved. Show it verbatim
      // so an operator can report what they saw.
      return { label: status.trim() || "Unknown", tone: "neutral" };
  }
}

/**
 * Stars for the eye. Screen readers get `ratingLabel` instead — a row of five
 * identical glyphs is unreadable aloud.
 */
export function ratingStars(rating: number): string {
  const filled = clampRating(rating);
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

export function ratingLabel(rating: number): string {
  const filled = clampRating(rating);
  return filled === 1 ? "1 star out of 5" : `${filled} stars out of 5`;
}

/** "Anonymous" is the honest label for a review with no reviewer name. */
export function reviewerLabel(review: MobileReview): string {
  return review.reviewerName || "Anonymous";
}

/**
 * A one-line preview. Prefers the title, falls back to the body, and collapses
 * newlines so a multi-paragraph review cannot blow the row's height out.
 */
export function reviewPreview(review: MobileReview, max = 120): string {
  const source = review.title || review.body;
  const flat = source.replace(/\s+/gu, " ").trim();
  if (!flat) return "No written review";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function reviewQueueCounts(
  rows: readonly MobileReview[],
): Record<ReviewQueueFilter, number> {
  const counts: Record<ReviewQueueFilter, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  for (const row of rows) {
    const status = row.status.trim().toLowerCase();
    if (status === "pending") counts.pending += 1;
    else if (status === "approved") counts.approved += 1;
    else if (status === "rejected") counts.rejected += 1;
  }
  return counts;
}

/**
 * Queue order. Pending is a work queue → oldest first, so the person who has
 * been waiting longest is served first. Everything else is a record of what
 * already happened → newest first, matching the server's own ordering.
 * Rows with no parsable `submitted_at` sort last rather than to the epoch,
 * which would otherwise put junk data at the head of the work queue.
 */
export function orderForQueue(
  rows: readonly MobileReview[],
  filter: ReviewQueueFilter,
): MobileReview[] {
  const oldestFirst = filter === "pending";
  return [...rows].sort((a, b) => {
    const at = a.submittedAt ? Date.parse(a.submittedAt) : Number.NaN;
    const bt = b.submittedAt ? Date.parse(b.submittedAt) : Number.NaN;
    const aMissing = Number.isNaN(at);
    const bMissing = Number.isNaN(bt);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return oldestFirst ? at - bt : bt - at;
  });
}

/** Only a pending review has a decision left to make. */
export function isDecidable(review: MobileReview): boolean {
  return review.status.trim().toLowerCase() === "pending";
}

export interface ReplyDraftState {
  canSend: boolean;
  /** Why not, when `canSend` is false — rendered next to the disabled button. */
  reason: string | null;
  characters: number;
}

/**
 * The server rejects an empty body with `reply_invalid` (reviews.go:449) and
 * caps the request at `DefaultJSONMaxBodyBytes`. Failing here rather than at
 * the round trip keeps the operator from losing a long reply to a 400.
 */
export const REPLY_MAX_CHARACTERS = 4000;

export function replyDraftState(
  draft: string,
  options: { sending: boolean; online: boolean },
): ReplyDraftState {
  const characters = draft.length;
  const trimmed = draft.trim();
  if (!options.online) {
    return {
      canSend: false,
      reason:
        "You're offline. A public reply is not queued — it would post later with no context.",
      characters,
    };
  }
  if (options.sending) {
    return { canSend: false, reason: null, characters };
  }
  if (!trimmed) {
    return { canSend: false, reason: null, characters };
  }
  if (characters > REPLY_MAX_CHARACTERS) {
    return {
      canSend: false,
      reason: `Replies are capped at ${REPLY_MAX_CHARACTERS} characters.`,
      characters,
    };
  }
  return { canSend: true, reason: null, characters };
}

export interface ReviewModerationCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

/**
 * Confirmation copy. Both verbs get a real confirm rather than an undo toast,
 * for the same reason approvals.tsx does: approving PUBLISHES a stranger's
 * words to the storefront, and neither verb can restore the "pending" state —
 * the API exposes approve and reject and nothing that puts a row back in the
 * queue, so an "Undo" would be a lie about what it does.
 */
export function moderationCopy(
  decision: "approve" | "reject",
  review: MobileReview,
): ReviewModerationCopy {
  const who = reviewerLabel(review);
  if (decision === "approve") {
    return {
      title: `Publish ${who}'s review?`,
      message:
        "Approving publishes it to every storefront widget that matches this product and updates the product's average rating.",
      consequence: "It becomes publicly visible immediately.",
      confirmLabel: "Publish",
      destructive: false,
    };
  }
  return {
    title: `Reject ${who}'s review?`,
    message:
      "Rejecting keeps it off every public widget. It cannot be returned to the queue from this app — only approved or left rejected.",
    consequence: "The reviewer is not notified.",
    confirmLabel: "Reject",
    destructive: true,
  };
}

/** Post-decision toast copy, so the screen never invents its own wording. */
export function moderationSuccessMessage(
  decision: "approve" | "reject",
  review: MobileReview,
): string {
  return decision === "approve"
    ? `Published ${reviewerLabel(review)}'s review.`
    : `Rejected ${reviewerLabel(review)}'s review.`;
}
