/**
 * InactiveKeysCard — the render contract.
 *
 * The decision is pinned in src/lib/inactiveKeyAlerts.test.ts and the
 * transport in src/api/inactiveKeys.test.ts; this file pins what the
 * operator meets on the API-keys screen:
 *
 *  - alerts render with the server's headline, severity word and day count;
 *  - a clean report, a `null` keys, a bare-array payload, loading and offline
 *    all render NOTHING — not an empty box;
 *  - a failed read says so and offers a Retry that refetches THIS query;
 *  - a 403 reads as the permission rule and offers no Retry;
 *  - below admin the card is omitted entirely;
 *  - the card is actually MOUNTED on the API-keys screen.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import { InactiveKeysError } from "@/lib/inactiveKeyAlerts";

type HookResult = {
  mayRead: boolean;
  online: boolean;
  query: {
    data: unknown;
    error: unknown;
    isError: boolean;
    refetch: () => Promise<unknown>;
  };
};

const refetch = jest.fn(async () => ({}));

function fresh(): HookResult {
  return {
    mayRead: true,
    online: true,
    query: { data: undefined, error: null, isError: false, refetch },
  };
}

let mockHook: HookResult = fresh();

jest.mock("@/hooks/useInactiveKeys", () => ({
  useInactiveKeys: () => mockHook,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { InactiveKeysCard } from "@/components/api-keys/InactiveKeysCard";
// eslint-disable-next-line import/first
import ApiKeys from "../app/(tabs)/api-keys";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/**
 * Only the screen-mount test needs safe-area context (the route wraps itself
 * in a SafeAreaView). The card itself is rendered BARE so that "renders
 * nothing" can be asserted as `toJSON() === null` — a provider wrapper would
 * always leave a native element in the tree and turn that assertion into a
 * check of the wrapper.
 */
function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

function renderCard() {
  return render(<InactiveKeysCard />);
}

afterEach(() => {
  mockHook = fresh();
  refetch.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

/** One row exactly as inactive_keys.go:56 encodes it — the hook's data is the
 * PARSED payload in production, but the card re-validates the wire shape, so
 * the wire shape is what these tests feed it. */
function wireRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "k1",
    label: "CI deploy key",
    prefix: "pw_live_9f2c",
    actor_type: "human",
    created_at: "2026-03-14T10:00:00Z",
    last_used_at: "2026-05-01T10:00:00Z",
    days_since_last_use: 124,
    never_used: false,
    severity: "high",
    ...overrides,
  };
}

function report(keys: unknown, thresholdDays = 90) {
  return { threshold_days: thresholdDays, keys, count: Array.isArray(keys) ? keys.length : 0 };
}

describe("InactiveKeysCard", () => {
  it("renders the server's headline, severity and day count verbatim", async () => {
    mockHook.query.data = report([
      wireRow(),
      wireRow({
        id: "k2",
        label: "",
        prefix: "pw_test_0a1b",
        days_since_last_use: 40,
        never_used: true,
        severity: "critical",
      }),
    ]);
    await renderCard();
    expect(screen.getByText("2 API keys unused for 90+ days.")).toBeTruthy();
    expect(screen.getByText("CI deploy key")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText(/unused for 124 days/u)).toBeTruthy();
    expect(screen.getByText(/never used since creation/u)).toBeTruthy();
    expect(screen.getByText("pw_live_9f2c…")).toBeTruthy();
    // A key with no label still occupies its row; a blank there would read as
    // a rendering fault rather than an unlabeled credential.
    expect(screen.getByText("(unlabeled)")).toBeTruthy();
    expect(screen.getByText(/Unused keys widen your attack surface/u)).toBeTruthy();
  });

  it("orders critical ahead of high regardless of wire order", async () => {
    mockHook.query.data = report([
      wireRow({ id: "later", label: "Warn key", severity: "warn" }),
      wireRow({ id: "first", label: "Critical key", severity: "critical" }),
    ]);
    await renderCard();
    const labels = screen.getAllByText(/key$/u).map((node) => node.props.children);
    expect(labels).toEqual(["Critical key", "Warn key"]);
  });

  it("renders NOTHING for a clean report — no empty box, no all-clear", async () => {
    mockHook.query.data = report([]);
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  // One `it` per shape rather than a loop with unmount() between renders:
  // RNTL's `screen` stays bound to an explicitly unmounted tree, so every
  // LATER test in the file would query a dead render. The suite's
  // afterEach(cleanup) is the only unmount these tests rely on.
  //
  // Each of these shapes has crashed a card in this repo when `?? []` stood
  // in for a type check. Here they must be silence, not a throw.
  it("renders NOTHING for a null keys", async () => {
    mockHook.query.data = report(null);
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("renders NOTHING for a bare-array payload (the shared-harness shape)", async () => {
    mockHook.query.data = [wireRow()];
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("renders NOTHING for a paged envelope with no keys member", async () => {
    mockHook.query.data = { items: [] };
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("renders NOTHING while loading", async () => {
    mockHook.query.data = undefined;
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("renders NOTHING offline", async () => {
    mockHook.online = false;
    mockHook.query.data = undefined;
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("says a failed read failed, carrying the server's message, and Retry refetches", async () => {
    mockHook.query = {
      data: undefined,
      isError: true,
      error: new InactiveKeysError(500, "upstream unavailable"),
      refetch,
    };
    await renderCard();
    expect(
      screen.getByText("Couldn't check key activity: upstream unavailable"),
    ).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Retry checking key activity"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("reads a 403 as the permission rule and offers no Retry", async () => {
    mockHook.query = {
      data: undefined,
      isError: true,
      error: new InactiveKeysError(403, "your role does not have permission for this route"),
      refetch,
    };
    await renderCard();
    expect(screen.getByText(/needs an owner or admin session/u)).toBeTruthy();
    expect(screen.queryByText(/Couldn't check/u)).toBeNull();
    expect(screen.queryByLabelText("Retry checking key activity")).toBeNull();
  });

  it("is omitted entirely below admin, even with alerts cached", async () => {
    mockHook.mayRead = false;
    mockHook.query.data = report([wireRow()]);
    await renderCard();
    expect(screen.toJSON()).toBeNull();
  });

  it("is MOUNTED on the API-keys screen, above the roster", async () => {
    // An unmounted card is a phantom capability. The roster's own query rides
    // the shared react-query harness; the card's hook is mocked with alerts,
    // and both the screen title and the headline must appear in one tree.
    gateHarness.__setOnlineGateForTests({
      enabled: true,
      tenantId: "t1",
      effectiveRole: "admin",
      online: true,
    });
    queryHarness.__setQueryResultForTests({
      data: [
        {
          id: "k-live-1",
          label: "CI deploy key",
          prefix: "pw_live_9f2c",
          scopes: ["read:campaigns"],
          createdAt: "2026-03-14T10:00:00Z",
          actorType: "human",
          sandboxOnly: false,
        },
      ],
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({})),
    });
    mockHook.query.data = report([wireRow({ id: "k-live-1" })]);
    await render(<ApiKeys />, { wrapper });
    expect(screen.getByText("API keys")).toBeTruthy();
    expect(screen.getByText("1 API key unused for 90+ days.")).toBeTruthy();
  });
});
