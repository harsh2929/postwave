/**
 * api/authOAuth.ts — the ONE network call the mobile Google flow makes before
 * it hands the user to a browser.
 *
 * WHY A PRE-FLIGHT AT ALL. `MountOAuthRoutes`
 * (apps/api/internal/server/identity_api.go:37-45) registers the /start route
 * only when the deployment wires an OAuth graph, and `Start`
 * (apps/api/internal/auth/oauth_handlers.go:172-186) answers 404
 * `provider_disabled` when Google specifically is not configured. Self-hosted
 * Moosewave installs are the normal case for both. Without this check the user
 * taps "Continue with Google", an OS browser opens, and the thing it renders is
 * a raw JSON error object — which is not a product, it is a leak of our wire
 * format. With it, the tap fails in-app with a sentence.
 *
 * WHY NOT `redirect: "manual"` (which is what desktop uses, api-client.ts).
 * React Native's fetch is the whatwg-fetch polyfill over XMLHttpRequest and
 * XHR always follows redirects; the option is silently ignored. So a CONFIGURED
 * provider resolves at the identity provider's host instead of ours. That is
 * exactly the signal we use: a 404 is only believed when the response is still
 * on the API origin. A 404 from the IdP (a wrong client_id, say) must not be
 * reported to the user as "Google is not enabled on this server".
 *
 * The consequence — one extra request to the IdP per tap — is deliberate and
 * bounded: it happens only after the user has explicitly chosen Google, never
 * on screen mount, so opening this screen tells Google nothing.
 */

/** A short ceiling: this runs between a tap and a browser opening. */
const OAUTH_PROBE_TIMEOUT_MS = 12_000;

export type OAuthStartProbe =
  | { ok: true }
  | {
      ok: false;
      reason: "provider_disabled" | "network" | "timeout" | "server";
    };

/**
 * Probes the /start URL the caller is about to open. Never throws — every
 * failure is a typed reason the caller turns into copy.
 */
export async function probeOAuthStart(
  startUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OAuthStartProbe> {
  const timeoutMs = options.timeoutMs ?? OAUTH_PROBE_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, reason: "network" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(startUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "text/html,application/json" },
    });
    return classifyOAuthStartResponse(startUrl, response.status, response.url);
  } catch {
    // The only reason we abort is the timer above, so an aborted signal is a
    // timeout and anything else is a transport failure. Distinguishing them
    // matters: one says "try again", the other says "check your connection".
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure verdict, exported so the branch that decides whether to tell a user
 * "Google is not enabled here" is unit-testable without a network stack.
 *
 * `responseUrl` is the URL the response actually came from. React Native
 * populates it after the redirect chain; an empty string (some hosts omit it)
 * is treated as same-origin, which is the conservative reading — it can only
 * cause us to report a disabled provider that really is disabled.
 */
export function classifyOAuthStartResponse(
  startUrl: string,
  status: number,
  responseUrl: string | null | undefined,
): OAuthStartProbe {
  const followedOffOrigin = isOffOrigin(startUrl, responseUrl);
  if (followedOffOrigin) return { ok: true };
  if (status === 404) return { ok: false, reason: "provider_disabled" };
  if (status >= 500) return { ok: false, reason: "server" };
  return { ok: true };
}

function isOffOrigin(
  startUrl: string,
  responseUrl: string | null | undefined,
): boolean {
  if (!responseUrl) return false;
  try {
    return new URL(responseUrl).origin !== new URL(startUrl).origin;
  } catch {
    return false;
  }
}

