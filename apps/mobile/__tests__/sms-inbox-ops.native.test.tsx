/**
 * SMS inbox — server-side search and bulk selection wiring.
 *
 * Two claims pinned here:
 *
 *  1. SEARCH IS SUBMIT-DRIVEN AND VALIDATED. A too-short query never swaps the
 *     list for the results pane (the server would 400 it); a valid submit
 *     renders the results pane against the SUBMITTED query.
 *  2. BULK CARRIES THE CAS TOKEN. Entering selection, toggling a row, and
 *     pressing a verb must hand the mutation each selected row's
 *     `stateUpdatedAt` (null when absent) — dropping it turns the server's
 *     conflict detection off for every row.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockConversations: { current: Record<string, unknown> } = {
  current: {},
};
const mockTriage: { current: Record<string, unknown> } = {
  current: { mutate: jest.fn(), isPending: false },
};
const mockBulk: { current: { mutate: jest.Mock; isPending: boolean } } = {
  current: { mutate: jest.fn(), isPending: false },
};
const mockSearch: { current: Record<string, unknown> } = {
  current: {},
};
const mockAccess: { current: Record<string, unknown> } = {
  current: {},
};

jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsConversations: () => mockConversations.current,
  useSmsInboxAccess: () => mockAccess.current,
}));
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsConversationTriage: () => mockTriage.current,
}));
jest.mock("@/hooks/useSmsInboxOps", () => ({
  useSmsBulkTriage: () => mockBulk.current,
  useSmsConversationSearch: () => mockSearch.current,
}));
jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import SmsInbox from "../app/(tabs)/sms/index";

function query(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    isLoading: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => undefined),
    refreshFirstPage: jest.fn(async () => undefined),
    fetchNextPage: jest.fn(async () => undefined),
    ...over,
  };
}

const TENANT = "11111111-1111-4111-8111-111111111111";

function conversationsData(
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    pages: [
      {
        conversations: rows,
        tenantId: TENANT,
        query: { filter: "all", sort: "recent", status: "active" },
        snapshotAt: "2026-08-21T10:01:00Z",
        unreadTotal: 0,
        unknownTotal: 0,
        totalConversations: rows.length,
        activeTotal: rows.length,
        snoozedTotal: 0,
        archivedTotal: 0,
      },
    ],
    pageParams: [undefined],
  };
}

function row(phone: string, over: Record<string, unknown> = {}) {
  return {
    phoneE164: phone,
    identityAmbiguous: false,
    lastMessagePreview: "please call me back",
    lastMessageAt: "2026-08-21T09:00:00Z",
    lastDirection: "inbound",
    messageCount: 2,
    unreadCount: 0,
    ...over,
  };
}

async function renderInbox() {
  return render(<SmsInbox />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

function resetMocks() {
  mockConversations.current = query({});
  mockSearch.current = query({});
  mockBulk.current = { mutate: jest.fn(), isPending: false };
  mockAccess.current = {
    identity: {
      fingerprint: "identity-1",
      userId: "22222222-2222-4222-8222-222222222222",
      tenantId: TENANT,
    },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  };
}
resetMocks();
afterEach(resetMocks);

describe("sms inbox search", () => {
  it("refuses a too-short query with the validation sentence, in place", async () => {
    mockConversations.current = query({
      data: conversationsData([row("+15552341111")]),
    });
    await renderInbox();
    const field = screen.getByLabelText("Search conversations on the server");
    await fireEvent.changeText(field, "ab");
    await fireEvent(field, "submitEditing");
    expect(
      screen.getByText(
        "Type at least 3 characters to search message text, phone, or email.",
      ),
    ).toBeTruthy();
    // Still the list, not the results pane.
    expect(screen.getByText(/please call me back/u)).toBeTruthy();
  });

  it("renders server matches for a submitted query", async () => {
    mockConversations.current = query({
      data: conversationsData([row("+15552341111")]),
    });
    mockSearch.current = query({
      data: {
        pages: [
          {
            tenantId: TENANT,
            conversations: [
              row("+15552342222", { lastMessagePreview: "refund order 1042" }),
            ],
            snapshotAt: "2026-08-21T10:00:00Z",
          },
        ],
        pageParams: [undefined],
      },
    });
    await renderInbox();
    const field = screen.getByLabelText("Search conversations on the server");
    await fireEvent.changeText(field, "refund");
    await fireEvent(field, "submitEditing");
    expect(screen.getByText(/refund order 1042/u)).toBeTruthy();
    expect(screen.getByText(/1 match shown/u)).toBeTruthy();
    // The filtered list's row is gone while searching.
    expect(screen.queryByText(/please call me back/u)).toBeNull();
  });
});

describe("sms inbox bulk selection", () => {
  it("selects rows and hands the mutation each row's CAS token", async () => {
    mockConversations.current = query({
      data: conversationsData([
        row("+15552341111", { stateUpdatedAt: "2026-08-20T10:00:00Z" }),
        row("+15552342222"),
      ]),
    });
    await renderInbox();
    await fireEvent.press(
      screen.getByLabelText("Select conversations for a bulk action"),
    );
    await fireEvent.press(
      screen.getByLabelText(/Select conversation with \+15552341111/u),
    );
    await fireEvent.press(
      screen.getByLabelText(/Select conversation with \+15552342222/u),
    );
    expect(screen.getByText("2 selected")).toBeTruthy();
    await fireEvent.press(
      screen.getByLabelText(/Archive, applies to 2 selected conversations/u),
    );
    expect(mockBulk.current.mutate).toHaveBeenCalledTimes(1);
    const intent = mockBulk.current.mutate.mock.calls[0]?.[0] as {
      conversations: { phoneE164: string; expectedUpdatedAt: string | null }[];
      action: string;
    };
    expect(intent.action).toBe("archive");
    expect(intent.conversations).toEqual([
      {
        phoneE164: "+15552341111",
        expectedUpdatedAt: "2026-08-20T10:00:00Z",
      },
      { phoneE164: "+15552342222", expectedUpdatedAt: null },
    ]);
  });

  it("exits selection mode without applying anything", async () => {
    mockConversations.current = query({
      data: conversationsData([row("+15552341111")]),
    });
    await renderInbox();
    await fireEvent.press(
      screen.getByLabelText("Select conversations for a bulk action"),
    );
    await fireEvent.press(screen.getByLabelText("Exit selection"));
    expect(screen.queryByText(/selected/u)).toBeNull();
    expect(mockBulk.current.mutate).not.toHaveBeenCalled();
  });
});
