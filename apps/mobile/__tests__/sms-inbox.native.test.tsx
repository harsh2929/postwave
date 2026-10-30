/**
 * SMS inbox — the triage list's render contract.
 *
 * `sms-thread` covers the conversation, `sms-policies` covers the settings;
 * nothing had mounted `app/(tabs)/sms/index.tsx`, which is the screen an
 * operator opens when a customer has TEXTED THEM BACK. The two claims pinned
 * here are the ones a phone inbox cannot get wrong:
 *
 *  1. "No conversations yet" for a FAILED fetch tells someone nobody replied
 *     to their campaign. QueryStates owns that ladder; this proves the screen
 *     actually routes through it rather than around it.
 *  2. The list must survive a payload whose `conversations` field is not a
 *     list. `conversations.data?.conversations ?? []` is a NULLISH guard, so a
 *     restored persisted cache written by an older response shape reaches
 *     FlatList's item count and the `rows.length === 0` emptiness test — and a
 *     `.length` of `undefined` makes `isEmpty` FALSE, which silently suppresses
 *     every state the ladder would otherwise render.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockConversations: { current: Record<string, unknown> } = {
  current: {},
};
const mockTriage: { current: Record<string, unknown> } = {
  current: { mutate: jest.fn(), isPending: false },
};
const mockAccess: { current: Record<string, unknown> } = {
  current: {
    identity: { fingerprint: "identity-1" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  },
};

jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsConversations: () => mockConversations.current,
  useSmsInboxAccess: () => mockAccess.current,
}));
// Lifecycle triage (snooze / archive / assign) is a mutation the screen owns;
// the sheet it opens is covered in sms-triage.native.test.tsx.
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsConversationTriage: () => mockTriage.current,
}));
jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
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

afterEach(() => {
  mockConversations.current = query({});
  mockAccess.current = {
    identity: { fingerprint: "identity-1" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  };
});

describe("sms inbox", () => {
  it("renders the conversations it was given", async () => {
    mockConversations.current = query({
      data: {
        pages: [
          {
            conversations: [
              {
                phoneE164: "+15552341111",
                identityAmbiguous: false,
                lastMessagePreview: "stop sending these",
                lastMessageAt: "2026-07-25T09:00:00Z",
                lastDirection: "inbound",
                messageCount: 3,
                unreadCount: 1,
                oldestUnreadAt: "2026-07-25T08:55:00Z",
              },
            ],
            // The page carries the identity of the request that produced it;
            // mergeSmsConversationPages compares both across pages so a
            // response from another cutoff or another filter can never be
            // spliced into the list on screen.
            tenantId: "11111111-1111-4111-8111-111111111111",
            query: { filter: "all", sort: "recent", status: "active" },
            snapshotAt: "2026-07-25T09:01:00Z",
            unreadTotal: 1,
            unknownTotal: 1,
            totalConversations: 1,
            activeTotal: 1,
            snoozedTotal: 0,
            archivedTotal: 0,
          },
        ],
        pageParams: [undefined],
      },
    });
    await renderInbox();
    expect(screen.getByText(/stop sending these/u)).toBeTruthy();
    expect(screen.getByText(/Response cutoff/u)).toBeTruthy();
    expect(screen.getByText(/newer writes may still exist/u)).toBeTruthy();
    expect(screen.queryByText(/verified snapshot/u)).toBeNull();
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("says the load FAILED rather than 'No conversations yet'", async () => {
    mockConversations.current = query({
      isError: true,
      isSuccess: false,
      error: new Error("HTTP 500"),
    });
    await renderInbox();
    expect(screen.queryByText("No conversations yet")).toBeNull();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
  });

  it("fails closed when a cached page has a non-array conversations field", async () => {
    // A `.length` of undefined makes `rows.length === 0` FALSE, so QueryStates
    // is told the list is populated and renders its children — an empty View.
    // The screen then shows a header claiming conversations and a blank body
    // with no error, no empty copy and nothing to retry.
    mockConversations.current = query({
      data: {
        pages: [
          {
            conversations: { items: [] },
            snapshotAt: "2026-07-25T09:01:00Z",
            unreadTotal: 0,
            unknownTotal: 0,
            totalConversations: 0,
            activeTotal: 0,
            snoozedTotal: 0,
            archivedTotal: 0,
          },
        ],
      },
    });
    await renderInbox();
    expect(
      screen.getByText(
        /failed its tenant, count, response-cutoff, or ordering checks/u,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No conversations returned for this response cutoff/u),
    ).toBeNull();
  });

  it("shows the lifecycle state it decodes and a reachable verb to change it", async () => {
    // Before this, `snoozeUntil`/`archivedAt`/`assigneeUserId` were parsed by
    // smsConversationWire and rendered by nothing, and the Snoozed/Archived
    // filter chips were destinations no row could be moved into.
    mockConversations.current = query({
      data: {
        pages: [
          {
            conversations: [
              {
                phoneE164: "+15552341111",
                identityAmbiguous: false,
                lastMessagePreview: "call me back",
                lastMessageAt: "2026-07-25T09:00:00Z",
                lastDirection: "inbound",
                messageCount: 3,
                unreadCount: 0,
                snoozeUntil: "2099-01-01T00:00:00Z",
                assigneeUserId: "22222222-2222-4222-8222-222222222222",
              },
            ],
            tenantId: "11111111-1111-4111-8111-111111111111",
            query: { filter: "all", sort: "recent", status: "any" },
            snapshotAt: "2026-07-25T09:01:00Z",
            unreadTotal: 0,
            unknownTotal: 0,
            totalConversations: 1,
            activeTotal: 0,
            snoozedTotal: 1,
            archivedTotal: 0,
          },
        ],
        pageParams: [undefined],
      },
    });
    await renderInbox();

    expect(screen.getByText(/^Snoozed until /u)).toBeTruthy();
    expect(screen.getByText("Assigned to a teammate")).toBeTruthy();

    const more = screen.getByLabelText(/^Triage options for /u);
    await act(async () => {
      fireEvent.press(more);
    });
    // The sheet decides its own option set from the row's stamps; a snoozed
    // conversation is offered the wake verb, not another snooze-only menu.
    expect(screen.getByLabelText("Wake now")).toBeTruthy();
  });

  it("offers no triage control when the session cannot write", async () => {
    mockAccess.current = {
      identity: { fingerprint: "identity-1" },
      roleAllowed: true,
      canRequest: false,
      online: false,
      sessionReady: true,
      denialReason: null,
    };
    mockConversations.current = query({
      data: {
        pages: [
          {
            conversations: [
              {
                phoneE164: "+15552341111",
                identityAmbiguous: false,
                lastMessagePreview: "call me back",
                lastMessageAt: "2026-07-25T09:00:00Z",
                lastDirection: "inbound",
                messageCount: 3,
                unreadCount: 0,
              },
            ],
            tenantId: "11111111-1111-4111-8111-111111111111",
            query: { filter: "all", sort: "recent", status: "active" },
            snapshotAt: "2026-07-25T09:01:00Z",
            unreadTotal: 0,
            unknownTotal: 0,
            totalConversations: 1,
            activeTotal: 1,
            snoozedTotal: 0,
            archivedTotal: 0,
          },
        ],
        pageParams: [undefined],
      },
    });
    await renderInbox();
    expect(screen.queryByLabelText(/^Triage options for /u)).toBeNull();
  });

  it("renders a no-data-request boundary for a non-admin role", async () => {
    mockAccess.current = {
      identity: null,
      roleAllowed: false,
      canRequest: false,
      online: true,
      sessionReady: true,
      denialReason: "SMS Inbox is restricted to workspace owners and admins.",
    };
    await renderInbox();
    expect(screen.getByText("SMS Inbox is restricted")).toBeTruthy();
  });
});
