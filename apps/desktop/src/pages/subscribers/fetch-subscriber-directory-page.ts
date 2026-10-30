import type { MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { SUBSCRIBER_SORTABLE_COLUMNS as SORTABLE_COLUMNS } from "../../components/subscribers/SubscribersBrowsePanel";
import { uiStatusToEngine } from "../../components/subscribers/subscriber-status";
import { type Subscriber, api } from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { qk } from "../../lib/query-keys";
import type { Role } from "../../lib/store";
import {
  type ServerSort,
  buildListParams,
  clientSortPage,
  isServerSort,
  parseListResponse,
} from "../subscribers-paging";
import {
  reconcileSubscriberPage,
  type LocalMutationMarker,
} from "./subscriber-live-reconciliation";
import { SUBSCRIBERS_PER_PAGE } from "./subscribers-page-utils";
import type { SubscribersPageState } from "./useSubscribersPageState";

export interface SubscriberDirectoryFetchParams {
  identityScope: string | null;
  query: string;
  status: SubscribersPageState["filter"];
  sortColumn: string;
  sortOrder: SubscribersPageState["sortOrder"];
  page: number;
  includeArchived: boolean;
}

interface FetchOwnership {
  abort: MutableRefObject<AbortController | null>;
  requestToken: MutableRefObject<number>;
  backgroundReload: MutableRefObject<boolean>;
  loadedScope: MutableRefObject<string | null>;
  rows: MutableRefObject<Subscriber[] | null>;
  loadedIdentity: MutableRefObject<string | null>;
  lastLoadedQuery: MutableRefObject<string>;
  mutationRevision: MutableRefObject<number>;
  activeMutationTokens: MutableRefObject<Map<number, string>>;
  localMutationMarkers: MutableRefObject<Map<string, LocalMutationMarker>>;
  reconcileAfterMutations: MutableRefObject<boolean>;
  queuedPatches: MutableRefObject<ReadonlyMap<string, Partial<Subscriber>>>;
}

interface FetchSetters {
  rows: (value: Subscriber[] | null) => void;
  matchTotal: (value: number | null) => void;
  serverTotal: (value: number | null) => void;
  loading: (value: boolean) => void;
  refreshing: (value: boolean) => void;
  stale: (value: boolean) => void;
  lastConfirmedAt: (value: Date) => void;
  error: (value: string | null) => void;
}

interface FetchSubscriberDirectoryPageInput {
  params: SubscriberDirectoryFetchParams;
  ownership: FetchOwnership;
  set: FetchSetters;
  tenantId: string | null;
  role: Role | null;
  queryClient: QueryClient;
  reload: () => void;
  /** Focused test seam; production always uses the typed API facade. */
  listSubscribers?: typeof api.listSubscribers;
}

export async function fetchSubscriberDirectoryPage({
  params,
  ownership,
  set,
  tenantId,
  role,
  queryClient,
  reload,
  listSubscribers = api.listSubscribers,
}: FetchSubscriberDirectoryPageInput): Promise<void> {
  ownership.abort.current?.abort();
  const controller = new AbortController();
  ownership.abort.current = controller;
  const token = ++ownership.requestToken.current;
  const requestMutationRevision = ownership.mutationRevision.current;
  const activeMutationKeysAtRequest = new Set(
    ownership.activeMutationTokens.current.values(),
  );
  ownership.backgroundReload.current = false;
  const scope = JSON.stringify(params);
  const canRetain =
    ownership.rows.current !== null && ownership.loadedScope.current === scope;
  if (canRetain) {
    set.refreshing(true);
    set.loading(false);
  } else {
    ownership.rows.current = null;
    set.rows(null);
    set.matchTotal(null);
    set.loading(true);
    set.refreshing(false);
  }
  set.error(null);

  const mapped: ServerSort | "client" =
    SORTABLE_COLUMNS[params.sortColumn] ??
    (isServerSort(params.sortColumn) ? params.sortColumn : "client");
  const options = buildListParams({
    query: params.query,
    status: params.status,
    sort: mapped === "client" ? params.sortColumn : mapped,
    order: params.sortOrder,
    page: params.page,
    perPage: SUBSCRIBERS_PER_PAGE,
    statusToEngine: uiStatusToEngine,
    includeArchived: params.includeArchived,
  });
  let response: Awaited<ReturnType<typeof api.listSubscribers>>;
  try {
    response = await listSubscribers(options, {
      signal: controller.signal,
    });
  } catch (fetchError) {
    if (token !== ownership.requestToken.current || controller.signal.aborted) {
      return;
    }
    set.error(
      redact(
        fetchError instanceof Error
          ? fetchError.message
          : "The subscriber directory request failed.",
      ),
    );
    if (canRetain) {
      set.stale(true);
    } else {
      ownership.loadedIdentity.current = params.identityScope;
      set.rows([]);
      set.matchTotal(0);
      set.stale(false);
    }
    set.loading(false);
    set.refreshing(false);
    return;
  }
  if (token !== ownership.requestToken.current) return;
  if (response.error?.kind === "network" && response.error.code === "aborted") {
    return;
  }
  if (response.error) {
    set.error(redact(response.error.message));
    if (canRetain) {
      set.stale(true);
    } else {
      ownership.loadedIdentity.current = params.identityScope;
      set.rows([]);
      set.matchTotal(0);
      set.stale(false);
    }
    set.loading(false);
    set.refreshing(false);
    return;
  }
  const parsed = parseListResponse(
    response.data,
    params.page,
    SUBSCRIBERS_PER_PAGE,
  );
  const serverRows =
    mapped === "client"
      ? clientSortPage(parsed.rows, params.sortColumn, params.sortOrder)
      : parsed.rows;
  const reconciled = reconcileSubscriberPage({
    serverRows,
    currentRows: ownership.rows.current,
    requestMutationRevision,
    activeMutationKeysAtRequest,
    localMarkers: ownership.localMutationMarkers.current,
    queuedPatches: ownership.queuedPatches.current,
  });
  const rowsForPage = reconciled.rows;
  ownership.loadedIdentity.current = params.identityScope;
  ownership.loadedScope.current = scope;
  ownership.lastLoadedQuery.current = params.query;
  set.rows(rowsForPage);
  set.matchTotal(parsed.total);
  const isUnfiltered =
    !options.query && !options.status && !options.includeArchived;
  if (isUnfiltered && parsed.total != null) set.serverTotal(parsed.total);
  if (isUnfiltered && tenantId && role) {
    queryClient.setQueryData(qk.subscribers(tenantId, role, null), rowsForPage);
  }
  set.loading(false);
  set.refreshing(false);
  set.stale(false);
  set.lastConfirmedAt(new Date());
  const activeMutationKeysNow = new Set(
    ownership.activeMutationTokens.current.values(),
  );
  for (const [key, marker] of ownership.localMutationMarkers.current) {
    if (
      marker.revision <= requestMutationRevision &&
      !activeMutationKeysNow.has(key)
    ) {
      ownership.localMutationMarkers.current.delete(key);
    }
  }
  if (reconciled.crossedMutationBoundary) {
    if (ownership.activeMutationTokens.current.size > 0) {
      ownership.reconcileAfterMutations.current = true;
    } else {
      reload();
    }
  }
}
