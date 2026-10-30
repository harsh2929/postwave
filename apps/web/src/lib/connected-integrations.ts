// SPDX-License-Identifier: AGPL-3.0-only
//
// connected-integrations.ts (INTG-029) — the data layer behind the catalog's
// "Your integrations" view. Fans out to every connectable surface list()-client
// (crm/commerce/review/loyalty/subscription/analytics/marketing) plus
// the three chat webhook clients (slack/discord/teams), normalizes each row to
// a ConnectedIntegration, and merges them into a Map keyed by normalized
// provider. Pure helpers are exported for unit tests; the hook runs only
// inside client components (the admin-only catalog page is one).

import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";
import { type MeResponse } from "@/lib/auth-api";
import { adminReadIdentityParts } from "@/lib/admin-read-authority";
import { base, STALE } from "@/lib/query-keys";
import {
  CONNECTABLE_SURFACE_CLIENTS,
  normalizeProvider,
} from "@/lib/catalog-connect-map";
import {
  discordIntegrationsApi,
  slackIntegrationsApi,
  teamsIntegrationsApi,
} from "@/lib/integrations-api";

export type ConnectedStatus = "connected" | "paused" | "error" | "unknown";

export interface ConnectedIntegration {
  provider: string;
  surfaceKey: string;
  status: ConnectedStatus;
  id: string;
}

/** Map a surface's free-form status string to a coarse connected status. */
export function normalizeStatus(raw: string): ConnectedStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "active" || s === "connected") return "connected";
  if (s === "paused") return "paused";
  if (s === "error" || s === "failed") return "error";
  return "unknown";
}

export function toConnectedFromSurface(
  rows: Array<{ provider: string; status: string; id: string }>,
  surfaceKey: string,
): ConnectedIntegration[] {
  return rows.map((r) => ({
    provider: r.provider,
    surfaceKey,
    status: normalizeStatus(r.status),
    id: r.id,
  }));
}

/**
 * Chat rows carry NO provider field (they came from a per-provider client) and
 * use a boolean `enabled`, so the provider is INJECTED from the registry entry.
 */
export function toConnectedFromChat(
  rows: Array<{ enabled: boolean; id: string }>,
  provider: string,
  surfaceKey = "chat",
): ConnectedIntegration[] {
  return rows.map((r) => ({
    provider,
    surfaceKey,
    status: r.enabled ? "connected" : "paused",
    id: r.id,
  }));
}

/**
 * Merge connected rows into a Map keyed by normalized provider. On collision
 * (e.g. a tenant with multiple rows for one provider), a "connected" row wins
 * over a non-connected one so a single tile reflects the best state.
 */
export function buildConnectedMap(
  rows: ConnectedIntegration[],
): Map<string, ConnectedIntegration> {
  const map = new Map<string, ConnectedIntegration>();
  for (const row of rows) {
    const key = normalizeProvider(row.provider);
    const existing = map.get(key);
    if (
      !existing ||
      (existing.status !== "connected" && row.status === "connected")
    ) {
      map.set(key, row);
    }
  }
  return map;
}

// A stable, module-const fan-out descriptor so useQueries keeps a consistent
// length/order across renders.
interface FanoutEntry {
  id: string;
  list: (signal?: AbortSignal) => Promise<unknown[]>;
  toRows: (rows: unknown[]) => ConnectedIntegration[];
}

const FANOUT: FanoutEntry[] = [
  ...CONNECTABLE_SURFACE_CLIENTS.map(
    (entry): FanoutEntry => ({
      id: `surface:${entry.key}`,
      list: (signal) => entry.client.list({ signal }) as Promise<unknown[]>,
      toRows: (rows) =>
        toConnectedFromSurface(
          rows as Array<{ provider: string; status: string; id: string }>,
          entry.key,
        ),
    }),
  ),
  ...(
    [
      { provider: "slack", client: slackIntegrationsApi },
      { provider: "discord", client: discordIntegrationsApi },
      { provider: "teams", client: teamsIntegrationsApi },
    ] as const
  ).map(
    (chat): FanoutEntry => ({
      id: `chat:${chat.provider}`,
      // Chat clients return a BARE array with no {items} envelope / null-coalesce.
      list: (signal) =>
        chat.client
          .list({ signal })
          .then((rows) => (Array.isArray(rows) ? rows : [])),
      toRows: (rows) =>
        toConnectedFromChat(
          rows as Array<{ enabled: boolean; id: string }>,
          chat.provider,
        ),
    }),
  ),
];

function isAuthDenied(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export interface ConnectedIntegrationsResult {
  /** Normalized-provider → the best connected row for that provider. */
  byProvider: Map<string, ConnectedIntegration>;
  isLoading: boolean;
  /** At least one surface failed, so the map is incomplete. */
  isPartial: boolean;
  /** A fan-out route rejected the already-resolved admin authority. */
  isAuthError: boolean;
  /**
   * True only once identity AND every fan-out query have settled — the
   * fan-out-aware signal callers gate on so a deep-linked ?connected=1 never
   * narrows to an empty grid while connections are still loading.
   */
  isFetched: boolean;
}

/**
 * Fan out to every connectable surface + chat client and expose the merged
 * connected-provider map. Every query is tenant+user+effective-role+viewer
 * scoped and gated on an already-resolved admin identity. A 401/403 remains an
 * explicit error so a denied source is never represented as an empty source.
 */
export function useConnectedIntegrations({
  identity,
  enabled,
}: {
  identity: MeResponse | null;
  enabled: boolean;
}): ConnectedIntegrationsResult {
  const [tenantId, userId, role, viewerMode] = adminReadIdentityParts(identity);
  const baseKey = useMemo(
    () =>
      [...base("integrations", tenantId, role), userId, viewerMode] as const,
    [role, tenantId, userId, viewerMode],
  );

  // Stable combine reference so query-core returns its cached combined result
  // (and a referentially-stable byProvider Map) when no underlying query data
  // changed — otherwise the catalog re-runs its full ~630-item filter/sort on
  // every keystroke render. buildConnectedMap is module-level so deps are [].
  const combine = useCallback(
    (
      queries: ReadonlyArray<{
        data?: ConnectedIntegration[] | undefined;
        isLoading: boolean;
        isFetched: boolean;
        isError: boolean;
        error: unknown;
      }>,
    ) => ({
      byProvider: buildConnectedMap(
        queries.flatMap((q) => (Array.isArray(q.data) ? q.data : [])),
      ),
      isLoading: queries.some((q) => q.isLoading),
      isPartial: queries.some((q) => q.isError),
      isAuthError: queries.some((q) => q.isError && isAuthDenied(q.error)),
      // Fan-out is settled only when every query has fetched at least once
      // (a disabled query — before identity resolves — reports isFetched=false).
      isFetched: queries.every((q) => q.isFetched),
    }),
    [],
  );

  const results = useQueries({
    queries: FANOUT.map((entry) => ({
      queryKey: [...baseKey, "connected", entry.id] as const,
      queryFn: async ({ signal }): Promise<ConnectedIntegration[]> =>
        entry.toRows(await entry.list(signal)),
      enabled,
      staleTime: STALE.list,
      retry: false,
    })),
    combine,
  });

  return {
    byProvider: results.byProvider,
    isLoading: enabled && results.isLoading,
    isPartial: enabled && results.isPartial,
    isAuthError: enabled && results.isAuthError,
    isFetched: enabled && results.isFetched,
  };
}
