/**
 * useTagCatalogue — GET /api/v1/tags, with the server-side filters the
 * endpoint has always accepted.
 *
 * The previous hook (`useTags` in hooks/useOps.ts) called
 * `client.tags.list()` with NO options and then filtered the whole
 * taxonomy client-side. The endpoint is unpaginated, so a workspace with
 * thousands of tags shipped every row on every pull-to-refresh, and
 * archived tags could not be reached at all. `query`, `group_id` and
 * `include_archived` are all read by the Go handler
 * (apps/api/internal/tags/tags.go List) and all already forwarded by the
 * SDK's TagListOptions.
 *
 * Sorting stays client-side: the endpoint does not sort.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  REFERENCE_SNAPSHOT_MAX_BYTES,
  capRowsForVault,
  loadSnapshotBacked,
  snapshotScope,
} from "@/lib/deliverabilitySnapshots";
import {
  normalizeTagCatalogue,
  type TagCatalogueRow,
} from "@/lib/tagCatalogue";
import { parseTagGroups, type TagGroup } from "@/lib/tagGroups";

export interface TagCatalogueFilters {
  /** Server-side substring match on name/description. */
  query?: string;
  /** Tenant-owned tag-group UUID. */
  groupId?: string;
  includeArchived?: boolean;
}

/** Query key for the tag catalogue under one filter combination. */
export function tagCatalogueKey(
  tenantId: string | null | undefined,
  filters: TagCatalogueFilters,
): readonly unknown[] {
  return [
    "tags",
    tenantId ?? null,
    filters.query ?? "",
    filters.groupId ?? "",
    filters.includeArchived === true,
  ];
}

/**
 * One catalogue read, with the provenance a cached read must carry.
 *
 * `rows` is an object field rather than the query's bare payload because a
 * snapshot that cannot say it is a snapshot is the exact defect
 * `CachedNotice` exists to prevent: a tag list from twelve hours ago renders
 * identically to a live one.
 */
export interface TagCatalogue {
  rows: TagCatalogueRow[];
  fromSnapshot: boolean;
  capturedAt: number | null;
}

/**
 * The tag catalogue, readable offline for the UNFILTERED view (AUDIENCE#66).
 *
 * Only the canonical view is persisted. A snapshot written from a filtered
 * read would show an offline user a subset of their taxonomy and present it
 * as the whole thing — the same rule `loadSnapshotBacked`'s `persist` flag
 * enforces for the deliverability screens.
 */
export function useTagCatalogue(filters: TagCatalogueFilters = {}) {
  const gate = useOnlineQueryGate();
  const query = (filters.query ?? "").trim();
  const groupId = (filters.groupId ?? "").trim();
  const includeArchived = filters.includeArchived === true;
  const scope = snapshotScope(gate);
  const canonical = !query && !groupId && !includeArchived;
  return useQuery<TagCatalogue>({
    queryKey: tagCatalogueKey(gate.tenantId, {
      query,
      groupId,
      includeArchived,
    }).concat([gate.userId, gate.effectiveRole, gate.enabled ? "network" : "snapshot"]),
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (canonical && gate.canReadOfflineSnapshots && Boolean(scope)),
    networkMode: "always",
    queryFn: async (): Promise<TagCatalogue> => {
      const backed = await loadSnapshotBacked<TagCatalogueRow[]>({
        resource: "tags",
        scope: canonical ? scope : null,
        canUseNetwork: gate.enabled && Boolean(gate.tenantId),
        unavailableMessage:
          "You're offline and no tag snapshot has been saved yet.",
        loadNetwork: async () => {
          const { client } = getClient();
          return normalizeTagCatalogue(
            await client.tags.list({
              // exactOptionalPropertyTypes: omit rather than send undefined,
              // so the SDK's query serialiser doesn't emit empty params.
              ...(query ? { query } : {}),
              ...(groupId ? { groupId } : {}),
              ...(includeArchived ? { includeArchived: true } : {}),
            }),
          );
        },
        minimizeForSnapshot: (rows) =>
          capRowsForVault(rows, REFERENCE_SNAPSHOT_MAX_BYTES).rows,
      });
      return {
        rows: backed.value,
        fromSnapshot: backed.fromSnapshot,
        capturedAt: backed.capturedAt,
      };
    },
  });
}

/**
 * useTagGroups — `GET /api/v1/tag-groups`, the axis the catalogue's
 * `group_id` filter selects along.
 *
 * The filter has always been forwarded by this file; the LIST of groups to
 * pick from was the missing half, so the parameter was unreachable from a
 * phone. Groups are tenant-owned reference data that changes rarely, hence
 * the long staleTime.
 */
export function tagGroupsKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["tags", tenantId ?? null, "groups"];
}

export function useTagGroups() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: tagGroupsKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<TagGroup[]> => {
      const { client } = getClient();
      return parseTagGroups(
        await client.request<unknown>("GET", "/api/v1/tag-groups"),
      );
    },
  });
}
