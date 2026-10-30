/**
 * SMS inbox reply-hold roll-up — banner wiring.
 *
 * Claims pinned:
 *  1. A held intent matched to a VISIBLE row renders the named warning and
 *     tapping it opens that thread.
 *  2. A storage failure renders the danger sentence (sending stays locked).
 *  3. No hold → no banner.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockHolds: {
  current: { summary: Record<string, unknown>; matchedPhone: string | null };
} = { current: { summary: { status: "none" }, matchedPhone: null } };

jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsConversations: () => ({
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
  }),
  useSmsInboxAccess: () => ({
    identity: { fingerprint: "identity-1", tenantId: "t", userId: "u" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  }),
}));
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsConversationTriage: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/hooks/useSmsInboxOps", () => ({
  useSmsBulkTriage: () => ({ mutate: jest.fn(), isPending: false }),
  useSmsConversationSearch: () => ({
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    isLoading: false,
    isSuccess: true,
    fetchNextPage: jest.fn(async () => undefined),
  }),
}));
jest.mock("@/hooks/useSmsReplyHolds", () => ({
  useSmsReplyHolds: () => mockHolds.current,
}));
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import SmsInbox from "../app/(tabs)/sms/index";

const expoRouter = require("./mocks/expoRouter.cjs") as {
  router: { push: jest.Mock };
};

afterEach(() => {
  mockHolds.current = { summary: { status: "none" }, matchedPhone: null };
});

async function renderInbox() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <SmsInbox />
    </SafeAreaProvider>,
  );
}

describe("sms inbox reply-hold banner", () => {
  it("renders nothing when no hold exists", async () => {
    await renderInbox();
    expect(screen.queryByText(/reply safeguard/u)).toBeNull();
  });

  it("names the held conversation and opens its thread on press", async () => {
    mockHolds.current = {
      summary: {
        status: "held",
        state: "reconciliation_required",
        threadHash: "a".repeat(64),
        createdAt: "2026-08-21T09:00:00Z",
      },
      matchedPhone: "+15552345678",
    };
    await renderInbox();
    expect(
      screen.getByText(/unresolved reply safeguard is held on the conversation with \+15552345678/u),
    ).toBeTruthy();
    await fireEvent.press(
      screen.getByLabelText("Open the held conversation with +15552345678"),
    );
    expect(expoRouter.router.push).toHaveBeenCalledWith(
      "/(tabs)/sms/%2B15552345678",
    );
  });

  it("renders the danger sentence when the safeguard cannot be verified", async () => {
    mockHolds.current = {
      summary: { status: "storage_unavailable" },
      matchedPhone: null,
    };
    await renderInbox();
    expect(
      screen.getByText(/encrypted reply-intent safeguard could not be verified/u),
    ).toBeTruthy();
  });
});
