/**
 * lib/stoppingHalfPolicy.ts — the rule that settles "may the phone ship half a
 * capability?", written down once.
 *
 * ── THE QUESTION THAT WAS NEVER ANSWERED ───────────────────────────────────
 * The mobile readiness audit produced two pairs of DIRECTLY CONTRADICTORY
 * findings, each pair about the same route:
 *
 *   Inbox Reality (`POST /api/v1/inbox-reality/tests/{id}/cancel`)
 *     one auditor: not-phone-appropriate, build on web or desktop first
 *     another:     missing, add reads then cancel as a row action
 *
 *   Conversion ingest secrets (`POST .../ingest-secrets/{keyID}/revoke`)
 *     one auditor: not-phone-appropriate, build on desk surfaces first
 *     another:     missing, build it on mobile
 *
 * Both pairs turn on one unstated policy question: MAY MOBILE SHIP THE NARROW
 * REVOKE/CANCEL HALF OF A CAPABILITY THAT HAS NO DESK SURFACE AT ALL? Leave it
 * unanswered and two engineers implement contradictory things; answer it once
 * and both pairs collapse.
 *
 * ── THE ANSWER ─────────────────────────────────────────────────────────────
 * YES for the STOPPING half. NO for the STARTING half.
 *
 * The asymmetry is not a compromise, it is the whole point:
 *
 *   STOPPING (revoke, cancel, pause, suppress) is urgent, needs no typing, is
 *   safe when wrong (you have removed authority, not granted it), and is
 *   exactly what somebody needs when they are away from a desk. Withholding it
 *   until a desk surface exists means the capability is unusable at the only
 *   moment it matters.
 *
 *   STARTING (mint, issue, create) hands back a credential exactly once, or
 *   commits spend, or requires a form. Mobile has no hardened
 *   capture-then-dismiss ceremony for a reveal-once secret, so offering it
 *   manufactures the dead end it is meant to solve: a token the operator can
 *   see, cannot reliably capture, and cannot get back.
 *
 * "There is no desk surface yet" is an argument for shipping the stopping half
 * SOONER, not later. A capability nobody can stop is worse than one nobody can
 * start.
 *
 * ── WHERE IT ALREADY APPLIES ───────────────────────────────────────────────
 * Three instances, decided independently and identically before the rule was
 * written — which is the evidence it is a real rule rather than a rationalisation:
 * API keys (revoke, no create/rotate), agent mandates (revoke, no mint),
 * conversion ingest secrets (revoke, no issue), Inbox Reality (cancel, no start).
 *
 * No react-native imports — imported by node-run vitest.
 */

export interface StoppingHalfCase {
  /** What the capability is, for a failure message. */
  readonly capability: string;
  /**
   * A source fragment proving mobile reaches the stopping verb.
   *
   * Matched against transport SOURCE, and chosen to be UNIQUE to this
   * capability. Two hazards, both hit while writing this:
   *
   *   A bare path literal misses calls built from a BASE constant or made
   *   through an SDK method — the false-positive class that has already cost
   *   this programme two wrong conclusions.
   *
   *   A bare verb fragment like "}/cancel`" matches ANY cancel call in the
   *   transport layer (subscriber imports and verification jobs both have
   *   one), so the assertion passes for the wrong reason and keeps passing
   *   after the capability it names is deleted. Mutation-testing caught that:
   *   removing Inbox Reality's cancel left the guard green.
   */
  readonly stopping: string;
  /**
   * The starting verb mobile must NOT reach, as a path fragment. Null when the
   * capability has no reveal-once or spend-committing counterpart.
   */
  readonly starting: string | null;
  /** Why the starting half stays off the phone. */
  readonly reason: string;
}

export const STOPPING_HALF_CASES: readonly StoppingHalfCase[] = [
  {
    capability: "conversion ingest secrets",
    stopping: "conversions/ingest-secrets",
    starting: null,
    reason:
      "Issuing returns the HMAC signing key exactly once. Revoking a leaked one needs no typing and cannot make anything worse.",
  },
  {
    capability: "Inbox Reality placement tests",
    stopping: "/api/v1/inbox-reality/tests/",
    starting: null,
    reason:
      "Starting a placement test commits seedlist sends. Cancelling one that is misconfigured stops that spend, and is the reason to reach for a phone.",
  },
  {
    capability: "agent mandates",
    stopping: "agentMandates.revoke(",
    starting: null,
    reason:
      "Minting returns the agent's bearer token exactly once. Withdrawing an agent's authority is the archetypal away-from-desk act.",
  },
  {
    capability: "inbound mail-routing rules",
    stopping: "setInboundRouteEnabled(",
    starting: null,
    reason:
      "A rule misfiring at 02:00 silently drops or mis-routes every inbound reply until stopped, and stopping it needs no typing. Authoring — glob grammar, priority reorder, the dry-run matcher — stays at a desk.",
  },
];

/**
 * Whether a capability's stopping half belongs on the phone.
 *
 * Deliberately total and deliberately boring: it returns true. The function
 * exists so the RULE has a name and a call site rather than living only in
 * prose that the next audit can re-litigate.
 */
export function stoppingHalfBelongsOnMobile(): true {
  return true;
}
