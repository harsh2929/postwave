// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared, user-facing fallback messaging for auth error states (AUTH-011).
//
// The auth pages special-case the meaningful 4xx statuses inline (401→invalid
// credentials, 409→slug taken, 410→expired link, 429→rate-limited …). This
// helper owns only the *default* branch: a 5xx, a body-less error, or a
// transport failure must NEVER surface the raw `METHOD /path failed: 500 …`
// ApiError string to a user. `err.message` stays available on the thrown
// object for dev logging / Sentry, but is not shown verbatim.
//
// Duck-typed against ApiError's public shape (status/kind) rather than
// importing the class, so it stays pure and node-testable with no browser
// import graph.

interface ApiErrorLike {
  status: number;
  kind?: string;
}

function asApiErrorLike(err: unknown): ApiErrorLike | null {
  if (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return err as ApiErrorLike;
  }
  return null;
}

const NETWORK_KINDS = new Set(["network", "timeout", "offline", "aborted"]);

/** True when the failure is a transport problem rather than an HTTP response. */
export function isNetworkError(err: unknown): boolean {
  const api = asApiErrorLike(err);
  if (!api) return false;
  if (api.status === 0) return true;
  return api.kind !== undefined && NETWORK_KINDS.has(api.kind);
}

export const GENERIC_SERVER_ERROR =
  "Something went wrong on our end. Please try again in a moment.";
export const NETWORK_ERROR =
  "We couldn't reach Moosewave. Check your connection and try again.";

/**
 * The friendly fallback for the default (non-special-cased) error branch.
 * Returns a connection message for transport failures and a generic server
 * message for everything else — never the raw ApiError string.
 */
export function genericAuthErrorMessage(err: unknown): string {
  return isNetworkError(err) ? NETWORK_ERROR : GENERIC_SERVER_ERROR;
}
