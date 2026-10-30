import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook, waitFor } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";

import * as Gate from "@/hooks/useOnlineQueryGate";
import { observeContextEpoch, resetContextEpoch } from "@/lib/contextEpoch";
import * as Auth from "@/store/auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = "2026-08-24T10:00:00.123456789Z";

const mockListConversations = jest.fn(async (_input: unknown) => ({
  items: [],
  page: {
    hasMore: false,
    nextCursor: null,
    asOf: "2026-08-24T10:01:00Z",
    consistency: "mutable_window",
    mayReorder: true,
  },
}));
const mockListMessages = jest.fn(async (..._args: unknown[]) => ({
  items: [],
  page: {
    hasMore: false,
    nextCursor: null,
    asOf: "2026-08-24T10:01:00Z",
    consistency: "created_at_window",
    mayReorder: true,
  },
  order: "desc",
}));
const mockSetStatus = jest.fn(async (..._args: unknown[]) => ({
  conversation: {
    id: CONVERSATION_ID,
    tenantId: TENANT,
    version: VERSION,
  },
  etag: `"${VERSION}"`,
}));
const mockClaim = jest.fn(async (..._args: unknown[]) => ({
  conversation: {
    id: CONVERSATION_ID,
    tenantId: TENANT,
    version: VERSION,
  },
  etag: `"${VERSION}"`,
}));
const mockRecordNote = jest.fn(async (..._args: unknown[]) => ({
  note: {},
  replayed: false,
}));

jest.mock("@/api/serviceSuite", () => ({
  claimHelpdeskConversation: (...args: unknown[]) => mockClaim(...args),
  fetchHelpdeskCatalog: jest.fn(),
  fetchHelpdeskConversation: jest.fn(),
  helpdeskVersionedMutationOutcomeIsAmbiguous: (error: unknown) => {
    if (!error || typeof error !== "object") return true;
    const status = (error as { status?: unknown }).status;
    return ![400, 401, 403, 404, 409, 412, 428, 429].includes(
      typeof status === "number" ? status : 0,
    );
  },
  listHelpdeskConversations: (input: unknown) => mockListConversations(input),
  listHelpdeskMessages: (...args: unknown[]) => mockListMessages(...args),
  recordHelpdeskInternalNote: (...args: unknown[]) => mockRecordNote(...args),
  setHelpdeskConversationStatus: (...args: unknown[]) => mockSetStatus(...args),
}));

// eslint-disable-next-line import/first -- serviceSuite must be mocked before this hook module is evaluated.
import {
  HELPDESK_THREAD_POLL_MS,
  makeHelpdeskIdentity,
  useHelpdeskAccess,
  useHelpdeskAssignment,
  useHelpdeskCatalog,
  useHelpdeskConversation,
  useHelpdeskConversations,
  useHelpdeskInternalNote,
  useHelpdeskStatusChange,
  useHelpdeskThread,
} from "@/hooks/useHelpdesk";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __getQueryOptionsForTests: () => {
    kind: string;
    options: Record<string, unknown>;
  }[];
  __getLastMutationOptionsForTests: () => Record<string, unknown> | undefined;
  __getQueryClientForTests: () => {
    cancelQueries: jest.Mock;
    invalidateQueries: jest.Mock;
    removeQueries: jest.Mock;
    resetQueries: jest.Mock;
  };
  __setCachedMutationsForTests: (entries: unknown[]) => void;
  __getMutationCacheForTests: () => {
    remove: jest.Mock;
  };
  __resetQueryResultForTests: () => void;
};

function queryRoot(options: Record<string, unknown>): unknown {
  const key = options.queryKey;
  return Array.isArray(key) ? key[0] : undefined;
}
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __setIsOnlineForTests: (value: boolean) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = Auth as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

function admin(
  refreshSessionFromServer = jest.fn(async () => ({
    tenantId: TENANT,
    userId: USER,
    effectiveRole: "admin",
  })),
) {
  observeContextEpoch("epoch-1");
  gateHarness.__setIsOnlineForTests(true);
  gateHarness.__setOnlineGateForTests({
    enabled: true,
    baseUrl: "https://api.postwave.test/",
    tenantId: TENANT,
    userId: USER,
    effectiveRole: "admin",
  });
  authHarness.__setAuthStateForTests({
    baseUrl: "https://api.postwave.test/",
    tenantId: TENANT,
    mode: "session",
    refreshSessionFromServer,
    session: {
      tenantId: TENANT,
      userId: USER,
      role: "admin",
      effectiveRole: "admin",
    },
  });
  return refreshSessionFromServer;
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
  resetContextEpoch();
  mockListConversations.mockClear();
  mockListMessages.mockClear();
  mockSetStatus.mockClear();
  mockClaim.mockClear();
  mockRecordNote.mockClear();
});

describe("Helpdesk zero-request and identity boundary", () => {
  it("rejects unsafe base URLs and context epochs before a query can be keyed", () => {
    const base = {
      tenantId: TENANT,
      userId: USER,
      effectiveRole: "admin",
      mode: "session" as const,
      contextEpoch: "epoch-1",
    };
    expect(
      makeHelpdeskIdentity({ ...base, baseUrl: "javascript:alert(1)" }),
    ).toBeNull();
    expect(
      makeHelpdeskIdentity({
        ...base,
        baseUrl: "https://api.postwave.test",
        contextEpoch: "epoch\u202espoof",
      }),
    ).toBeNull();
  });

  it("keeps note recovery stable across role/epoch changes but isolates principal changes", () => {
    const base = {
      baseUrl: "https://api.postwave.test/",
      tenantId: TENANT,
      userId: USER,
      effectiveRole: "admin",
      mode: "session" as const,
      contextEpoch: "epoch-1",
    };
    const first = makeHelpdeskIdentity(base);
    const refreshed = makeHelpdeskIdentity({
      ...base,
      effectiveRole: "owner",
      contextEpoch: "epoch-2",
    });
    const otherUser = makeHelpdeskIdentity({ ...base, userId: OTHER_USER });
    const otherTenant = makeHelpdeskIdentity({
      ...base,
      tenantId: OTHER_TENANT,
    });
    expect(first?.fingerprint).not.toBe(refreshed?.fingerprint);
    expect(first?.noteRecoveryPrincipal).toBe(refreshed?.noteRecoveryPrincipal);
    expect(first?.noteRecoveryPrincipal).not.toBe(
      otherUser?.noteRecoveryPrincipal,
    );
    expect(first?.noteRecoveryPrincipal).not.toBe(
      otherTenant?.noteRecoveryPrincipal,
    );
    expect(makeHelpdeskIdentity({ ...base, mode: "api_key" })).toBeNull();
  });

  it("mounts disabled queries for viewer access and makes zero API calls", async () => {
    observeContextEpoch("epoch-viewer");
    gateHarness.__setOnlineGateForTests({
      enabled: true,
      baseUrl: "https://api.postwave.test",
      tenantId: TENANT,
      userId: USER,
      effectiveRole: "viewer",
    });
    authHarness.__setAuthStateForTests({
      baseUrl: "https://api.postwave.test",
      tenantId: TENANT,
      mode: "session",
      session: {
        tenantId: TENANT,
        userId: USER,
        role: "viewer",
        effectiveRole: "viewer",
      },
    });
    const hook = await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskConversations(null, access);
      useHelpdeskCatalog(access);
      return access;
    });
    expect(hook.result.current.roleAllowed).toBe(false);
    expect(
      queryHarness
        .__getQueryOptionsForTests()
        .every((entry) => entry.options.enabled === false),
    ).toBe(true);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  it("requires a canonical UUID before enabling a deep-link detail query", async () => {
    admin();
    const hook = await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskConversation("../../other-tenant", access);
      return access;
    });
    expect(hook.result.current.canRequest).toBe(true);
    const detail = queryHarness
      .__getQueryOptionsForTests()
      .find((entry) => queryRoot(entry.options) === "helpdesk-conversation-v2");
    expect(detail?.options.enabled).toBe(false);
  });

  it("puts base, tenant, user, effective role, mode, and epoch in the key", async () => {
    admin();
    await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskConversations("open", access);
      return access;
    });
    const key = queryHarness
      .__getQueryOptionsForTests()
      .find((entry) => entry.kind === "infinite")?.options
      .queryKey as unknown[];
    expect(key).toEqual(
      expect.arrayContaining([
        "https://api.postwave.test",
        TENANT,
        USER,
        "admin",
        "session",
        "epoch-1",
      ]),
    );
  });

  it("forwards AbortSignal and never silently restarts a cursor", async () => {
    admin();
    await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskConversations("open", access);
      return access;
    });
    const options = queryHarness
      .__getQueryOptionsForTests()
      .find((entry) => entry.kind === "infinite")?.options;
    const signal = new AbortController().signal;
    await (
      options?.queryFn as (input: {
        pageParam: string;
        signal: AbortSignal;
      }) => Promise<unknown>
    )({ pageParam: "v1.opaque", signal });
    expect(mockListConversations).toHaveBeenCalledWith({
      status: "open",
      cursor: "v1.opaque",
      signal,
    });
  });

  it("purges protected rows and mutation bodies when session validation is lost", async () => {
    admin();
    const staleNote = {
      options: {
        mutationKey: ["helpdesk-internal-note-v2", "retired-fingerprint"],
      },
      state: { variables: { body: "customer PII" } },
    };
    queryHarness.__setCachedMutationsForTests([staleNote]);
    const hook = await renderHook(() => useHelpdeskAccess());
    const client = queryHarness.__getQueryClientForTests();
    const mutationCache = queryHarness.__getMutationCacheForTests();

    gateHarness.__setOnlineGateForTests({ enabled: false });
    await hook.rerender({});

    await waitFor(() => expect(client.removeQueries).toHaveBeenCalled());
    const removal = client.removeQueries.mock.calls.at(-1)?.[0] as
      | { predicate?: (query: { queryKey: readonly unknown[] }) => boolean }
      | undefined;
    expect(
      removal?.predicate?.({ queryKey: ["helpdesk-thread-v2", "active"] }),
    ).toBe(true);
    expect(mutationCache.remove).toHaveBeenCalledWith(staleNote);
  });

  it("purges protected cache before serving an offline Helpdesk snapshot", async () => {
    admin();
    const hook = await renderHook(() => useHelpdeskAccess());
    const client = queryHarness.__getQueryClientForTests();

    gateHarness.__setIsOnlineForTests(false);
    await hook.rerender({});

    expect(hook.result.current.online).toBe(false);
    await waitFor(() => expect(client.removeQueries).toHaveBeenCalled());
  });

  it("removes the retired identity cache even when the thread is unfocused", async () => {
    admin();
    const hook = await renderHook(() => useHelpdeskAccess(false));
    const client = queryHarness.__getQueryClientForTests();
    const retiredFingerprint = hook.result.current.identity?.fingerprint;
    expect(retiredFingerprint).toBeTruthy();
    client.removeQueries.mockClear();

    observeContextEpoch("epoch-2");
    gateHarness.__setOnlineGateForTests({
      enabled: true,
      baseUrl: "https://api.postwave.test/",
      tenantId: OTHER_TENANT,
      userId: OTHER_USER,
      effectiveRole: "admin",
    });
    authHarness.__setAuthStateForTests({
      baseUrl: "https://api.postwave.test/",
      tenantId: OTHER_TENANT,
      mode: "session",
      session: {
        tenantId: OTHER_TENANT,
        userId: OTHER_USER,
        role: "admin",
        effectiveRole: "admin",
      },
    });
    await hook.rerender({});

    const activeFingerprint = hook.result.current.identity?.fingerprint;
    expect(activeFingerprint).toBeTruthy();
    expect(activeFingerprint).not.toBe(retiredFingerprint);
    await waitFor(() => expect(client.removeQueries).toHaveBeenCalled());
    const removal = client.removeQueries.mock.calls
      .map(
        ([input]) =>
          input as {
            predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
          },
      )
      .find((input) =>
        input.predicate?.({
          queryKey: ["helpdesk-thread-v2", retiredFingerprint],
        }),
      );
    expect(
      removal?.predicate?.({
        queryKey: ["helpdesk-thread-v2", activeFingerprint],
      }),
    ).toBe(false);
  });

  it("uses one exact, non-duplicated identity scope in the note mutation key", async () => {
    admin();
    const hook = await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskInternalNote(CONVERSATION_ID, access);
      return access;
    });
    const identity = hook.result.current.identity;
    expect(identity).not.toBeNull();
    expect(
      queryHarness.__getLastMutationOptionsForTests()?.mutationKey,
    ).toEqual([
      "helpdesk-internal-note-v2",
      identity?.fingerprint,
      "https://api.postwave.test",
      TENANT,
      USER,
      "admin",
      "session",
      "epoch-1",
      CONVERSATION_ID,
    ]);
  });
});

describe("Helpdesk freshness and action-time authority", () => {
  it.each(["context epoch change", "API-key switch"])(
    "stops a prepared note before record transport after %s",
    async (transition) => {
      admin();
      await renderHook(() => {
        const access = useHelpdeskAccess();
        return useHelpdeskInternalNote(CONVERSATION_ID, access);
      });
      const mutation = queryHarness.__getLastMutationOptionsForTests();

      if (transition === "context epoch change") {
        observeContextEpoch("epoch-2");
      } else {
        authHarness.__setAuthStateForTests({
          baseUrl: "https://api.postwave.test/",
          tenantId: TENANT,
          mode: "api_key",
          session: null,
        });
      }

      await expect(
        (
          mutation?.mutationFn as (input: {
            body: string;
            idempotencyKey: string;
          }) => Promise<unknown>
        )({
          body: "Private note",
          idempotencyKey: "mobile-helpdesk-note-retained-key",
        }),
      ).rejects.toThrow(/access changed/u);
      expect(mockRecordNote).not.toHaveBeenCalled();
    },
  );

  it("polls the latest window but pauses after older cursor pages are loaded", async () => {
    admin();
    await renderHook(() => {
      const access = useHelpdeskAccess();
      useHelpdeskThread(CONVERSATION_ID, access);
      return access;
    });
    const options = queryHarness
      .__getQueryOptionsForTests()
      .find(
        (entry) => queryRoot(entry.options) === "helpdesk-thread-v2",
      )?.options;
    const interval = options?.refetchInterval as (
      query: unknown,
    ) => number | false;
    expect(
      interval({ state: { data: { pages: [{}], pageParams: [undefined] } } }),
    ).toBe(HELPDESK_THREAD_POLL_MS);
    expect(
      interval({
        state: {
          data: { pages: [{}, {}], pageParams: [undefined, "v1.older"] },
        },
      }),
    ).toBe(false);
  });

  it("refreshes who-am-I immediately before a versioned status write", async () => {
    const order: string[] = [];
    const refresh = admin(
      jest.fn(async () => {
        order.push("whoami");
        return { tenantId: TENANT, userId: USER, effectiveRole: "admin" };
      }),
    );
    mockSetStatus.mockImplementationOnce(async () => {
      order.push("status");
      return {
        conversation: {
          id: CONVERSATION_ID,
          tenantId: TENANT,
          version: VERSION,
        },
        etag: `"${VERSION}"`,
      };
    });
    await renderHook(() => {
      const access = useHelpdeskAccess();
      return useHelpdeskStatusChange(CONVERSATION_ID, access);
    });
    const mutation = queryHarness.__getLastMutationOptionsForTests();
    await (
      mutation?.mutationFn as (
        input: Record<string, string>,
      ) => Promise<unknown>
    )({
      status: "resolved",
      ifMatch: `"${VERSION}"`,
      expectedVersion: VERSION,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["whoami", "status"]);
    expect(mockSetStatus).toHaveBeenCalledWith(
      CONVERSATION_ID,
      "resolved",
      expect.objectContaining({
        ifMatch: `"${VERSION}"`,
        expectedVersion: VERSION,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("stops before the mutation if who-am-I reports a demotion", async () => {
    admin(
      jest.fn(async () => ({
        tenantId: TENANT,
        userId: USER,
        effectiveRole: "viewer",
      })),
    );
    await renderHook(() => {
      const access = useHelpdeskAccess();
      return useHelpdeskStatusChange(CONVERSATION_ID, access);
    });
    const mutation = queryHarness.__getLastMutationOptionsForTests();
    await expect(
      (
        mutation?.mutationFn as (
          input: Record<string, string>,
        ) => Promise<unknown>
      )({
        status: "resolved",
        ifMatch: `"${VERSION}"`,
        expectedVersion: VERSION,
      }),
    ).rejects.toThrow(/access changed/u);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("discards the stale detail revision and refreshes the queue after a status timeout", async () => {
    admin();
    await renderHook(() => {
      const access = useHelpdeskAccess();
      return useHelpdeskStatusChange(CONVERSATION_ID, access);
    });
    const mutation = queryHarness.__getLastMutationOptionsForTests();
    const timeout = Object.assign(new Error("request timed out"), {
      status: 0,
      code: "network_error",
    });
    (mutation?.onError as (error: Error) => void)(timeout);
    const client = queryHarness.__getQueryClientForTests();
    const detailKey = [
      "helpdesk-conversation-v2",
      expect.any(String),
      "https://api.postwave.test",
      TENANT,
      USER,
      "admin",
      "session",
      "epoch-1",
      CONVERSATION_ID,
    ];
    await waitFor(() =>
      expect(client.resetQueries).toHaveBeenCalledWith({
        queryKey: detailKey,
        exact: true,
      }),
    );
    expect(client.cancelQueries).toHaveBeenCalledWith({
      queryKey: detailKey,
      exact: true,
    });
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["helpdesk-conversations-v2"],
    });
  });

  it("discards the stale detail revision and refreshes the queue after an unassign success-decoder failure", async () => {
    admin();
    await renderHook(() => {
      const access = useHelpdeskAccess();
      return useHelpdeskAssignment(CONVERSATION_ID, access);
    });
    const mutation = queryHarness.__getLastMutationOptionsForTests();
    (mutation?.onError as (error: Error) => void)(
      new Error("strict replacement conversation response was malformed"),
    );
    const client = queryHarness.__getQueryClientForTests();
    const detail = {
      queryKey: [
        "helpdesk-conversation-v2",
        expect.any(String),
        "https://api.postwave.test",
        TENANT,
        USER,
        "admin",
        "session",
        "epoch-1",
        CONVERSATION_ID,
      ],
      exact: true,
    };
    await waitFor(() =>
      expect(client.resetQueries).toHaveBeenCalledWith(detail),
    );
    expect(client.cancelQueries).toHaveBeenCalledWith(detail);
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["helpdesk-conversations-v2"],
    });
  });
});
