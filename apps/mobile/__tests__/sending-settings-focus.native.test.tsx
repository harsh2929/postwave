import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * PERF-1 — the sending-settings screen hands its FOCUS to the status poll.
 *
 * sending-settings is a hidden Tabs.Screen, and Expo Router keeps a visited tab
 * mounted, so a status hook that ignored focus polled
 * GET /api/v1/settings/sending/status every 30 seconds for the rest of the
 * session after a single visit.
 *
 * useSendingOps.test.ts pins the hook half: a blurred observer issues zero GETs
 * over five minutes in a real QueryObserver. This pins the link that test
 * cannot see: the screen's controller must pass the focus it actually has.
 * sending-settings.native.test.tsx mocks the hook with a function that ignores
 * its arguments, so nothing there notices a controller that drops the focus or
 * passes a constant.
 */

// Focus is a per-test fact here, not a constant: the route mock answers `true`
// forever, which is exactly the condition under which the bug is invisible.
// Boxed so the hoisted factory can read it (jest lets only `mock`-prefixed
// names through the hoist).
const mockFocus = { value: true };
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as Record<string, unknown>),
  useIsFocused: () => mockFocus.value,
}));

/** Every argument the screen handed `useSendingStatus`, in render order. */
const mockStatusArgs: unknown[] = [];

// The hooks' real return shapes: useSendingSettings is a SnapshotBacked
// envelope, so the loaded branch (not the error ladder) is what renders.
const mockSettings = {
  data: {
    value: { max_sends_per_hour: null },
    fromSnapshot: false,
    capturedAt: null,
  },
  isLoading: false,
  isError: false,
  error: null,
  refetch: async () => undefined,
};
const mockStatus = {
  data: undefined,
  isError: false,
  refetch: async () => undefined,
};

jest.mock("@/hooks/useSendingOps", () => ({
  useSendingSettings: () => mockSettings,
  useSendingStatus: (args: unknown) => {
    mockStatusArgs.push(args);
    return mockStatus;
  },
  useUpdateSendingSettings: () => ({
    mutateAsync: async () => ({ kind: "applied" }),
    reconcileAsync: async () => ({ kind: "pending", message: "" }),
    isPending: false,
  }),
  CLEARED_SENDING_SETTINGS: {
    max_sends_per_hour: null,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: true,
  },
}));

// eslint-disable-next-line import/first
import SendingSettings from "../app/(tabs)/sending-settings";

async function renderScreen() {
  return await render(React.createElement(SendingSettings), {
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
  mockFocus.value = true;
  mockStatusArgs.length = 0;
});

describe("sending settings — the status poll follows the tab's focus", () => {
  it("tells the status hook it is blurred when the tab is not on top", async () => {
    mockFocus.value = false;
    const screen = await renderScreen();

    // The loaded branch rendered, so the hook call below is the real one and
    // not an early-return path that never reached the controller.
    expect(screen.getByText("No workspace ceiling")).toBeTruthy();
    expect(mockStatusArgs.length).toBeGreaterThan(0);
    expect(mockStatusArgs.at(-1)).toEqual({ focused: false });
  });

  it("tells the status hook it is focused while the tab is on top", async () => {
    const screen = await renderScreen();

    expect(screen.getByText("No workspace ceiling")).toBeTruthy();
    expect(mockStatusArgs.at(-1)).toEqual({ focused: true });
  });
});
