/**
 * The 10s SMS thread poll must not blank the conversation being read.
 *
 * `useSmsThread` is an infinite query whose first page is the NEWEST messages
 * and whose later pages are the history the reader pulls in with "Load older".
 * The poll used to call `resetQueries`, which throws a query back to its
 * initial state: on every tick the open thread went empty, the "Load older"
 * pages were discarded, and the list re-rendered from scratch under the
 * reader's thumb. Ten seconds later it happened again.
 *
 * Invalidation is the poll a thread wants: the cached pages stay in place and
 * on screen while the refetch runs against them.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";

import * as Gate from "@/hooks/useOnlineQueryGate";
import { resetContextEpoch } from "@/lib/contextEpoch";
import * as Auth from "@/store/auth";

jest.mock("@/api/smsInbox", () => ({
  listConversations: jest.fn(),
  listConversationMessages: jest.fn(),
  getConversationContext: jest.fn(),
  listSmsSenders: jest.fn(),
  markConversationRead: jest.fn(),
  replyToConversation: jest.fn(),
}));

// eslint-disable-next-line import/first -- must follow the api mock.
import { listConversationMessages } from "@/api/smsInbox";
// eslint-disable-next-line import/first -- must follow the api mock.
import {
  SMS_THREAD_KEY,
  useSmsInboxAccess,
  useSmsThread,
} from "@/hooks/useSmsInbox";

const PHONE = "+15552345678";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __getQueryClientForTests: () => {
    invalidateQueries: jest.Mock;
    resetQueries: jest.Mock;
    removeQueries: jest.Mock;
    cancelQueries: jest.Mock;
    getQueryData: jest.Mock;
    setQueryData: jest.Mock;
  };
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = Auth as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

function adminIdentity() {
  gateHarness.__setOnlineGateForTests({
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "tenant-1",
    userId: "user-1",
    effectiveRole: "admin",
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
    },
  });
}

afterEach(() => {
  jest.useRealTimers();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
  resetContextEpoch();
  queryHarness.__getQueryClientForTests().getQueryData.mockReset();
});

describe("SMS thread poll", () => {
  it("refreshes a one-page open thread with one head request per tick", async () => {
    jest.useFakeTimers();
    adminIdentity();
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsThread(PHONE, access);
    });
    const client = queryHarness.__getQueryClientForTests();
    client.getQueryData.mockReturnValue(undefined);
    client.invalidateQueries.mockClear();
    client.resetQueries.mockClear();
    // The mount fetch is not a poll tick; count only what the interval does.
    (listConversationMessages as jest.Mock).mockClear();
    (
      listConversationMessages as unknown as jest.Mock<
        () => Promise<{ messages: unknown[]; nextCursor: string | undefined }>
      >
    ).mockResolvedValue({ messages: [], nextCursor: undefined });

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    // ONE REQUEST PER TICK, AT ANY SCROLL DEPTH.
    //
    // resetQueries emptied the thread. invalidateQueries fixed that and broke
    // something else: invalidating an ACTIVE infinite query refetches EVERY
    // loaded page, so a reader four pulls into a thread would issue five
    // requests every ten seconds on cellular. Only page one can hold new
    // messages -- getNextPageParam walks backwards through history -- so the
    // poll fetches exactly that page and splices it over the head of the
    // cache.
    expect(client.resetQueries).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    expect(listConversationMessages).toHaveBeenCalledTimes(1);
    // Page one means NO cursor. A cursor here would be fetching history, not
    // new messages.
    expect(listConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: PHONE, tenantId: "tenant-1" }),
    );
    expect(
      (listConversationMessages as unknown as jest.Mock).mock.calls[0]?.[0],
    ).not.toHaveProperty("cursor");

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    // Still exactly one per tick -- the count tracks ticks, not pages.
    expect(listConversationMessages).toHaveBeenCalledTimes(2);
    expect(client.resetQueries).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    jest.useRealTimers();
    await hook.unmount();
  });

  it("pauses without a request when two message pages are loaded", async () => {
    jest.useFakeTimers();
    adminIdentity();
    const loaded = {
      pages: [{ marker: "head" }, { marker: "older" }],
      pageParams: [undefined, "opaque-cursor"],
    };
    const hook = await renderHook(() => {
      const access = useSmsInboxAccess();
      return useSmsThread(PHONE, access);
    });
    const client = queryHarness.__getQueryClientForTests();
    client.getQueryData.mockReturnValue(loaded);
    client.setQueryData.mockClear();
    (listConversationMessages as jest.Mock).mockClear();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(listConversationMessages).not.toHaveBeenCalled();
    expect(client.setQueryData).not.toHaveBeenCalled();
    expect(client.getQueryData.mock.results.at(-1)?.value).toBe(loaded);
    expect(hook.result.current.pollState).toBe("restart_required");
    await hook.unmount();
  });
});
