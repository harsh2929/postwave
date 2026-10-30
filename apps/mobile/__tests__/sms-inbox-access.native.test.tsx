import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";

import * as Gate from "@/hooks/useOnlineQueryGate";
import { observeContextEpoch, resetContextEpoch } from "@/lib/contextEpoch";
import * as Auth from "@/store/auth";

const mockListConversations = jest.fn();
const mockListMessages = jest.fn();
const PHONE = "+15552345678";

jest.mock("@/api/smsInbox", () => ({
  listConversations: (input: unknown) => mockListConversations(input),
  listConversationMessages: (input: unknown) => mockListMessages(input),
  getConversationContext: jest.fn(),
  listSmsSenders: jest.fn(),
  markConversationRead: jest.fn(),
  replyToConversation: jest.fn(),
}));

import {
  SMS_CONVERSATIONS_KEY,
  SMS_INBOX_POLL_MS,
  useSmsConversations,
  useSmsInboxAccess,
  useSmsThread,
} from "@/hooks/useSmsInbox";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __getQueryOptionsForTests: () => Array<{
    kind: string;
    options: Record<string, unknown>;
  }>;
  __getQueryClientForTests: () => {
    cancelQueries: jest.Mock;
    removeQueries: jest.Mock;
    setQueryData: jest.Mock;
    getQueryData: jest.Mock;
  };
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __setIsOnlineForTests: (value: boolean) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = Auth as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

function adminIdentity(over: Record<string, unknown> = {}) {
  gateHarness.__setOnlineGateForTests({
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "tenant-1",
    userId: "user-1",
    effectiveRole: "admin",
    ...over,
  });
  authHarness.__setAuthStateForTests({
    baseUrl: "https://api.postwave.test",
    tenantId: "tenant-1",
    mode: "session",
    session: {
      tenantId: "tenant-1",
      userId: "user-1",
      role: "admin",
      effectiveRole: "admin",
      ...(over.session as Record<string, unknown> | undefined),
    },
  });
}

afterEach(() => {
  jest.useRealTimers();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
  mockListConversations.mockReset();
  mockListMessages.mockReset();
  queryHarness.__getQueryClientForTests().getQueryData.mockReset();
  resetContextEpoch();
});

describe("SMS admin and identity gate", () => {
  it("viewer and API-key deep links configure a disabled query and make zero requests", async () => {
    gateHarness.__setOnlineGateForTests({
      enabled: true,
      baseUrl: "https://api.postwave.test",
      tenantId: "tenant-1",
      userId: "viewer-1",
      effectiveRole: "viewer",
    });
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { userId: "viewer-1", role: "viewer", effectiveRole: "viewer" },
    });
    const first = await renderHook(() => {
      const access = useSmsInboxAccess();
      useSmsConversations("all", access);
      return access;
    });
    expect(first.result.current.roleAllowed).toBe(false);
    expect(queryHarness.__getQueryOptionsForTests()[0]?.options.enabled).toBe(
      false,
    );
    expect(mockListConversations).not.toHaveBeenCalled();
    await first.unmount();

    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    authHarness.__setAuthStateForTests({ mode: "api_key", session: null });
    const second = await renderHook(() => {
      const access = useSmsInboxAccess();
      useSmsConversations("all", access);
      return access;
    });
    expect(second.result.current.roleAllowed).toBe(false);
    expect(mockListConversations).not.toHaveBeenCalled();
    await second.unmount();
  });

  it("passes TanStack's AbortSignal into the HTTP boundary", async () => {
    adminIdentity();
    const pending = new Promise((_, reject) => {
      mockListConversations.mockImplementation((input: unknown) => {
        const request = input as { signal: AbortSignal };
        request.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
        return pending;
      });
    });
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsConversations("all", access);
    });
    const options = queryHarness
      .__getQueryOptionsForTests()
      .find((entry) => entry.kind === "infinite")?.options;
    const controller = new AbortController();
    const result = (
      options?.queryFn as (input: {
        pageParam: undefined;
        signal: AbortSignal;
      }) => Promise<unknown>
    )({ pageParam: undefined, signal: controller.signal });
    expect(
      (mockListConversations.mock.calls[0]?.[0] as { signal: AbortSignal })
        .signal,
    ).toBe(controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await hook.unmount();
  });

  it("polls a one-page focused inbox head and aborts on exit", async () => {
    jest.useFakeTimers();
    adminIdentity();
    const head = {
      tenantId: "tenant-1",
      conversations: [],
      snapshotAt: "2026-08-21T10:00:00Z",
      unreadTotal: 0,
      unknownTotal: 0,
      totalConversations: 0,
      activeTotal: 0,
      snoozedTotal: 0,
      archivedTotal: 0,
    };
    let signal: AbortSignal | undefined;
    mockListConversations.mockImplementation(async (input: unknown) => {
      signal = (input as { signal: AbortSignal }).signal;
      return head;
    });
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsConversations("all", access);
    });
    const client = queryHarness.__getQueryClientForTests();
    client.getQueryData.mockReturnValue({
      pages: [head],
      pageParams: [undefined],
    });

    await act(async () => {
      jest.advanceTimersByTime(SMS_INBOX_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockListConversations).toHaveBeenCalledTimes(1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(client.setQueryData).toHaveBeenCalledWith(
      expect.arrayContaining([SMS_CONVERSATIONS_KEY]),
      { pages: [head], pageParams: [undefined] },
    );

    mockListConversations.mockImplementationOnce(
      (input: unknown) =>
        new Promise((_resolve, reject) => {
          signal = (input as { signal: AbortSignal }).signal;
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    await act(async () => {
      jest.advanceTimersByTime(SMS_INBOX_POLL_MS);
      await Promise.resolve();
    });
    await hook.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("pauses polling without losing or cross-merging two loaded conversation pages", async () => {
    jest.useFakeTimers();
    adminIdentity();
    const first = { marker: "head" };
    const second = { marker: "continuation" };
    const loaded = {
      pages: [first, second],
      pageParams: [undefined, "opaque-cursor"],
    };
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsConversations("all", access);
    });
    const client = queryHarness.__getQueryClientForTests();
    client.getQueryData.mockReturnValue(loaded);
    client.setQueryData.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(SMS_INBOX_POLL_MS);
      await Promise.resolve();
    });

    expect(mockListConversations).not.toHaveBeenCalled();
    expect(client.setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData.mock.results.at(-1)?.value).toBe(loaded);
    expect(hook.result.current.pollState).toBe("restart_required");
    await hook.unmount();
  });

  it("cancels and retires protected cache on demotion, tenant/user move, or epoch move", async () => {
    adminIdentity();
    observeContextEpoch("epoch-1");
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      useSmsConversations("all", access);
      return access;
    });
    const client = queryHarness.__getQueryClientForTests();

    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    authHarness.__setAuthStateForTests({
      session: { role: "viewer", effectiveRole: "viewer" },
    });
    await hook.rerender({});
    await waitFor(() => expect(client.removeQueries).toHaveBeenCalled());

    adminIdentity({
      tenantId: "tenant-2",
      userId: "user-2",
      session: {
        tenantId: "tenant-2",
        userId: "user-2",
      },
    });
    await hook.rerender({});
    await waitFor(() => expect(client.cancelQueries).toHaveBeenCalled());

    await act(async () => {
      observeContextEpoch("epoch-2");
    });
    await waitFor(() =>
      expect(client.removeQueries.mock.calls.length).toBeGreaterThan(1),
    );
    const lastRemove = client.removeQueries.mock.calls.at(-1)?.[0] as
      | { predicate?: (query: { queryKey: readonly unknown[] }) => boolean }
      | undefined;
    const predicate = lastRemove?.predicate as
      | ((query: { queryKey: readonly unknown[] }) => boolean)
      | undefined;
    expect(predicate?.({ queryKey: [SMS_CONVERSATIONS_KEY, "retired"] })).toBe(
      true,
    );
    await hook.unmount();
  });

  it("aborts the exact thread request and removes its PII cache on unmount", async () => {
    adminIdentity();
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsThread(PHONE, access);
    });
    const client = queryHarness.__getQueryClientForTests();
    await hook.unmount();
    expect(client.cancelQueries).toHaveBeenCalledWith(
      expect.objectContaining({ exact: true }),
    );
    expect(client.removeQueries).toHaveBeenCalledWith(
      expect.objectContaining({ exact: true }),
    );
  });
});
