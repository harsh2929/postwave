/**
 * The time-window filter on the suppressions list, at the rendered seam.
 *
 * lib/suppressionListRows.test.ts proves the window RULE; what it cannot prove
 * is that the screen offers the chips, hands the picked window to the rule,
 * tells "nothing in this window" apart from "no suppressions", and that the
 * footer names the WINDOW as the reason the count is short — not a reason
 * filter the operator never touched. Feed the rule "all" regardless of the
 * chip and the second test goes red.
 *
 * Harness mirrors suppressions.native.test.tsx (same hook mocks, same
 * SwipeableRow stub — see that file for why the stub exists).
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

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

const mockTrend = {
  data: undefined,
  isLoading: false,
  refetch: jest.fn(async () => undefined),
};

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
  __resetAuthStateForTests?: () => void;
};

const HOUR = 3_600_000;
const FRESH = "fresh@example.com";
const WEEK = "thisweek@example.com";
const OLD = "ancient@example.com";

/** Three rows whose ages straddle the 24h / 7d / 30d windows. */
function agedPage(over: { total?: number } = {}) {
  const now = Date.now();
  const items = [
    { id: "1", email: FRESH, created_at: new Date(now - 2 * HOUR).toISOString() },
    { id: "2", email: WEEK, created_at: new Date(now - 3 * 24 * HOUR).toISOString() },
    { id: "3", email: OLD, created_at: new Date(now - 60 * 24 * HOUR).toISOString() },
  ].map((row) => ({ reason: "hard_bounce", status: "blocklisted", ...row }));
  return {
    value: { items, total: over.total ?? items.length, page: 1, size: 50 },
    fromSnapshot: false,
    capturedAt: null,
  };
}

function reset() {
  mockSuppressions.data = undefined;
  mockSuppressions.isLoading = false;
  mockSuppressions.isError = false;
  mockSuppressions.error = null;
  mockSuppressions.hasNextPage = false;
  mockSuppressions.isFetchingNextPage = false;
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests?.();
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

function shown(screen: Awaited<ReturnType<typeof renderScreen>>, email: string) {
  return screen.queryAllByText(email).length > 0;
}

const chip = {
  any: "Show suppressions from any time",
  day: "Show suppressions from the last 24 hours",
  week: "Show suppressions from the last 7 days",
  month: "Show suppressions from the last 30 days",
};

describe("suppressions — time window", () => {
  it("offers the window chips with Any time selected, showing every loaded row", async () => {
    reset();
    mockSuppressions.data = agedPage();
    const screen = await renderScreen();
    expect(
      screen.getByLabelText("Filter by when the address was suppressed"),
    ).toBeTruthy();
    expect(screen.getByLabelText(chip.any).props.accessibilityState?.selected).toBe(
      true,
    );
    expect(shown(screen, FRESH)).toBe(true);
    expect(shown(screen, WEEK)).toBe(true);
    expect(shown(screen, OLD)).toBe(true);
  });

  it("narrows the loaded rows to the picked window and widens again", async () => {
    reset();
    mockSuppressions.data = agedPage();
    const screen = await renderScreen();

    await fireEvent.press(screen.getByLabelText(chip.day));
    expect(screen.getByLabelText(chip.day).props.accessibilityState?.selected).toBe(
      true,
    );
    expect(shown(screen, FRESH)).toBe(true);
    expect(shown(screen, WEEK)).toBe(false);
    expect(shown(screen, OLD)).toBe(false);

    await fireEvent.press(screen.getByLabelText(chip.week));
    expect(shown(screen, FRESH)).toBe(true);
    expect(shown(screen, WEEK)).toBe(true);
    expect(shown(screen, OLD)).toBe(false);

    await fireEvent.press(screen.getByLabelText(chip.month));
    expect(shown(screen, OLD)).toBe(false);

    await fireEvent.press(screen.getByLabelText(chip.any));
    expect(shown(screen, OLD)).toBe(true);
  });

  it("says NOTHING MATCHES — not 'No suppressions' — when the window empties the page", async () => {
    reset();
    const now = Date.now();
    mockSuppressions.data = {
      value: {
        items: [
          {
            id: "1",
            email: OLD,
            reason: "hard_bounce",
            status: "blocklisted",
            created_at: new Date(now - 60 * 24 * HOUR).toISOString(),
          },
        ],
        total: 1,
        page: 1,
        size: 50,
      },
      fromSnapshot: false,
      capturedAt: null,
    };
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText(chip.day));
    expect(screen.getByText("Nothing matches")).toBeTruthy();
    expect(screen.queryByText("No suppressions")).toBeNull();
  });

  it("the footer blames the TIME WINDOW for the short count, not a reason filter", async () => {
    reset();
    mockSuppressions.data = agedPage({ total: 1200 });
    mockSuppressions.hasNextPage = true;
    const screen = await renderScreen();
    await fireEvent.press(screen.getByLabelText(chip.day));
    expect(
      screen.getByText(/The time window narrows only what's loaded/u),
    ).toBeTruthy();
    expect(screen.queryByText(/The reason filter narrows/u)).toBeNull();
  });
});
