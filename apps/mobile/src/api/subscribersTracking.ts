/**
 * api/subscribersTracking.ts — per-subscriber tracking-consent transport.
 *
 *   GET   /api/v1/subscribers/{id}/tracking-consent   viewer
 *   PATCH /api/v1/subscribers/{id}/tracking-consent   editor
 *
 * THE WRITE IS CONDITIONAL ON A HEADER-ONLY TOKEN. The version is NOT in the
 * body: the GET emits a strong quoted `ETag` computed from the subscriber row
 * AND the prefs row (tracking.go trackingETag), and the PATCH rejects
 * absent/weak/unquoted/list If-Match. So the GET here captures the header via
 * the SDK's `onResponseHeaders` (the serviceSuite idiom) and hands it back
 * WITH the body; the caller returns it for the PATCH. Refreshing the token
 * inside the PATCH would be wrong here — the decision was made against the
 * state the operator SAW, and a silent re-read could bind it to a different
 * subscriber state (exactly what the server's 412 exists to catch).
 *
 * Node-tested with `getClient` mocked (src/api/serviceSuite.test.ts idiom).
 */
import { getClient } from "@/api/client";

export interface TrackingPrefsResource {
  /** The GET body (consent.TrackingPrefs) — parsing lives in the lib. */
  body: unknown;
  /** The strong entity-tag for the conditional PATCH, or "" if absent. */
  etag: string;
}

function path(id: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(id)}/tracking-consent`;
}

export async function fetchTrackingPrefs(
  id: string,
): Promise<TrackingPrefsResource> {
  const { client } = getClient();
  let etag = "";
  const body = await client.request<unknown>("GET", path(id), {
    onResponseHeaders: (headers) => {
      etag = headers.get("ETag") ?? "";
    },
  });
  return { body, etag };
}

/**
 * Record one dimension's explicit opt-out/in against the EXACT state the
 * operator reviewed. Refuses to send without the token — an unconditional
 * tracking-consent write is the bug the server 428s, and failing here keeps
 * the refusal on-device.
 */
export async function patchTrackingPrefs(
  id: string,
  etag: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!etag) {
    throw new Error(
      "The tracking preference can't be saved without the version the server issued. Reload and try again.",
    );
  }
  const { client } = getClient();
  return client.request<unknown>("PATCH", path(id), {
    body,
    headers: { "If-Match": etag },
  });
}
