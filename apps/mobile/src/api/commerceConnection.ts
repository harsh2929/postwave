/**
 * api/commerceConnection.ts — pause and disconnect a store connection.
 *
 * Kept OUT of api/commerce.ts: that module owns the reads and the one
 * cursor-level write (resume), and these two are the writes that change what
 * the LIST says about a store rather than what its cursor says. The server
 * facts — scopes, status codes, what "paused" actually does — are in the
 * header of lib/commerceConnection.ts; nothing here re-states them.
 *
 * Both routes are ScopeAdmin (handlers.go:143-144), which on the session path
 * is an owner/admin ROLE check (apikeys/middleware.go:211-220). The manifest
 * agrees (session_minimum_role admin). Neither is release-held.
 */
import {
  normalizeDisconnectOutcome,
  type DisconnectOutcome,
} from "@/lib/commerceConnection";
import { normalizeCommerceStores, type CommerceStore } from "@/lib/commerceRollup";

import { CommerceRequestError } from "./commerce";
import { rawRequest } from "./request";

/**
 * Mark a store paused.
 *
 * No body: `PauseIntegration` reads nothing from the request (handlers.go:326).
 * The 200 answer is the updated Integration row, pushed through the same
 * normalizer the list uses so the caller gets the shape it already renders —
 * null only if the body was not an integration at all.
 */
export async function pauseCommerceStore(
  integrationId: string,
): Promise<CommerceStore | null> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to pause it.");
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/pause`,
  );
  if (res.error) throw new CommerceRequestError(res.error, "Pausing the store");
  return normalizeCommerceStores([res.data])[0] ?? null;
}

/**
 * Disconnect a store. Answers with the server's own account of what it
 * cleaned up at the provider and what the operator still has to do —
 * see `DisconnectOutcome`.
 */
export async function disconnectCommerceStore(
  integrationId: string,
): Promise<DisconnectOutcome> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to disconnect it.");
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}`,
  );
  if (res.error) {
    throw new CommerceRequestError(res.error, "Disconnecting the store");
  }
  return normalizeDisconnectOutcome(res.data);
}
