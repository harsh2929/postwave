/**
 * api/reviews.ts — transport for the review-moderation queue.
 *
 * Every route below was read off the chi mount at
 * `apps/api/internal/reviews/reviews.go::MountRoutes` (mounted from
 * `internal/server/customer_lifecycle_integrations.go:195`), not from the
 * OpenAPI document alone:
 *
 *   GET  /api/v1/reviews?status=&product_id=   read:reports  → {items:[Review]}
 *   GET  /api/v1/reviews/{id}                  read:reports  → Review (+replies)
 *   POST /api/v1/reviews/{id}/approve          admin         → Review
 *   POST /api/v1/reviews/{id}/reject           admin         → Review
 *   POST /api/v1/reviews/{id}/reply            admin         → PublicReply (201)
 *   PATCH /api/v1/reviews/{id}                 admin         → Review
 *
 * THE PATCH IS A FULL-COLUMN REPLACE, NOT A MERGE. `Repo.UpdateReview` writes
 * every column from the decoded body (repo.go:131-163), so a sparse
 * `{featured: true}` body would zero the rating, blank the text and reset the
 * status of the row it meant to decorate. `setReviewFeatured` below therefore
 * ROUND-TRIPS: it re-reads the raw record and sends it back verbatim with
 * only `featured` changed — the same defence the referral programme save uses
 * against its own full-replace contract. Pure moderation stays on the
 * approve/reject shortcuts, which take no body at all.
 *
 * SCOPE SPLIT MATTERS. Reading is `read:reports`; every moderation verb is
 * `apikeys.ScopeAdmin`. A non-admin can therefore load this screen in full and
 * be told "no" only at the round trip, which is why the screen gates the
 * actions on role rather than discovering the boundary through a 403.
 *
 * The list is capped server-side at 200 rows with no cursor
 * (`Repo.ListReviews` … `LIMIT 200`), so there is deliberately no pagination
 * here to imply otherwise — `LIST_CAP` exists so the screen can say when it is
 * showing a truncated queue.
 *
 * Parsing lives in lib/reviewQueue so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseReview,
  parseReviewList,
  parseReviewReply,
  type MobileReview,
  type MobileReviewReply,
  type ReviewQueueFilter,
} from "@/lib/reviewQueue";

import { checkedApiResult, rawRequest } from "./request";

/** `Repo.ListReviews` hard-codes `LIMIT 200`. */
export const REVIEW_LIST_CAP = 200;

export function reviewListPath(filter: ReviewQueueFilter): string {
  return `/api/v1/reviews?status=${encodeURIComponent(filter)}`;
}

export function reviewPath(id: string): string {
  return `/api/v1/reviews/${encodeURIComponent(id)}`;
}

export async function fetchReviews(
  filter: ReviewQueueFilter,
): Promise<MobileReview[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", reviewListPath(filter)),
  );
  return parseReviewList(res.data);
}

export async function fetchReview(id: string): Promise<MobileReview | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", reviewPath(id)),
  );
  return parseReview(res.data);
}

/**
 * Approve = publish. The handler stamps `published_at` and recomputes the
 * product aggregate, so this is the call that puts a stranger's words on the
 * storefront.
 */
export async function moderateReview(
  id: string,
  decision: "approve" | "reject",
): Promise<MobileReview | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", `${reviewPath(id)}/${decision}`),
  );
  return parseReview(res.data);
}

/**
 * Toggle the merchandising flag. ADMIN; online-only at the caller.
 *
 * Read-modify-write against the raw wire record — see the module header for
 * why a sparse PATCH would destroy the row. The window between the GET and
 * the PATCH is the ordinary lost-update window every full-replace client of
 * this route has; for a boolean toggle on a surface with no other mobile
 * writer it is accepted, not solved.
 */
export async function setReviewFeatured(
  id: string,
  featured: boolean,
): Promise<MobileReview | null> {
  const raw = await checkedApiResult(
    rawRequest<Record<string, unknown>>("GET", reviewPath(id)),
  );
  const record =
    raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data
      : null;
  if (!record) {
    throw new Error("Couldn't read the review before updating it.");
  }
  const res = await checkedApiResult(
    rawRequest<unknown>("PATCH", reviewPath(id), { ...record, featured }),
  );
  return parseReview(res.data);
}

/**
 * A reply is PUBLIC the moment it is accepted: `normalizeReply` defaults its
 * status to "published". `author` is left to the server default ("Store
 * owner") because mobile has no per-user display name on this surface, and
 * guessing one would attribute a public statement to the wrong person.
 */
export async function replyToReview(
  id: string,
  body: string,
): Promise<MobileReviewReply | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", `${reviewPath(id)}/reply`, {
      body: body.trim(),
    }),
  );
  return parseReviewReply(res.data);
}
