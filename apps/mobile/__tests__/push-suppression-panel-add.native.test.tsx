/**
 * The push add-by-token verb at the PANEL seam — what the phone offers, to
 * whom, and what happens after a submit.
 *
 * push-suppression-add.native.test.tsx pins the sheet's own validation; the
 * hook test pins the transport. What neither covers: the affordance's
 * accessible NAME (it shipped as "Add" — a screen reader heard a verb with
 * no object), that it hides where the write could only refuse (offline, or
 * below the exact-admin boundary), that a press opens the sheet, and that a
 * confirmed write closes it while a failed one leaves it open with the
 * failure said aloud.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PushSuppressionsPanel } from "../src/components/deliverability/PushSuppressionsPanel";
import { ToastProvider } from "../src/components/Toast";

const themeMock = require("./mocks/theme.cjs");
const tokens = themeMock.useTheme().t;

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/usePushSuppressions", () =>
  require("./mocks/queryHooks.cjs"),
);

const TENANT = "11111111-1111-4111-8111-111111111111";
const OPEN_LABEL = "Suppress a device token";
const SUBMIT_LABEL = "Suppress this device token";
const TOKEN = "f".repeat(64);

function accessResult(over: Record<string, unknown> = {}) {
  return {
    identity: {
      baseUrl: "https://api.moosewave.com",
      tenantId: TENANT,
      userId: "22222222-2222-4222-8222-222222222222",
      effectiveRole: "owner",
      mode: "session",
      contextEpoch: null,
      fingerprint: "push-panel-add-test",
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
        {
          tenantId: TENANT,
          items: [],
          total: 0,
          snapshotAt: "2026-09-02T10:00:00.000Z",
        },
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

type AddCallbacks = {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
};

function arm(
  access: ReturnType<typeof accessResult>,
  add: ReturnType<typeof mutationResult> = mutationResult(),
) {
  queryHooks.__setHookResultForTests("usePushSuppressionAccess", access);
  queryHooks.__setHookResultForTests("usePushSuppressions", emptyQuery());
  queryHooks.__setHookResultForTests("useRemovePushSuppression", mutationResult());
  queryHooks.__setHookResultForTests("useAddPushSuppression", add);
  return add;
}

async function renderPanel() {
  return render(
    React.createElement(
      ToastProvider,
      null,
      <PushSuppressionsPanel
        platform="all"
        onPlatformChange={() => undefined}
        now={Date.now()}
        t={tokens}
      />,
    ),
    {
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
    },
  );
}

/** Open the sheet, paste a valid token, and press submit. */
async function submitToken(screen: Awaited<ReturnType<typeof renderPanel>>) {
  fireEvent.press(screen.getByLabelText(OPEN_LABEL));
  const input = await screen.findByLabelText("Device token to suppress");
  fireEvent.changeText(input, TOKEN);
  // Each event must COMMIT before the next handler closes over its state.
  await waitFor(() =>
    expect(screen.getByLabelText("Device token to suppress").props.value).toBe(
      TOKEN,
    ),
  );
  fireEvent.press(screen.getByLabelText(SUBMIT_LABEL));
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
});

describe("the affordance", () => {
  it("is named for what it does and opens the sheet", async () => {
    arm(accessResult());
    const screen = await renderPanel();
    const open = screen.getByLabelText(OPEN_LABEL);
    expect(open.props.accessibilityRole).toBe("button");
    // The sheet is not mounted until asked for.
    expect(screen.queryByLabelText(SUBMIT_LABEL)).toBeNull();
    fireEvent.press(open);
    expect(await screen.findByLabelText(SUBMIT_LABEL)).toBeTruthy();
  });

  it("hides offline instead of offering a write that is never queued", async () => {
    arm(accessResult({ online: false, canRequest: false }));
    const screen = await renderPanel();
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull();
    expect(screen.getByText(/You're offline/u)).toBeTruthy();
  });

  it("is withheld below the exact-admin boundary, with the denial said verbatim", async () => {
    const denial =
      "The customer push registry is restricted to workspace owners and admins.";
    arm(
      accessResult({
        roleAllowed: false,
        canRequest: false,
        denialReason: denial,
      }),
    );
    const screen = await renderPanel();
    expect(screen.getByText(denial)).toBeTruthy();
    expect(screen.queryByLabelText(OPEN_LABEL)).toBeNull();
  });
});

describe("the submit", () => {
  it("hands the pasted token and the picked platform to the add mutation", async () => {
    const add = arm(accessResult());
    const screen = await renderPanel();
    await submitToken(screen);
    await waitFor(() =>
      expect(add.mutate).toHaveBeenCalledWith(
        { deviceToken: TOKEN, platform: "apns" },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        }),
      ),
    );
  });

  it("closes the sheet and reports the hold once the registry confirms", async () => {
    const add = arm(
      accessResult(),
      mutationResult({
        mutate: jest.fn((_input: unknown, callbacks?: AddCallbacks) =>
          callbacks?.onSuccess?.(),
        ),
      }),
    );
    const screen = await renderPanel();
    await submitToken(screen);
    await waitFor(() => expect(add.mutate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByLabelText(SUBMIT_LABEL)).toBeNull(),
    );
    expect(
      await screen.findByText(/Manual hold recorded for this device/u),
    ).toBeTruthy();
  });

  it("keeps the sheet open and says the server's sentence when the write fails", async () => {
    const serverSentence = "device_token must not contain whitespace or control characters";
    const add = arm(
      accessResult(),
      mutationResult({
        mutate: jest.fn((_input: unknown, callbacks?: AddCallbacks) =>
          callbacks?.onError?.(
            Object.assign(new Error(serverSentence), { status: 422 }),
          ),
        ),
      }),
    );
    const screen = await renderPanel();
    await submitToken(screen);
    await waitFor(() => expect(add.mutate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(serverSentence)).toBeTruthy();
    // Still open: the operator can correct the paste.
    expect(screen.getByLabelText(SUBMIT_LABEL)).toBeTruthy();
  });
});
