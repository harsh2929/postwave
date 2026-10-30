import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CommerceScreen } from "../src/components/commerce/CommerceScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useCommerce", () => require("./mocks/queryHooks.cjs"));

/**
 * P1.7 pause / P2.37 disconnect — the two administrative writes on a store
 * connection. Four things a "does it render" test would never catch:
 *
 *   role   — both routes are ScopeAdmin. A viewer must see the store's state
 *            and NO verb; rendering one that 403s is a control that lies.
 *   ask    — neither can be undone from the phone (no un-pause route;
 *            reconnect is web-admin), so both confirm first, disconnect
 *            destructively. A declined confirm sends nothing.
 *   words  — pause copy must not promise the desktop's "stops scheduled
 *            syncs": no worker in apps/api/internal/commerce reads `paused`.
 *   verbatim — the disconnect receipt is the server's own sentences
 *            (postwave_effects / provider_console_actions), never paraphrased.
 */

const mockState = {
  confirmAnswer: true,
  confirmCalls: [] as Record<string, unknown>[],
  pauseCalls: [] as string[],
  pauseError: null as unknown,
  disconnectCalls: [] as string[],
  disconnectError: null as unknown,
  disconnectResult: {} as Record<string, unknown>,
};

jest.mock("@/hooks/useCommerceConnection", () => ({
  usePauseCommerceStore: () => ({
    mutateAsync: async (id: string) => {
      mockState.pauseCalls.push(id);
      if (mockState.pauseError) throw mockState.pauseError;
      return null;
    },
    isPending: false,
  }),
  useDisconnectCommerceStore: () => ({
    mutateAsync: async (id: string) => {
      mockState.disconnectCalls.push(id);
      if (mockState.disconnectError) throw mockState.disconnectError;
      return mockState.disconnectResult;
    },
    isPending: false,
  }),
}));

jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockState.confirmCalls.push(options);
    return mockState.confirmAnswer;
  },
}));

const STORE = {
  id: "int-1",
  provider: "shopify",
  shopDomain: "acme.myshopify.com",
  status: "active",
  lastSyncAt: "2026-07-25T09:00:00Z",
  errorMessage: "",
  sync: {
    tone: "failed" as const,
    label: "Sync stopped on an error",
    attempts: 3,
    lastError: "401 Unauthorized from Shopify",
    retryDue: false,
    complete: false,
    nextAttemptAt: "",
  },
};

const ANALYTICS = {
  customers: 1240,
  products: 88,
  orders: 3120,
  revenueCents: 4_512_300,
  averageOrderCents: 14_462,
  currency: "EUR",
  ordersByStatus: [],
  lastOrderAt: "2026-07-25T08:00:00Z",
};

/** The NORMALIZED shape (what the mocked hook resolves with), credentials left manual. */
const RECEIPT = {
  ok: true,
  provider: "shopify",
  postwaveStatus: "disconnected",
  managedProviderCleanup: true,
  webhookCleanupStatus: "completed",
  credentialCleanupStatus: "manual",
  postwaveEffects: ["local commerce integration is marked disconnected"],
  providerConsoleActions: [
    "Uninstall the Moosewave app from the Shopify admin",
  ],
  providerCleanupEvidence: ["deleted 3 webhook subscriptions"],
};

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function withStores(stores: Record<string, unknown>[]) {
  queryHooks.__setHookResultForTests(
    "useCommerceStores",
    queryResult({ data: stores }),
  );
  queryHooks.__setHookResultForTests(
    "useCommerceAnalytics",
    queryResult({ data: ANALYTICS }),
  );
}

function renderScreen() {
  return render(
    React.createElement(ToastProvider, null, React.createElement(CommerceScreen)),
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

const PAUSE = "Pause the acme.myshopify.com integration";
const MORE = "More actions for acme.myshopify.com";
const DISCONNECT = "Disconnect acme.myshopify.com";

beforeEach(() => {
  mockState.confirmAnswer = true;
  mockState.confirmCalls = [];
  mockState.pauseCalls = [];
  mockState.pauseError = null;
  mockState.disconnectCalls = [];
  mockState.disconnectError = null;
  mockState.disconnectResult = RECEIPT;
});

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("store connection administration (P1.7 pause, P2.37 disconnect)", () => {
  it("offers Pause beside Resume, and an overflow, to an online admin", async () => {
    withStores([STORE]);
    const result = await renderScreen();
    expect(
      result.getByLabelText("Resume the acme.myshopify.com sync"),
    ).toBeTruthy();
    expect(result.getByLabelText(PAUSE)).toBeTruthy();
    expect(result.getByLabelText(MORE)).toBeTruthy();
  });

  it("pause asks first, posts on yes, and says paused — not synced, not stopped", async () => {
    withStores([STORE]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(PAUSE));
    });
    await waitFor(() => expect(mockState.pauseCalls).toEqual(["int-1"]));

    const asked = mockState.confirmCalls[0];
    expect(asked?.title).toBe("Pause store integration?");
    expect(asked?.confirmLabel).toBe("Pause integration");
    // The server only flips a status flag; the phone must not promise more.
    expect(String(asked?.message)).not.toMatch(/sync/i);
    await waitFor(() =>
      expect(result.getByText("acme.myshopify.com paused.")).toBeTruthy(),
    );
  });

  it("a declined pause sends nothing", async () => {
    mockState.confirmAnswer = false;
    withStores([STORE]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(PAUSE));
    });
    await waitFor(() => expect(mockState.confirmCalls.length).toBe(1));
    expect(mockState.pauseCalls).toEqual([]);
    expect(result.queryByText("acme.myshopify.com paused.")).toBeNull();
  });

  it("speaks the 409 answer when the store was disconnected underneath", async () => {
    mockState.pauseError = { status: 409 };
    withStores([STORE]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(PAUSE));
    });
    await waitFor(() =>
      expect(
        result.getByText(
          "This store is disconnected. Reconnect it on the web admin first.",
        ),
      ).toBeTruthy(),
    );
  });

  it("keeps Pause visible but disabled, with the reason, for a paused store", async () => {
    withStores([{ ...STORE, status: "paused" }]);
    const result = await renderScreen();

    // There is no un-pause route, so the control explains itself instead of
    // vanishing or reading as a toggle.
    const button = result.getByLabelText("acme.myshopify.com is already paused.");
    expect(button.props.accessibilityState.disabled).toBe(true);
    expect(result.getByText("Paused")).toBeTruthy();
    expect(result.queryByLabelText(PAUSE)).toBeNull();
  });

  it("disconnect lives behind the overflow, confirms destructively, and renders the server's sentences verbatim", async () => {
    withStores([STORE]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(MORE));
    });
    await act(async () => {
      fireEvent.press(result.getByLabelText(DISCONNECT));
    });
    await waitFor(() => expect(mockState.disconnectCalls).toEqual(["int-1"]));

    const asked = mockState.confirmCalls[0];
    expect(asked?.title).toBe("Disconnect store integration?");
    expect(asked?.destructive).toBe(true);
    expect(asked?.confirmLabel).toBe("Disconnect");
    expect(String(asked?.consequence)).toMatch(
      /Already-imported customers, products, and orders are kept/,
    );

    await waitFor(() =>
      expect(
        result.getByText("acme.myshopify.com marked disconnected."),
      ).toBeTruthy(),
    );
    // The receipt: server-authored lines, untouched.
    expect(
      result.getByText("• local commerce integration is marked disconnected"),
    ).toBeTruthy();
    expect(
      result.getByText("• Uninstall the Moosewave app from the Shopify admin"),
    ).toBeTruthy();
    expect(result.getByText("• deleted 3 webhook subscriptions")).toBeTruthy();
    expect(
      result.getByText("Webhooks: completed · Credentials: manual"),
    ).toBeTruthy();
    // Credentials are still manual, so cleanup is NOT complete — the boundary
    // headline, not the all-clear.
    expect(
      result.getByText(/Review the provider cleanup boundary/),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.press(
        result.getByLabelText(
          "Dismiss the acme.myshopify.com disconnect summary",
        ),
      );
    });
    expect(
      result.queryByText("• deleted 3 webhook subscriptions"),
    ).toBeNull();
  });

  it("a declined disconnect sends nothing", async () => {
    mockState.confirmAnswer = false;
    withStores([STORE]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(MORE));
    });
    await act(async () => {
      fireEvent.press(result.getByLabelText(DISCONNECT));
    });
    await waitFor(() => expect(mockState.confirmCalls.length).toBe(1));
    expect(mockState.disconnectCalls).toEqual([]);
  });

  it("dims Disconnect with its reason for an already-disconnected store", async () => {
    withStores([{ ...STORE, status: "disconnected" }]);
    const result = await renderScreen();

    await act(async () => {
      fireEvent.press(result.getByLabelText(MORE));
    });
    const item = result.getByLabelText(DISCONNECT);
    expect(item.props.accessibilityState.disabled).toBe(true);
    expect(item.props.accessibilityHint).toBe(
      "acme.myshopify.com is already disconnected.",
    );
  });

  it("shows a viewer the store's state and none of the administrative verbs", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });
    withStores([STORE]);
    const result = await renderScreen();

    expect(result.getAllByText("acme.myshopify.com").length).toBeGreaterThan(0);
    expect(result.getByText("Sync stopped on an error")).toBeTruthy();
    expect(result.queryByLabelText(PAUSE)).toBeNull();
    expect(result.queryByLabelText(MORE)).toBeNull();
  });

  it("hides the administrative verbs offline — a commerce write is never queued", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    withStores([STORE]);
    const result = await renderScreen();
    expect(result.queryByLabelText(PAUSE)).toBeNull();
    expect(result.queryByLabelText(MORE)).toBeNull();
  });
});
