/**
 * useListOptions — the workspace list catalogue, as consumed by the
 * add-to-list picker and the list detail screen.
 *
 * Extracted out of useSubscribers.ts so the subscriber hooks stay under
 * their size budget, and re-keyed from the old private `["list-options"]`
 * root onto `["lists", tenantId, "options"]`. That re-key matters: the
 * `"lists"` root is the one wired into RECONNECT_REFETCH_QUERY_ROOTS
 * (src/lib/queryClient.ts) and into the `list.subscriber.added` cache
 * invalidation, so a membership change now refreshes the picker instead of
 * leaving it showing yesterday's catalogue.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  REFERENCE_SNAPSHOT_MAX_BYTES,
  capRowsForVault,
  loadSnapshotBacked,
  snapshotScope,
} from "@/lib/deliverabilitySnapshots";
import { readListCatalogueTotal } from "@/lib/listInventory";
import {
  LIST_CATALOGUE_GC_MS,
  LIST_CATALOGUE_STALE_MS,
} from "@/lib/listCataloguePolicy";

/** Query-key prefix for everything derived from the list catalogue. */
export function listCatalogueKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["lists", tenantId ?? null];
}

/**
 * A list row reduced to what the picker and the mobile detail header
 * need. `id` is stringified because the gateway hands back Listmonk's
 * bigint for the catalogue and a UUID for local detail routes; the
 * membership endpoints accept either.
 */
export interface ListOption {
  id: string;
  name: string;
  type?: string;
  optin?: string;
  description?: string;
  tags?: string[];
  count?: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalCount(row: Record<string, unknown>): number | undefined {
  const raw = row.count ?? row.subscriber_count;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && !!v);
  return out.length > 0 ? out : undefined;
}

/**
 * normalizeLists — flatten the shapes `lists.list()` can return (a bare
 * array, a Listmonk `{data:{results}}` envelope, or an `{items}` page)
 * into a stable ListOption[]. Pure so it can be unit-tested without the
 * SDK. Rows without an id are dropped: they cannot be routed to or added
 * to, so rendering them would be a dead tap target.
 *
 * This is the ONE list normalizer. A second `useLists` used to live in
 * hooks/useOps.ts with its own inline unwrap ladder, its own row shape and
 * its own cache entry under a sibling key — same endpoint, two truths to
 * keep in sync by hand.
 */
export function normalizeLists(res: unknown): ListOption[] {
  const envelope = res as
    | { data?: { results?: unknown[] } | unknown[]; items?: unknown[] }
    | undefined;
  let rows: unknown[] = [];
  if (Array.isArray(res)) rows = res;
  else if (Array.isArray(envelope?.data)) rows = envelope.data;
  else if (Array.isArray(envelope?.data?.results)) rows = envelope.data.results;
  else if (Array.isArray(envelope?.items)) rows = envelope.items;

  const out: ListOption[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (row.id == null) continue;
    const name = optionalString(row.name);
    const type = optionalString(row.type);
    const optin = optionalString(row.optin);
    const description = optionalString(row.description);
    const tags = stringArray(row.tags);
    const count = optionalCount(row);
    // exactOptionalPropertyTypes: never assign `undefined` to an optional
    // field — spread it in only when we actually have a value.
    out.push({
      id: String(row.id),
      name: name ?? String(row.id),
      ...(type ? { type } : {}),
      ...(optin ? { optin } : {}),
      ...(description ? { description } : {}),
      ...(tags ? { tags } : {}),
      ...(count == null ? {} : { count }),
    });
  }
  return out;
}

/**
 * What one catalogue read yields: the rows the client holds, plus the
 * envelope's own row total when the gateway echoed one.
 *
 * `total` is the whole point. The gateway forwards ONLY `?query=` to
 * Listmonk's `/api/lists` (apps/api/internal/lists/lists.go), so `rows` is
 * whatever the upstream DEFAULT page returned and the client cannot ask for
 * more. Without the envelope's total there is no way to tell a 12-list
 * workspace from the first page of a 143-list one — which is how a page-1 sum
 * ended up printed under the label "Subscribers". null means "unknown", and
 * every consumer must treat unknown as "cannot claim completeness".
 */
export interface ListCatalogue {
  rows: ListOption[];
  total: number | null;
  /**
   * Snapshot provenance (AUDIENCE#66). Optional so every existing consumer of
   * `{rows, total}` keeps working unchanged; a screen that wants to say
   * "Cached 3h ago" reads these two.
   */
  fromSnapshot?: boolean;
  capturedAt?: number | null;
}

/**
 * The catalogue's cache policy lives in an import-free module so it can be
 * asserted by a node test (this file transitively imports react-native). See
 * lib/listCataloguePolicy for why it is not on the client-wide defaults.
 */
export {
  LIST_CATALOGUE_GC_MS,
  LIST_CATALOGUE_STALE_MS,
} from "@/lib/listCataloguePolicy";

/**
 * The workspace list catalogue (the gateway does not page it — see above),
 * readable offline.
 *
 * AUDIENCE#66: three sibling reference screens in the same Audience section
 * behaved differently in airplane mode for no stated reason — suppressions had
 * a snapshot, lists and tags did not. The list catalogue is the ideal
 * candidate: small, slow-moving, and the thing the add-to-list picker cannot
 * function without.
 *
 * Provenance rides ON the catalogue object rather than wrapping it, because
 * `data.rows` is already read by the picker, the bulk sheets and the detail
 * header; a wrapper would have been a breaking change to three call sites for
 * two extra fields.
 */
export function useListOptions() {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  return useQuery<ListCatalogue>({
    queryKey: [
      ...listCatalogueKey(gate.tenantId),
      "options",
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (gate.canReadOfflineSnapshots && Boolean(scope)),
    staleTime: LIST_CATALOGUE_STALE_MS,
    gcTime: LIST_CATALOGUE_GC_MS,
    networkMode: "always",
    queryFn: async () => {
      const backed = await loadSnapshotBacked<ListCatalogue>({
        resource: "lists",
        scope,
        canUseNetwork: gate.enabled && Boolean(gate.tenantId),
        unavailableMessage:
          "You're offline and no list snapshot has been saved yet.",
        loadNetwork: async () => {
          const { client } = getClient();
          const res = await client.lists.list();
          return {
            rows: normalizeLists(res),
            total: readListCatalogueTotal(res),
          };
        },
        // `total` is deliberately preserved even when rows are trimmed: it is
        // the envelope's own count, and dropping it would turn "143 lists, 40
        // cached" into a silent claim that the workspace has 40.
        minimizeForSnapshot: (catalogue) => ({
          rows: capRowsForVault(catalogue.rows, REFERENCE_SNAPSHOT_MAX_BYTES)
            .rows,
          total: catalogue.total,
        }),
      });
      return {
        ...backed.value,
        fromSnapshot: backed.fromSnapshot,
        capturedAt: backed.capturedAt,
      };
    },
  });
}

/**
 * Look one list up out of the already-cached catalogue. The gateway has no
 * `GET /api/v1/lists/{id}` detail route (only the catalogue plus the
 * per-list analytics endpoints), so the detail screen's header comes from
 * the same query the picker uses rather than a second fetch.
 */
export function findListOption(
  options: readonly ListOption[] | undefined,
  id: string | undefined,
): ListOption | null {
  if (!options || !id) return null;
  return options.find((row) => row.id === String(id)) ?? null;
}

// useCreateList lives in hooks/useCreateList.ts, NOT here.
//
// HOUSE RULE 6: vitest runs in a node environment, and this module is
// imported by useListOptions.test.ts / useSubscribers.test.ts /
// useSubscriberLists.test.ts. `@/api/request` transitively pulls in
// react-native (request → sdkClient → store/auth), which cannot be parsed
// there — adding that import here took three suites from passing to
// "Flow is not supported" at react-native/index.js.
