/**
 * api/sseAuthPolicy.ts — when an SSE open failure stops being worth retrying.
 *
 * Import-free so it is node-testable; api/sseConnect is the I/O around it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `connectSse` used to treat every `!res.ok` identically: warn, back off,
 * retry, forever. That is right for a 502 and wrong for an authorization
 * refusal, and the difference is not cosmetic — EVERY attempt re-runs
 * `buildRequest`, which is a POST /api/v1/streams/token. So a stream aimed at
 * a route the caller's role does not have becomes a permanent background loop
 * minting a fresh credential and eating a 403 every ≤30s (the backoff cap) for
 * as long as the screen is mounted. `GET /api/v1/audit/stream` is exactly that
 * route for a non-owner/non-admin reader; see api/auditStream.
 *
 * ── WHY 403 AND 401 ARE NOT THE SAME CONDITION ─────────────────────────────
 * The reviewer's finding said "a 403/401 is not retryable". Half of that is
 * right, and taking it literally would have caused a worse regression than the
 * bug, so the two are separated here:
 *
 *   403 IS TERMINAL. The server authenticated the credential and refused the
 *   SCOPE. `RequireAllScopes` → `writeInsufficientScopeDenial` →
 *   `entitlement.ReasonPolicy` → 403 (apps/api/internal/apikeys). A retry
 *   presents a freshly minted token carrying the SAME scopes, so the outcome
 *   is decided; only a server-side role change fixes it, and that arrives with
 *   a new session.
 *
 *   401 IS OFTEN TRANSIENT, and killing the stream on the first one would be a
 *   real regression. `mintStreamToken` returns null on ANY failure — a timeout,
 *   a 5xx, a flaky radio — and the caller then connects with no token at all,
 *   which a `credentialed` route answers 401. That is the live-send tail's
 *   normal recovery path, and the event bus has a documented 401 of its own
 *   from a token that expired mid-race. So 401 keeps its retry, but a BOUNDED
 *   one: a credential that has been refused this many times in a row is not
 *   coming back on its own, and the caller always has a poll underneath.
 *
 * In both terminal cases the honest report is `closed`, not `unsupported`:
 * this runtime can stream perfectly well, it is this principal that may not.
 *
 * ── THE ONE 403 THAT IS NOT FOREVER, AND WHY IT IS STILL FINE ──────────────
 * `interceptMfaRequiredResponse` fires on 403 and reports an `mfa_required`
 * body, so a step-up challenge can also produce one. That stream then stays
 * closed after the step-up succeeds, rather than reconnecting on its own. It
 * is accepted rather than special-cased, for two reasons: the poll beside
 * every SSE surface keeps the screen correct throughout, and each stream is
 * held by `createFocusGatedStream`, so the next return to the foreground —
 * which is what completing a challenge involves — re-opens it. Reading the
 * body here to tell the two 403s apart would mean consuming a response the
 * MFA interceptor has already cloned once, to buy back a reconnect the focus
 * gate hands over anyway.
 */

/**
 * Consecutive 401s tolerated before a stream gives up.
 *
 * Five, with the 1s→30s equal-jitter backoff, is roughly half a minute of
 * genuine trying — comfortably longer than a mint timeout (5s) or a token
 * expiry race, and far short of "forever".
 */
export const SSE_UNAUTHORIZED_RETRY_BUDGET = 5;

export type SseFailureAction = "retry" | "stop";

/** True for the statuses that mean "the server refused this principal". */
export function isAuthRefusalStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * What to do after an open returned a non-2xx.
 *
 * `unauthorizedAttempts` counts CONSECUTIVE 401s including this one; anything
 * else — a success, or a failure with another status — resets it, because the
 * budget is about a credential being refused over and over, not about a flaky
 * network that happened to include a 401 once.
 */
export function sseOpenFailureAction(input: {
  status: number;
  unauthorizedAttempts: number;
  budget?: number;
}): SseFailureAction {
  const budget = input.budget ?? SSE_UNAUTHORIZED_RETRY_BUDGET;
  if (input.status === 403) return "stop";
  if (input.status === 401) {
    return input.unauthorizedAttempts >= budget ? "stop" : "retry";
  }
  return "retry";
}
