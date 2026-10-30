// SPDX-License-Identifier: MIT
import type { PostwaveClient } from "@postwave/sdk";

/**
 * fetchHeldScopes asks the API which scopes the configured key holds, via
 * GET /api/v1/api-keys/me, so the proxy can hide / refuse tools the key
 * cannot use.
 *
 * Returns null on ANY failure (no key, network error, non-2xx, bad body).
 * Registration interprets null as authority unavailable and fails discovery
 * and calls closed. An older deployment without `/api-keys/me` therefore
 * cannot safely run this broad proxy; it must be upgraded or held.
 */
export async function fetchHeldScopes(
  client: PostwaveClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string> | null> {
  const apiKey = env.POSTWAVE_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch(`${client.baseUrl}/api/v1/api-keys/me`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      // Bounded so a hung/slow API can never stall server startup — the
      // timeout aborts, lands in catch, and fails closed through null.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { scopes?: unknown };
    if (!Array.isArray(body.scopes)) return null;
    return new Set(body.scopes.map((s) => String(s)));
  } catch {
    return null;
  }
}
