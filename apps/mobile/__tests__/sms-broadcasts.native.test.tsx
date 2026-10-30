/**
 * SMS broadcasts — draft management wiring.
 *
 * Claims pinned:
 *  1. The release-hold banner renders from the LIST RESPONSE's own
 *     availability bit — and no Send control exists anywhere on the screen.
 *  2. Creating hands the mutation the trimmed draft.
 *  3. Editing a broadcast that already targets lists disables tag authoring
 *     in favor of the desktop caption (one-audience-dimension rule).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockList: { current: Record<string, unknown> } = { current: {} };
const mockWrites: { current: { mutate: jest.Mock; isPending: boolean } } = {
  current: { mutate: jest.fn(), isPending: false },
};
const mockAccess: { current: Record<string, unknown> } = { current: {} };

jest.mock("@/hooks/useSmsBroadcasts", () => ({
  useSmsBroadcasts: () => mockList.current,
  useSmsBroadcastWrites: () => mockWrites.current,
  useSmsBroadcastProgress: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
}));
jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsInboxAccess: () => mockAccess.current,
}));

/* eslint-disable import/first -- must follow the hook mocks. */
import { ConfirmProvider } from "@/components/ConfirmSheet";
import BroadcastsRoute from "../app/(tabs)/sms/broadcasts";
/* eslint-enable import/first */

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const LIST = "55555555-5555-4555-8555-555555555555";

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
    fetchNextPage: jest.fn(async () => undefined),
    ...over,
  };
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "August promo",
    body: "20% off this week",
    status: "draft",
    listIds: [],
    sentCount: 0,
    failedCount: 0,
    heldCount: 0,
    segmentsPerMessage: 1,
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-21T09:00:00Z",
    ...over,
  };
}

function pageData(
  items: Record<string, unknown>[],
  reason: string | undefined = "sms_broadcast_dispatch_release_held",
) {
  return {
    pages: [
      {
        tenantId: TENANT,
        items,
        snapshotAt: "2026-08-21T10:00:00Z",
        dispatchAvailable: false,
        ...(reason ? { dispatchUnavailableReason: reason } : {}),
      },
    ],
    pageParams: [undefined],
  };
}

function resetMocks() {
  mockList.current = query({ data: pageData([item()]) });
  mockWrites.current = { mutate: jest.fn(), isPending: false };
  mockAccess.current = {
    identity: { fingerprint: "identity-1", tenantId: TENANT, userId: "u" },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
  };
}
resetMocks();
afterEach(resetMocks);

async function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>
        <BroadcastsRoute />
      </ConfirmProvider>
    </SafeAreaProvider>,
  );
}

describe("sms broadcasts", () => {
  it("renders drafts with the release-hold banner and no Send control", async () => {
    await renderScreen();
    expect(screen.getByText(/August promo/u)).toBeTruthy();
    expect(
      screen.getByText(/Broadcast dispatch is release-held server-side/u),
    ).toBeTruthy();
    expect(screen.queryByText(/^Send$/u)).toBeNull();
    expect(screen.queryByLabelText(/Send broadcast/u)).toBeNull();
  });

  it("never prints the server's reason code into the banner", async () => {
    // The fallback branch used to interpolate the raw reason —
    // "Broadcast dispatch is unavailable (some_code); drafts remain editable."
    // — so any hold the app does not recognise showed an operator an internal
    // identifier. Both branches are now code-free; the code is kept on the
    // banner as a diagnostic testID instead.
    mockList.current = query({
      data: pageData([item()], "provider_account_suspended"),
    });
    await renderScreen();

    expect(screen.queryByText(/provider_account_suspended/u)).toBeNull();
    expect(screen.queryByText(/unknown reason/u)).toBeNull();
    expect(
      screen.getByText(/Broadcast dispatch is unavailable right now/u),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        "sms-broadcast-dispatch-hold-provider_account_suspended",
      ),
    ).toBeTruthy();
  });

  it("creates a trimmed draft", async () => {
    await renderScreen();
    await fireEvent.press(screen.getByLabelText("New broadcast draft"));
    await fireEvent.changeText(
      screen.getByLabelText("Broadcast name"),
      "  Flash sale  ",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Broadcast message"),
      "Today only",
    );
    await fireEvent.changeText(screen.getByLabelText("Audience tag"), "vip");
    await fireEvent.press(screen.getByLabelText("Create broadcast draft"));
    expect(mockWrites.current.mutate.mock.calls[0]?.[0]).toEqual({
      action: "create",
      draft: { name: "Flash sale", body: "Today only", tag: "vip" },
    });
  });

  it("locks tag authoring when a list audience already exists", async () => {
    mockList.current = query({
      data: pageData([item({ listIds: [LIST] })]),
    });
    await renderScreen();
    await fireEvent.press(
      screen.getByLabelText("Edit broadcast August promo"),
    );
    expect(screen.queryByLabelText("Audience tag")).toBeNull();
    expect(
      screen.getByText(/list and segment audiences are managed from desktop/u),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText("Broadcast message"),
      "Updated copy",
    );
    await fireEvent.press(screen.getByLabelText("Save broadcast draft"));
    const intent = mockWrites.current.mutate.mock.calls[0]?.[0] as {
      action: string;
      draft: Record<string, unknown>;
    };
    expect(intent.action).toBe("update");
    expect(intent.draft).toEqual({ name: "August promo", body: "Updated copy" });
  });
});
