/**
 * The push add-by-token verb at the rendered seam.
 *
 * The hook tests pin the transport contract; these pin what the phone OFFERS:
 * the exact-admin panel carries the affordance (replacing the old "desktop
 * only" caption), and the sheet refuses a bad paste with the byte rule's own
 * sentence instead of a request that can only 422.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PushSuppressionAddSheet } from "../src/components/deliverability/PushSuppressionAddSheet";
import { PushSuppressionsPanel } from "../src/components/deliverability/PushSuppressionsPanel";
import { ToastProvider } from "../src/components/Toast";

const themeMock = require("./mocks/theme.cjs");
const tokens = themeMock.useTheme().t;

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/usePushSuppressions", () =>
  require("./mocks/queryHooks.cjs"),
);

const TENANT = "11111111-1111-4111-8111-111111111111";

function accessResult(over: Record<string, unknown> = {}) {
  return {
    identity: {
      baseUrl: "https://api.moosewave.com",
      tenantId: TENANT,
      userId: "22222222-2222-4222-8222-222222222222",
      effectiveRole: "owner",
      mode: "session",
      contextEpoch: null,
      fingerprint: "push-add-test",
    },
    roleAllowed: true,
    canRequest: true,
    online: true,
    sessionReady: true,
    denialReason: null,
    ...over,
  };
}

function emptyQuery() {
  return {
    data: {
      pages: [
        { tenantId: TENANT, items: [], total: 0, snapshotAt: "2026-08-29T10:00:00.000Z" },
      ],
    },
    isSuccess: true,
    isFetching: false,
    isError: false,
    isLoading: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => undefined),
    access: accessResult(),
  };
}

function mutationResult(over: Record<string, unknown> = {}) {
  return {
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    ...over,
  };
}

async function renderWithin(element: React.ReactElement) {
  return render(React.createElement(ToastProvider, null, element), {
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
  queryHooks.__resetHookResultsForTests();
});

describe("the panel offers the add verb", () => {
  it("renders the affordance for an exact-admin session", async () => {
    queryHooks.__setHookResultForTests("usePushSuppressionAccess", accessResult());
    queryHooks.__setHookResultForTests("usePushSuppressions", emptyQuery());
    queryHooks.__setHookResultForTests("useRemovePushSuppression", mutationResult());
    queryHooks.__setHookResultForTests("useAddPushSuppression", mutationResult());
    const screen = await renderWithin(
      <PushSuppressionsPanel
        platform="all"
        onPlatformChange={() => undefined}
        now={Date.now()}
        t={tokens}
      />,
    );
    expect(screen.getByLabelText("Suppress a device token")).toBeTruthy();
    // The stale desktop-only caption is gone with the gap it described.
    expect(screen.queryByText(/available in the desktop admin/u)).toBeNull();
  });
});

describe("PushSuppressionAddSheet", () => {
  it("refuses a bad paste with the byte rule's sentence, before any submit", async () => {
    const onSubmit = jest.fn();
    const screen = await renderWithin(
      <PushSuppressionAddSheet
        visible
        submitting={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.changeText(
      screen.getByLabelText("Device token to suppress"),
      "too-short",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Device token to suppress").props.value,
      ).toBe("too-short"),
    );
    fireEvent.press(screen.getByLabelText("Suppress this device token"));
    expect(
      await screen.findByText(/20–4096 bytes; paste the full token/u),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a valid token with the picked platform", async () => {
    const onSubmit = jest.fn();
    const token = "c".repeat(64);
    const screen = await renderWithin(
      <PushSuppressionAddSheet
        visible
        submitting={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.changeText(
      screen.getByLabelText("Device token to suppress"),
      `  ${token}  `,
    );
    // Each event must COMMIT before the next handler closes over its state —
    // this RTL version does not flush between synchronous fireEvent calls.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Device token to suppress").props.value,
      ).toContain(token),
    );
    fireEvent.press(screen.getByLabelText("FCM"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("FCM").props.accessibilityState?.selected,
      ).toBe(true),
    );
    fireEvent.press(screen.getByLabelText("Suppress this device token"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        deviceToken: token,
        platform: "fcm",
      }),
    );
  });
});
