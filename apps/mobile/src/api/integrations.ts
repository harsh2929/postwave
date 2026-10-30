/**
 * api/integrations.ts — the wire half of the integrations surface.
 *
 * The list feed (`GET /api/v1/integrations/connections`) is fetched inside
 * `hooks/useIntegrations.ts` because it predates this module; the per-connection
 * health report gets its own function here because it takes a path parameter
 * that must be encoded, and because the endpoint it hits is the ONE lifecycle
 * route on this resource that actually does something.
 *
 * The four write routes (sync / backfill / pause / disconnect) are deliberately
 * absent. They are mounted (handlers.go:193-197) but every one of them resolves
 * to `h.action(...)`, which returns a descriptor naming a DIFFERENT endpoint on
 * a different service (`resp.DelegatedTo`, handlers.go:660-712) instead of
 * performing the action. Shipping them would give the phone four buttons that
 * return 200 and change nothing.
 */
import { getClient } from "@/api/client";
import {
  normalizeIntegrationHealth,
  type IntegrationHealth,
} from "@/lib/integrationHealth";

/**
 * GET /api/v1/integrations/{slug}/health — checks, retry policy and the recent
 * sync attempts for one connection.
 *
 * Same `read:reports` scope as the list, so a session that can see the roll-up
 * can always open the detail; there is no partial-permission state to design
 * around.
 */
export async function fetchIntegrationHealth(
  slug: string,
): Promise<IntegrationHealth> {
  const trimmed = (slug ?? "").trim();
  if (!trimmed) {
    throw new Error("An integration slug is required to read health.");
  }
  const { client } = getClient();
  const res = await client.request<unknown>(
    "GET",
    `/api/v1/integrations/${encodeURIComponent(trimmed)}/health`,
  );
  return normalizeIntegrationHealth(res);
}
