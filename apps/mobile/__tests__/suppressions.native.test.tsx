import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * app/(tabs)/suppressions/index.tsx was 360 lines of screen code covered by ONE unit
 * test of a single parser (`normalizeSuppressionPage`). Nothing pinned a state
 * ladder — which is exactly why the offline-vs-empty class of bug survives on
 * a screen like this: "you're offline" and "you have no suppressions" render
 * the same shape and nobody can tell them apart from a screenshot.
 *
 * These tests pin the rungs that make a CLAIM ABOUT THE WORLD:
 *   - a live page renders its rows;
 *   - the offline rung says offline, never "No suppressions";
 *   - a failed load says it failed, never "No suppressions";
 *   - the destructive verbs are role-gated: a viewer gets neither the add
 *     button nor the ability to enter a selection whose only action 403s.
 *
 * And the new multi-select:
 *   - long-press enters selection mode and the row becomes a CHECKBOX;
 *   - tapping toggles rather than navigating;
 *   - "Select loaded" says "loaded", because it selects the page and not the
 *     archive.
 *
 * And paging, which is why the archive is reachable at all:
 *   - the footer offers the next page only when one exists;
 *   - the scope sentence points at that button instead of telling the operator
 *     to guess an exact address;
 *   - an OFFLINE (snapshot-backed) list never offers it, because the vault
 *     holds one page and the request could not succeed.
 *
 * Mock shapes match the hooks' real return types exactly: `useSuppressionList`
 * returns a SnapshotBacked envelope (`{value, fromSnapshot, capturedAt}`)
 * alongside the paging controls, so a `{data: {items}}` shim would pass on the
 * error path while hiding every loaded-state assertion.
 */
const mockSuppressions: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: jest.Mock<() => Promise<unknown>>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => undefined),
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(async () => undefined),
};

const mockTrend: { data: unknown; isLoading: boolean; refetch: () => Promise<unknown> } = {
  data: undefined,
  isLoading: false,
  refetch: jest.fn(async () => undefined),
};

/**
 * SwipeableRow is stubbed to a plain wrapper.
 *
 * The shared gesture-handler mock only exports GestureHandlerRootView, so the
 * real component's `react-native-gesture-handler/ReanimatedSwipeable` import
 * resolves to a module that renders NOTHING in this harness — every row of a
 * writable list silently disappears, which is a harness gap worth naming
 * rather than working around silently. The stub keeps the row's own label so
 * the assertions below still describe the shipped structure.
 */
jest.mock("@/components/SwipeableRow", () => {
  const RN = jest.requireActual("react-native") as typeof import("react-native");
  const ReactLocal = jest.requireActual("react") as typeof import("react");
  return {
    SwipeableRow: ({
      children,
      accessibilityLabel,
    }: {
      children: React.ReactNode;
      accessibilityLabel?: string;
    }) =>
      ReactLocal.createElement(
        RN.View,
        accessibilityLabel ? { accessibilityLabel } : {},
        children,
      ),
  };
});

jest.mock("@/hooks/useSuppressionOps", () => ({
  useSuppressions: () => mockSuppressions,
  useSuppressionList: () => mockSuppressions,
  useSuppressionTrend: () => mockTrend,
  useSuppressionAudit: () => ({ data: undefined, isLoading: false }),
  useAddSuppression: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemoveSuppression: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useExportSuppressions: () => ({ mutateAsync: jest.fn(), isPending: false }),
  // Declared inside the factory: jest hoists jest.mock above the module
  // body, so an out-of-scope class reference is a ReferenceError.
  OfflineWriteRefusedError: class extends Error {},
  SUPPRESSION_PAGE_SIZE: 50,
  SUPPRESSION_MAX_PAGES: 20,
}));

// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import * as AuthStore from "@/store/auth";
// eslint-disable-next-line import/first
import Suppressions from "../app/(tabs)/suppressions";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests?: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests?: () => void;
};

function page(
  items: { id: string; email: string; reason?: string }[],
  over: { total?: number; fromSnapshot?: boolean; capturedAt?: number } = {},
) {
  return {
    value: {
      items: items.map((row) => ({
        created_at: "2026-07-20T09:00:00Z",
        reason: "hard_bounce",
        status: "blocklisted",
        ...row,
      })),
      total: over.total ?? items.length,
      page: 1,
      size: 50,
    },
    fromSnapshot: over.fromSnapshot ?? false,
    capturedAt: over.capturedAt ?? null,
  };
}

/**
 * The row for one address.
 *
 * `getAllByLabelText` alone is not enough: for a role that can write, the card
 * is wrapped in a SwipeableRow whose own accessibilityLabel is
 * "<email>, suppressed", so the wrapper matches FIRST and a longPress on it
 * goes nowhere. Select the node that actually carries the row's role.
 */
function rowFor(
  screen: ReturnType<typeof render> extends Promise<infer R> ? R : never,
  email: string,
) {
  const escaped = email.replace(/\./g, "\\.");
  const node = screen
    .getAllByLabelText(new RegExp(escaped))
    .find(
      (candidate) =>
        candidate.props.accessibilityRole === "button" ||
        candidate.props.accessibilityRole === "checkbox",
    );
  if (!node) throw new Error(`no interactive row for ${email}`);
  return node;
}

async function renderScreen() {
  return await render(React.createElement(Suppressions), {
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

/**
 * The shared gate mock carries no `effectiveRole`, and every write on this
 * screen is gated on `canAccessMinimumRole("admin", …)` — so the default
 * fixture is a role that cannot write. Tests that exercise a write must opt
 * in, which is the right default: it means an accidentally-ungated control
 * shows up as a failure here.
 */
function reset(role?: string) {
  mockSuppressions.data = undefined;
  mockSuppressions.isLoading = false;
  mockSuppressions.isError = false;
  mockSuppressions.error = null;
  mockSuppressions.hasNextPage = false;
  mockSuppressions.isFetchingNextPage = false;
  mockSuppressions.fetchNextPage.mockClear();
  mockTrend.data = undefined;
  gateHarness.__resetOnlineGateForTests();
  if (role) gateHarness.__setOnlineGateForTests({ effectiveRole: role });
  authHarness.__resetAuthStateForTests?.();
}

describe("suppressions — state ladder", () => {
  it("renders the loaded page", async () => {
    reset();
    mockSuppressions.data = page([
      { id: "1", email: "bounced@example.com" },
      { id: "2", email: "complained@example.com" },
    ]);
    const screen = await renderScreen();
    expect(screen.getAllByText("bounced@example.com").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("complained@example.com").length,
    ).toBeGreaterThan(0);
  });

  it("says OFFLINE rather than 'No suppressions' when the gate is closed", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({ enabled: false, isOnline: false });
    const screen = await renderScreen();
    expect(screen.queryByText("No suppressions")).toBeNull();
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
  });

  it("says FAILED rather than 'No suppressions' when the load errored", async () => {
    reset();
    mockSuppressions.isError = true;
    mockSuppressions.error = new Error("gateway exploded");
    const screen = await renderScreen();
    expect(screen.queryByText("No suppressions")).toBeNull();
  });

  it("shows the empty state only when the load genuinely succeeded with no rows", async () => {
    reset();
    mockSuppressions.data = page([]);
    const screen = await renderScreen();
    expect(screen.getByText("No suppressions")).toBeTruthy();
  });
});

describe("suppressions — role gate", () => {
  it("offers the suppress-an-address action to an admin", async () => {
    reset("admin");
    mockSuppressions.data = page([{ id: "1", email: "a@example.com" }]);
    const screen = await renderScreen();
    expect(screen.getByLabelText("Suppress an address")).toBeTruthy();
  });

  it("withholds every write from a viewer", async () => {
    reset();
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    mockSuppressions.data = page([{ id: "1", email: "a@example.com" }]);
    const screen = await renderScreen();
    expect(screen.queryByLabelText("Suppress an address")).toBeNull();
    // And a viewer cannot enter a selection whose only verb would 403.
    expect(screen.queryByLabelText("Select several addresses")).toBeNull();
    // The row stays a door: no selection affordance is offered at all.
    expect(rowFor(screen, "a@example.com").props.accessibilityRole).toBe(
      "button",
    );
  });
});

describe("suppressions — multi-select", () => {
  it("the Select action enters selection and rows become checkboxes", async () => {
    reset("admin");
    mockSuppressions.data = page([
      { id: "1", email: "one@example.com" },
      { id: "2", email: "two@example.com" },
    ]);
    const screen = await renderScreen();
    // Before: a door.
    expect(rowFor(screen, "one@example.com").props.accessibilityRole).toBe(
      "button",
    );
    await fireEvent.press(screen.getByLabelText("Select several addresses"));
    // Entering picks NOTHING — the user has not pointed at a row yet.
    expect(screen.getByText("Select addresses")).toBeTruthy();
    const row = rowFor(screen, "one@example.com");
    expect(row.props.accessibilityRole).toBe("checkbox");
    expect(row.props.accessibilityState?.selected).toBe(false);
    await fireEvent.press(row);
    expect(screen.getByText("1 address selected")).toBeTruthy();
    expect(
      rowFor(screen, "one@example.com").props.accessibilityState?.selected,
    ).toBe(true);
  });

  it("a long-press also enters selection, seeded with THAT row", async () => {
    reset("admin");
    mockSuppressions.data = page([
      { id: "1", email: "one@example.com" },
      { id: "2", email: "two@example.com" },
    ]);
    const screen = await renderScreen();
    await fireEvent(rowFor(screen, "two@example.com"), "longPress");
    expect(screen.getByText("1 address selected")).toBeTruthy();
    expect(
      rowFor(screen, "two@example.com").props.accessibilityState?.selected,
    ).toBe(true);
    expect(
      rowFor(screen, "one@example.com").props.accessibilityState?.selected,
    ).toBe(false);
  });

  it("a tap in selection mode TOGGLES instead of navigating", async () => {
    reset("admin");
    mockSuppressions.data = page([
      { id: "1", email: "one@example.com" },
      { id: "2", email: "two@example.com" },
    ]);
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Select several addresses"));
    await fireEvent.press(rowFor(screen, "one@example.com"));
    await fireEvent.press(rowFor(screen, "two@example.com"));
    expect(screen.getByText("2 addresses selected")).toBeTruthy();
    // Tapping the same row again removes it.
    await fireEvent.press(rowFor(screen, "two@example.com"));
    expect(screen.getByText("1 address selected")).toBeTruthy();
  });

  it("'Select loaded' says LOADED — it selects the page, not the archive", async () => {
    reset("admin");
    mockSuppressions.data = page([
      { id: "1", email: "one@example.com" },
      { id: "2", email: "two@example.com" },
      { id: "3", email: "three@example.com" },
    ]);
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Select several addresses"));
    await fireEvent.press(screen.getByText("Select loaded"));
    expect(screen.getByText("3 addresses selected")).toBeTruthy();
  });

  it("Done leaves selection mode and restores the drill-down role", async () => {
    reset("admin");
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }]);
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Select several addresses"));
    await fireEvent.press(rowFor(screen, "one@example.com"));
    expect(screen.getByText("1 address selected")).toBeTruthy();
    await fireEvent.press(screen.getByText("Done"));
    expect(screen.queryByText("1 address selected")).toBeNull();
    expect(rowFor(screen, "one@example.com").props.accessibilityRole).toBe(
      "button",
    );
  });
});

/**
 * Paging. `useSuppressions` took a fully-plumbed `page` argument that no caller
 * ever passed, so the 51st-newest suppression could only be reached by typing
 * its exact address into the search box — on a screen whose whole job is
 * answering "why didn't this person get my email?".
 */
describe("suppressions — reaching past the first page", () => {
  it("offers the next page when the server says more exist", async () => {
    reset();
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }], {
      total: 1200,
    });
    mockSuppressions.hasNextPage = true;
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText("Load more suppressions"));
    expect(mockSuppressions.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("points at that button instead of telling the operator to guess an address", async () => {
    reset();
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }], {
      total: 1200,
    });
    mockSuppressions.hasNextPage = true;
    const screen = await renderScreen();
    expect(screen.getByText(/Load more to reach older records/)).toBeTruthy();
    expect(screen.queryByText(/Search by address to reach older records/)).toBeNull();
  });

  it("discloses the scope and falls back to search once paging is exhausted", async () => {
    reset();
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }], {
      total: 1200,
    });
    const screen = await renderScreen();
    expect(screen.queryByLabelText("Load more suppressions")).toBeNull();
    expect(
      screen.getByText(/Showing 1 of 1,200 suppressed addresses/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Search by address to reach older records/),
    ).toBeTruthy();
  });

  it("never offers another page over an offline snapshot", async () => {
    // The vault holds ONE page. A "Load more" here could only fail.
    reset();
    gateHarness.__setOnlineGateForTests({ enabled: false, isOnline: false });
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }], {
      total: 1200,
      fromSnapshot: true,
      capturedAt: Date.now() - 3_600_000,
    });
    mockSuppressions.hasNextPage = false;
    const screen = await renderScreen();
    expect(screen.queryByLabelText("Load more suppressions")).toBeNull();
  });

  it("shows the busy label while the next page is in flight", async () => {
    reset();
    mockSuppressions.data = page([{ id: "1", email: "one@example.com" }], {
      total: 1200,
    });
    mockSuppressions.hasNextPage = true;
    mockSuppressions.isFetchingNextPage = true;
    const screen = await renderScreen();
    const button = screen.getByLabelText("Load more suppressions");
    expect(button.props.accessibilityState?.busy).toBe(true);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});

describe("suppressions — time window", () => {
  it("narrows the loaded rows to the picked window and reads as filtered", async () => {
    reset();
    // One fresh row, one from last month (page() stamps 2026-07-20 by
    // default; the fresh row overrides it to a minute ago).
    const base = page([
      { id: "old", email: "old@example.com" },
      { id: "fresh", email: "fresh@example.com" },
    ]);
    const fresh = base.value.items[1];
    if (fresh) fresh.created_at = new Date(Date.now() - 60_000).toISOString();
    mockSuppressions.data = base;
    const screen = await renderScreen();
    expect(screen.getAllByText("old@example.com").length).toBeGreaterThan(0);
    fireEvent.press(
      screen.getByLabelText("Show suppressions from the last 24 hours"),
    );
    // The month-old row leaves; the fresh one stays.
    await waitFor(() =>
      expect(screen.queryByText("old@example.com")).toBeNull(),
    );
    expect(screen.getAllByText("fresh@example.com").length).toBeGreaterThan(0);
  });

  it("says Nothing matches — not No suppressions — when the window empties the list", async () => {
    reset();
    mockSuppressions.data = page([{ id: "old", email: "old@example.com" }]);
    const screen = await renderScreen();
    fireEvent.press(
      screen.getByLabelText("Show suppressions from the last 24 hours"),
    );
    expect(await screen.findByText("Nothing matches")).toBeTruthy();
    expect(screen.queryByText("No suppressions")).toBeNull();
  });
});
