/**
 * api/subscriberConditionalWrite.ts — the read-then-write a subscriber PATCH needs.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────
 * `PATCH /api/v1/subscribers/{id}` parses If-Match and answers 428
 * `precondition_required` when the header is ABSENT OR A WILDCARD, before any
 * mutation runs (apps/api/internal/subscribers/handlers.go:590-594). The SDK's
 * `subscribers.update` sent no such header. So every mobile subscriber write —
 * replacing tags, and flipping status, which is how the phone UNSUBSCRIBES someone
 * — has been failing with 428 since the requirement landed on 2026-07-20.
 *
 * Nothing caught it. Mobile's tests mock the SDK, so they assert that the hook calls
 * `update()` rather than that the server accepts it; the repo's
 * `audit:optimistic-concurrency` registry does not list subscriber core Update at
 * all, and its own output says it "does not claim the rest are safe, only that these
 * were decided". This resource had not been decided. The registry's sibling entry
 * for `campaign-update` spells out exactly the trap that was then walked into:
 * "Making it required is a BREAKING change: every client that PATCHes without first
 * holding an ETag would start receiving 428."
 *
 * ── WHY THE TOKEN IS FETCHED RATHER THAN CACHED ─────────────────────────────
 * The token is `ConcurrencyToken("subscriber", id, updated_at)`, so it changes on
 * every write. Reusing one from a list payload rendered minutes ago would 412 as
 * often as it succeeded, and a stale-token 412 is indistinguishable to the user from
 * "the server rejected my edit". Reading it immediately before the write keeps the
 * window as small as the network allows, and a genuine 412 then means what it should:
 * somebody else changed this person while you were deciding.
 *
 * The whole pair runs INSIDE the caller's serial queue, so two writes to one
 * subscriber cannot interleave their read and write halves.
 */
import { getClient } from "@/api/client";

/** A 428/412 distinguished from other failures, so the UI can say which happened. */
export class SubscriberPreconditionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "SubscriberPreconditionError";
  }
}

/**
 * PATCH a subscriber with a freshly-read concurrency token.
 *
 * Throws `SubscriberPreconditionError` when the server has no token to give (which
 * would otherwise become an unconditional write and a guaranteed 428) rather than
 * sending the request and letting it fail less legibly.
 */
export async function updateSubscriberConditionally<
  TPatch extends Record<string, unknown>,
>(id: string, patch: TPatch): Promise<unknown> {
  const { client } = getClient();
  const { concurrencyToken } = await client.subscribers.getWithToken(id);
  if (!concurrencyToken) {
    throw new SubscriberPreconditionError(
      428,
      "precondition_required",
      "This deployment did not return a concurrency token for this subscriber, so the change can't be saved safely.",
    );
  }
  return client.subscribers.update(id, patch, { ifMatch: concurrencyToken });
}
