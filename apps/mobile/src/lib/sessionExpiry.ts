/**
 * sessionExpiry — decide, and coalesce, the app-wide reaction to a 401.
 *
 * The SDK transport wrapper (`createMfaAwareFetch`) inspected responses only
 * for a 403 `mfa_required`; status 401 fell straight through. The only 401
 * recovery lived in the auth store's revalidation path, which runs on hydrate,
 * on an AppState foreground transition and on a NetInfo reconnect. A user who
 * is actively scrolling when their cookie expires — the `session_max_minutes`
 * policy, or a revoke from another device — therefore kept `canEnterApp()`
 * true indefinitely and saw a raw SDK error on every tab until they
 * backgrounded the app.
 *
 * This module holds the two pieces that logic needs and that a node test can
 * exercise: the decision, and a single-flight guard so N concurrent 401s
 * trigger exactly one revalidation (mirroring the store's own
 * `mfaRequiredHandling` coalescer).
 */

/**
 * Should a 401 tear down the local session?
 *
 * Deliberately conservative: `mfa_required` is a 403 and is handled elsewhere,
 * and a 401 carrying a *specific* non-session code (a per-resource
 * authorization failure) must not sign the whole app out. An absent code, or
 * one of the known session codes, means the cookie is gone.
 */
export function isExpiredSessionResponse(
  status: number,
  code: string | null | undefined,
): boolean {
  if (status !== 401) return false;
  const value = (code ?? "").trim().toLowerCase();
  if (!value) return true;
  return (
    value === "no_session" ||
    value === "session_expired" ||
    value === "invalid_session" ||
    value === "no_user" ||
    value === "unauthorized"
  );
}

/** Pull the error code out of an already-read JSON error body, safely. */
export function errorCodeFromBody(text: string): string | null {
  if (!text) return null;
  try {
    const payload = JSON.parse(text) as {
      error?: { code?: unknown };
      code?: unknown;
    };
    const code = payload?.error?.code ?? payload?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export interface ExpiredSessionHandler {
  /** Runs `revalidate` at most once per in-flight window. */
  handle(): Promise<void>;
  /** True while a revalidation started here has not settled. */
  readonly inFlight: boolean;
}

/**
 * Single-flight wrapper. Eleven tabs failing at once must produce exactly one
 * `/me` round-trip and exactly one logged-out transition, not eleven.
 */
export function createExpiredSessionHandler(
  revalidate: () => Promise<void>,
): ExpiredSessionHandler {
  let pending: Promise<void> | null = null;
  return {
    get inFlight(): boolean {
      return pending !== null;
    },
    handle(): Promise<void> {
      if (pending) return pending;
      const run = (async () => {
        try {
          await revalidate();
        } catch {
          // A failed revalidation must not reject into the transport layer;
          // the next 401 will simply try again.
        }
      })().finally(() => {
        pending = null;
      });
      pending = run;
      return run;
    },
  };
}
