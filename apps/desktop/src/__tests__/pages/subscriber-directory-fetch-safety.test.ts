import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { Subscriber } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";
import type { SubscribersResponse } from "../../lib/api/subscriber-profiles";
import { fetchSubscriberDirectoryPage } from "../../pages/subscribers/fetch-subscriber-directory-page";

function ref<T>(current: T): { current: T } {
  return { current };
}

const params = {
  identityScope: "user-1:tenant-1",
  query: "",
  status: "all" as const,
  sortColumn: "updated_at",
  sortOrder: "desc" as const,
  page: 1,
  includeArchived: false,
};

function subscriber(status: string, version: string): Subscriber {
  return {
    id: "subscriber-1",
    email: "alice@example.test",
    status,
    version,
  };
}

describe("subscriber directory fetch safety", () => {
  it("preserves a mutation that was already active when the request began", async () => {
    const optimistic = subscriber("disabled", '"subscriber:subscriber-1:v1"');
    const rows = ref<Subscriber[] | null>([optimistic]);
    const markers = new Map([["subscriber-1", { revision: 1, present: true }]]);
    const active = new Map([[1, "subscriber-1"]]);
    const reconcileAfterMutations = ref(false);
    const reload = vi.fn();
    const listSubscribers = vi.fn(
      async (): Promise<ApiResult<SubscribersResponse>> => ({
        data: {
          items: [subscriber("enabled", '"subscriber:subscriber-1:v1"')],
          total: 1,
          page: 1,
          per_page: 50,
        },
      }),
    );

    await fetchSubscriberDirectoryPage({
      params,
      ownership: {
        abort: ref<AbortController | null>(null),
        requestToken: ref(0),
        backgroundReload: ref(false),
        loadedScope: ref(JSON.stringify(params)),
        rows,
        loadedIdentity: ref(params.identityScope),
        lastLoadedQuery: ref(""),
        mutationRevision: ref(1),
        activeMutationTokens: ref(active),
        localMutationMarkers: ref(markers),
        reconcileAfterMutations,
        queuedPatches: ref(new Map()),
      },
      set: {
        rows: (next) => {
          rows.current = next;
        },
        matchTotal: vi.fn(),
        serverTotal: vi.fn(),
        loading: vi.fn(),
        refreshing: vi.fn(),
        stale: vi.fn(),
        lastConfirmedAt: vi.fn(),
        error: vi.fn(),
      },
      tenantId: null,
      role: null,
      queryClient: new QueryClient(),
      reload,
      listSubscribers,
    });

    expect(rows.current).toEqual([optimistic]);
    expect(markers.get("subscriber-1")).toEqual({
      revision: 1,
      present: true,
    });
    expect(reconcileAfterMutations.current).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("retains last-confirmed rows when the API rejects a malformed success", async () => {
    const confirmed = subscriber("enabled", '"subscriber:subscriber-1:v1"');
    const rows = ref<Subscriber[] | null>([confirmed]);
    const setRows = vi.fn();
    const setStale = vi.fn();
    const setError = vi.fn();

    await fetchSubscriberDirectoryPage({
      params,
      ownership: {
        abort: ref<AbortController | null>(null),
        requestToken: ref(0),
        backgroundReload: ref(false),
        loadedScope: ref(JSON.stringify(params)),
        rows,
        loadedIdentity: ref(params.identityScope),
        lastLoadedQuery: ref(""),
        mutationRevision: ref(0),
        activeMutationTokens: ref(new Map()),
        localMutationMarkers: ref(new Map()),
        reconcileAfterMutations: ref(false),
        queuedPatches: ref(new Map()),
      },
      set: {
        rows: setRows,
        matchTotal: vi.fn(),
        serverTotal: vi.fn(),
        loading: vi.fn(),
        refreshing: vi.fn(),
        stale: setStale,
        lastConfirmedAt: vi.fn(),
        error: setError,
      },
      tenantId: null,
      role: null,
      queryClient: new QueryClient(),
      reload: vi.fn(),
      listSubscribers: vi.fn(async () => ({
        error: {
          kind: "parse" as const,
          code: "invalid_subscriber_response_contract",
          message: "The subscriber service returned an invalid directory page.",
        },
      })),
    });

    expect(rows.current).toEqual([confirmed]);
    expect(setRows).not.toHaveBeenCalled();
    expect(setStale).toHaveBeenCalledWith(true);
    expect(setError).toHaveBeenCalledWith(
      "The subscriber service returned an invalid directory page.",
    );
  });
});
