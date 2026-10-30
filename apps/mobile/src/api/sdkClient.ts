import { HTTP_PRIVATE_NETWORK_ALLOWED } from "@/lib/config";
import { CONTEXT_EPOCH_HEADER, observeContextEpoch } from "../lib/contextEpoch";
import { PostwaveClient } from "@postwave/sdk";
import { EVENTS } from "@postwave/telemetry";

import { useAuthStore } from "@/store/auth";
import { track } from "@/lib/telemetry";
import {
  createExpiredSessionHandler,
  errorCodeFromBody,
  isExpiredSessionResponse,
} from "@/lib/sessionExpiry";
import { parseStepUpChallenge, requestStepUpProof } from "@/lib/stepUp";
import {
  parseUpgradeRequired,
  reportUpgradeRequired,
} from "@/lib/upgradeRequired";
import { interceptMfaRequiredResponse } from "./auth";

import { NATIVE_CLIENT_HEADERS } from "./nativeClient";

export type PostwaveContext = {
  client: PostwaveClient;
  baseUrl: string;
  tenantId: string;
};

let cached: { key: string; ctx: PostwaveContext } | null = null;

type MobileFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Wraps the SDK transport so a policy change discovered by any resource
 * closes the Zustand gate before the typed SDK error reaches its caller.
 * The original response is never consumed; only a bounded clone is inspected.
 */
export function createMfaAwareFetch(
  fetchImpl: MobileFetch,
  authBaseUrl?: string,
): MobileFetch {
  return async (input, init) => {
    const send = async (attemptInit: RequestInit | undefined) => {
      const startedAt = Date.now();
      let sent: Response;
      try {
        sent = await fetchImpl(input, attemptInit);
      } catch (error) {
        track(EVENTS.MOBILE_API_AVAILABILITY, {
          outcome: "failure",
          error_code: "network",
          method: normalizedMethod(attemptInit?.method),
          duration_ms: boundedDuration(startedAt),
        });
        throw error;
      }
      track(EVENTS.MOBILE_API_AVAILABILITY, {
        outcome: sent.status >= 500 ? "failure" : "success",
        ...(sent.status >= 500 ? { error_code: "server" } : {}),
        method: normalizedMethod(attemptInit?.method),
        status_code: sent.status,
        duration_ms: boundedDuration(startedAt),
      });
      // Record the context this response was computed under. On the wrapper
      // every SDK request funnels through, so no endpoint can be the one that
      // misses a change. Anonymous responses carry no header and are ignored
      // by design.
      observeContextEpoch(sent.headers.get(CONTEXT_EPOCH_HEADER));
      return sent;
    };

    const requestInit = sendingSettingsPutInit(input, init, authBaseUrl);
    const automaticStepUpReplayAllowed = requestInit === init;
    let response = await send(requestInit);

    // Step-up re-authentication (apps/api/internal/stepup).
    //
    // Resolved BEFORE interceptExpiredSession, which is the sign-out path:
    // `isExpiredSessionResponse` reads a 401 with no readable error code as a
    // dead session, and a challenge whose body a proxy stripped is exactly that
    // shape. The session is alive and asking a question — the server's own
    // comment calls it "the difference between showing a dialog and logging
    // somebody out".
    let challenge = await readStepUpChallenge(response);
    if (
      challenge &&
      (await requestStepUpProof(challenge)) &&
      automaticStepUpReplayAllowed
    ) {
      // Exactly one retry. `init` is re-sent as-is, so the method, the
      // serialised body and the SDK's Idempotency-Key all go back out
      // unchanged — the retry is the SAME write, not a second one.
      response = await send(stepUpRetryInit(requestInit));
      // Re-read, but never prompt again: a proof that does not move the
      // server's freshness clock (a clock skew, a session rotated mid-prompt)
      // would otherwise loop, and an endless authenticator-code prompt is
      // indistinguishable from an attack on the person using it.
      challenge = await readStepUpChallenge(response);
    }
    // Any 401 that is NOT a challenge — including one that arrives on the
    // retry, e.g. the session really did die while the sheet was open — still
    // takes the expired-session path.
    if (!challenge) await interceptExpiredSession(response);
    await interceptUpgradeRequired(response);
    return interceptMfaRequiredResponse(
      response,
      authBaseUrl ?? new URL(input).origin,
    );
  };
}

/**
 * The sending-settings replacement has no replay receipt and explicitly
 * forbids Idempotency-Key. Keep that route to one wire attempt even when a
 * step-up proof succeeds, and strip a caller/default header defensively at the
 * last transport boundary. Its caller reconciles the original challenge with
 * canonical GETs instead of guessing whether a repeated PUT is safe.
 */
function sendingSettingsPutInit(
  input: string,
  init: RequestInit | undefined,
  authBaseUrl: string | undefined,
): RequestInit | undefined {
  if (normalizedMethod(init?.method) !== "PUT") return init;
  let requestUrl: URL;
  let expectedPath = "/api/v1/settings/sending";
  try {
    const configuredBase = authBaseUrl ? new URL(authBaseUrl) : null;
    requestUrl = new URL(input, configuredBase ?? "https://postwave.invalid");
    if (configuredBase) {
      if (requestUrl.origin !== configuredBase.origin) return init;
      const basePath = configuredBase.pathname.replace(/\/+$/u, "");
      expectedPath = `${basePath}/api/v1/settings/sending`;
    }
  } catch {
    return init;
  }
  if (requestUrl.pathname !== expectedPath) return init;
  const headers = new Headers(init?.headers);
  headers.delete("Idempotency-Key");
  return { ...init, headers, redirect: "error" };
}

/**
 * The retry's own time budget.
 *
 * The SDK gives every attempt an AbortController that fires after its
 * `timeoutMs` (30s by default, and mobile does not override it), and that timer
 * starts before this wrapper is called. Waiting for a human to open an
 * authenticator app and type a rotating code routinely outlives it — so
 * re-sending with the SAME `init` would hand the retry an already-aborted
 * signal and turn a completed proof into a spurious timeout. The elapsed time
 * was human-input time, not network time, so the retry gets a fresh budget of
 * the same size.
 *
 * The trade is deliberate and bounded: a caller abort raised DURING the prompt
 * is not observed by the retry, because the SDK collapses the caller's signal
 * and its own timeout into one controller this wrapper cannot take apart. One
 * request outliving one cancel is a smaller failure than every step-up retry
 * timing out.
 */
const STEP_UP_RETRY_TIMEOUT_MS = 30_000;

function stepUpRetryInit(init: RequestInit | undefined): RequestInit {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_UP_RETRY_TIMEOUT_MS);
  // Node keeps the process alive for a pending timer; RN does not care either
  // way. `unref` is not available in Hermes, hence the guard.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { ...init, signal: controller.signal };
}

/**
 * Read a step-up challenge off a response without consuming it.
 *
 * A bounded clone, exactly like the MFA and upgrade interceptors either side of
 * it — the SDK still has to read the real body. Only 401s are inspected: the
 * server puts the marker nowhere else.
 */
async function readStepUpChallenge(
  response: Response,
): Promise<ReturnType<typeof parseStepUpChallenge>> {
  if (response.status !== 401) return null;
  let parsed: unknown;
  try {
    const declared = Number(response.headers.get("content-length") || 0);
    const text =
      Number.isFinite(declared) && declared > MAX_401_BODY_BYTES
        ? ""
        : await response.clone().text();
    parsed =
      text && text.length <= MAX_401_BODY_BYTES
        ? (JSON.parse(text) as unknown)
        : undefined;
  } catch {
    // An unreadable or non-JSON body leaves header-only detection, which is the
    // right degradation: a challenge is still a challenge without its reason,
    // and a non-challenge 401 still parses to null and reaches the sign-out
    // path unchanged.
    parsed = undefined;
  }
  return parseStepUpChallenge(response.status, response.headers, parsed);
}

/**
 * The API-KEY transport.
 *
 * `createMfaAwareFetch` is session-only by design: its 401 branch drives
 * `revalidateSession`, and its 403 branch drives the MFA gate — both
 * meaningless (and the first actively wrong) for a bearer key. But the
 * VERSION floor applies to every client the gateway sees, and an API-key build
 * below it used to render a raw SDK error string on every screen with no way
 * out, exactly like the session build did before NATIVE#3. This wrapper gives
 * that mode the 426 branch and the availability telemetry, and nothing else.
 */
export function createUpgradeAwareFetch(fetchImpl: MobileFetch): MobileFetch {
  return async (input, init) => {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      track(EVENTS.MOBILE_API_AVAILABILITY, {
        outcome: "failure",
        error_code: "network",
        method: normalizedMethod(init?.method),
        duration_ms: boundedDuration(startedAt),
      });
      throw error;
    }
    track(EVENTS.MOBILE_API_AVAILABILITY, {
      outcome: response.status >= 500 ? "failure" : "success",
      ...(response.status >= 500 ? { error_code: "server" } : {}),
      method: normalizedMethod(init?.method),
      status_code: response.status,
      duration_ms: boundedDuration(startedAt),
    });
    await interceptUpgradeRequired(response);
    return response;
  };
}

/**
 * Below-version-floor interceptor (NATIVE#3).
 *
 * The app already declares X-Postwave-Client / X-Postwave-Version, so the
 * gateway can and does reject stale builds with 426 + an `upgrade_required`
 * problem document. Nothing consumed it: every screen simply rendered the raw
 * SDK error string with no explanation and no way out. Recording the
 * requirement lets the root layout render a blocking upgrade screen instead.
 *
 * Bounded clone only — the original response is never consumed — and a 426
 * that is NOT an upgrade_required document (a proxy, a captive portal) is
 * ignored, so a hostile network cannot lock a user out of their app.
 */
async function interceptUpgradeRequired(response: Response): Promise<void> {
  if (response.status !== 426) return;
  try {
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > MAX_PROBLEM_BODY_BYTES) return;
    const text = await response.clone().text();
    if (text.length > MAX_PROBLEM_BODY_BYTES) return;
    const requirement = parseUpgradeRequired(text);
    if (requirement) reportUpgradeRequired(requirement);
  } catch {
    // An unreadable 426 body is not enough evidence to block the whole app.
  }
}

/**
 * Session-expiry interceptor.
 *
 * This wrapper previously inspected responses ONLY for a 403 `mfa_required`;
 * status 401 fell straight through. The store's 401 recovery runs on hydrate,
 * on an AppState foreground transition and on a NetInfo reconnect — so a user
 * actively scrolling when their cookie expires (the `session_max_minutes`
 * policy, or a revoke from another device) kept `canEnterApp()` true
 * indefinitely and got a raw SDK error on every tab until they backgrounded
 * the app. The correct response to "your session ended" is a sign-in screen.
 *
 * `revalidateSession` already performs the clean logged-out transition on a
 * 401 from /me, and the offline-mutation queue is deliberately untouched here.
 * The handler is single-flight so N concurrent 401s cost one round trip.
 */
const expiredSession = createExpiredSessionHandler(async () => {
  await useAuthStore.getState().revalidateSession();
});

async function interceptExpiredSession(response: Response): Promise<void> {
  if (response.status !== 401) return;
  try {
    const declared = Number(response.headers.get("content-length") || 0);
    // Read a bounded clone the same way interceptMfaRequiredResponse does; the
    // original response is never consumed.
    const text =
      Number.isFinite(declared) && declared > MAX_401_BODY_BYTES
        ? ""
        : await response.clone().text();
    const code =
      text.length <= MAX_401_BODY_BYTES ? errorCodeFromBody(text) : null;
    if (!isExpiredSessionResponse(response.status, code)) return;
  } catch {
    // A body we cannot read is treated as a bare 401, which is already the
    // expired-session case.
  }
  void expiredSession.handle();
}

const MAX_401_BODY_BYTES = 64 * 1024;
const MAX_PROBLEM_BODY_BYTES = 8 * 1024;

function normalizedMethod(method: string | undefined): string {
  const value = (method ?? "GET").trim().toUpperCase();
  return /^[A-Z]{3,10}$/.test(value) ? value : "OTHER";
}

function boundedDuration(startedAt: number): number {
  return Math.min(24 * 60 * 60 * 1000, Math.max(0, Date.now() - startedAt));
}

/**
 * Returns a memoised PostwaveClient bound to the current auth state.
 * Callers should guard with authenticated state first; this throws while
 * logged out or during partial auth hydration.
 */
export function getClient(): PostwaveContext {
  const {
    apiKey,
    baseUrl,
    mode,
    session,
    tenantId: apiTenantId,
  } = useAuthStore.getState();
  const tenantId = apiTenantId ?? session?.tenantId ?? null;
  const tenantSlug =
    session?.workspaceSlug ?? (mode === "api_key" ? apiTenantId : null);
  const authMode = mode ?? (apiKey ? "api_key" : null);
  if (!baseUrl || !tenantId || !authMode) {
    throw new Error(
      "PostwaveClient requested without credentials. Sign in first.",
    );
  }
  const key = `${authMode}::${baseUrl}::${tenantId}::${apiKey ?? "cookie"}`;
  if (cached && cached.key === key) {
    return cached.ctx;
  }
  const client = new PostwaveClient({
    ...(apiKey ? { apiKey } : {}),
    authMode,
    ...(tenantSlug ? { tenantSlug } : {}),
    baseUrl,
    // Mirrors lib/config's HTTP policy so the two cannot drift: a non-production
    // build may reach a PRIVATE-NETWORK dev API over http, because a physical
    // device cannot satisfy the loopback rule (its `localhost` is the phone).
    // Production stays https-only — the constant is false there.
    ...(HTTP_PRIVATE_NETWORK_ALLOWED
      ? { allowInsecurePrivateNetwork: true as const }
      : {}),
    ...(authMode === "session" ? { credentials: "include" as const } : {}),
    defaultHeaders: NATIVE_CLIENT_HEADERS,
    fetch:
      authMode === "session"
        ? createMfaAwareFetch(
            (input, init) => globalThis.fetch(input, init),
            baseUrl,
          )
        : createUpgradeAwareFetch((input, init) =>
            globalThis.fetch(input, init),
          ),
  });
  const ctx: PostwaveContext = { client, baseUrl, tenantId };
  cached = { key, ctx };
  return ctx;
}

/** Clears the memoised SDK client after auth changes such as logout. */
export function clearClient(): void {
  cached = null;
}
