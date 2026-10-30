/**
 * api/streamCredentials.ts — "how does a phone authenticate an SSE stream".
 *
 * An SSE GET cannot carry an Authorization header on every transport, and some
 * realtime routes are declared `exposure: "credentialed"` in the routeauth
 * manifest — their ONLY accepted auth methods are the stream-token query
 * parameters, not the session cookie the rest of the app uses
 * (`/api/v1/campaigns/{id}/events` is one). So a short-lived token minted at
 * POST /api/v1/streams/token, carried in `?stream_token=`, is the credential
 * that works everywhere: it is accepted by the credentialed routes AND by the
 * session-authenticated ones.
 *
 * Tokens live two minutes (apps/api/internal/apikeys/stream_tokens.go
 * `StreamTokenTTL`) and the server closes a stream at five, so a token is
 * minted PER ATTEMPT, never cached across reconnects.
 *
 * This was previously private to api/eventBus.ts. It is here because the same
 * lifecycle is what every other SSE route needs, and re-deriving "which slug,
 * which prefix, which fallback" per route is exactly how the tenant-header
 * class of bug (a UUID where a slug belongs) gets reintroduced.
 */
import { useAuthStore } from "@/store/auth";

import { interceptMfaRequiredResponse } from "./auth";
import {
  eventBusBearer,
  eventBusStreamUrl,
  eventBusTenantSlug,
} from "./eventBusConnection";
import {
  MAX_STREAM_TOKEN_RESPONSE_BYTES,
  readBoundedResponseText,
} from "./eventBusStream";
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";
import type { SseRequest } from "./sseConnect";
import { apiUrl } from "./url";

const STREAM_TOKEN_TIMEOUT_MS = 5_000;

/**
 * The value for `X-Tenant-Slug`, or null when we have nothing to send.
 * Reads the store; the RULE (a session answers with its workspace slug, never
 * its tenant UUID) lives in ./eventBusConnection so it stays node-testable.
 */
export function streamTenantSlug(): string | null {
  const { mode, tenantId, session } = useAuthStore.getState();
  return eventBusTenantSlug({
    apiKey: null,
    mode,
    tenantId,
    workspaceSlug: session?.workspaceSlug ?? null,
  });
}

/**
 * Mint a short-lived stream credential. Returns null on any failure — the
 * caller then connects without one, which succeeds on the session-authenticated
 * routes and fails loudly (and retries) on the credentialed ones.
 */
export async function mintStreamToken(
  baseUrl: string,
  bearer: string | null,
  tenantSlug: string | null,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_TOKEN_TIMEOUT_MS);
  try {
    const res = await interceptMfaRequiredResponse(
      await fetch(apiUrl(baseUrl, "/api/v1/streams/token"), {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...NATIVE_CLIENT_HEADERS,
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(tenantSlug ? { "X-Tenant-Slug": tenantSlug } : {}),
        },
        ...(bearer ? {} : { credentials: "include" as const }),
        signal: ctrl.signal,
      }),
      baseUrl,
    );
    if (!res.ok) return null;
    const text = await readBoundedResponseText(
      res,
      MAX_STREAM_TOKEN_RESPONSE_BYTES,
    );
    if (!text) return null;
    const body = JSON.parse(text) as { token?: unknown };
    return typeof body.token === "string" && body.token ? body.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build one attempt's request for an arbitrary SSE path, minting a fresh
 * stream token.
 *
 * `path` must already carry any query string the route needs; the token is
 * appended to it. With no configured base URL the BARE PATH is handed back
 * unchanged, which is what makes the caller's "not connected" branch reachable
 * instead of producing a half-formed URL.
 */
export async function buildStreamRequest(path: string): Promise<SseRequest> {
  const { apiKey, baseUrl } = useAuthStore.getState();
  const tenantSlug = streamTenantSlug();
  if (!baseUrl) {
    return { url: path, bearer: null, tenantSlug, origin: null };
  }
  const bearer = eventBusBearer(apiKey);
  const streamToken = await mintStreamToken(baseUrl, bearer, tenantSlug);
  return {
    url: eventBusStreamUrl({ baseUrl, path, streamToken }),
    bearer,
    tenantSlug,
    origin: baseUrl,
  };
}
