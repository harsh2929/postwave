/**
 * The ESP mirror's WIRE through the suppressions screen.
 *
 * suppression-mirror.native.test.tsx renders the header and the sheet in
 * isolation; nothing proved the screen connects them — that the header's Sync
 * actually opens MirrorFromEspSheet, and that the sheet then runs the picked
 * provider. Point the screen's `onMirror` at a no-op and the first test goes
 * red while every isolated test stays green.
 *
 * Harness mirrors suppressions.native.test.tsx; useSuppressionWrites is
 * proxied so the sheet's mutation can be scripted.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { MirrorOutcome } from "../src/lib/suppressionMirror";

const mockSuppressions = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
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

jest.mock("@/hooks/useSuppressionWrites", () =>
  require("./mocks/queryHooks.cjs"),
);

const queryHooks = require("./mocks/queryHooks.cjs");

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

const SYNC = "Mirror suppressions from your sending provider";
const RUN = "Mirror suppressions from Mailchimp";
const SHEET_TITLE = "Mirror from provider";

function page() {
  return {
    value: {
      items: [
        {
          id: "1",
          email: "bounced@example.com",
          reason: "hard_bounce",
          status: "blocklisted",
          created_at: "2026-09-01T09:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      size: 50,
    },
    fromSnapshot: false,
    capturedAt: null,
  };
}

function mirrorMutation(outcome: MirrorOutcome) {
  return {
    isPending: false,
    reset: jest.fn(),
    mutate: jest.fn(
      (
        _provider: string,
        callbacks?: { onSuccess?: (outcome: MirrorOutcome) => void },
      ) => callbacks?.onSuccess?.(outcome),
    ),
  };
}

function reset(role?: string) {
  mockSuppressions.data = page();
  mockSuppressions.isError = false;
  gateHarness.__resetOnlineGateForTests();
  if (role) gateHarness.__setOnlineGateForTests({ effectiveRole: role });
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

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
});

describe("suppressions — mirror from provider, wired through the screen", () => {
  it("Sync opens the mirror sheet, and the sheet runs the picked provider", async () => {
    reset("admin");
    const mutation = mirrorMutation({
      kind: "imported",
      result: { provider: "mailchimp", fetched: 12, imported: 4, skipped: 8, errors: 0 },
    });
    queryHooks.__setHookResultForTests("useMirrorSuppressions", mutation);
    const screen = await renderScreen();
    // Closed until asked for.
    expect(screen.queryByText(SHEET_TITLE)).toBeNull();
    await fireEvent.press(screen.getByLabelText(SYNC));
    expect(await screen.findByText(SHEET_TITLE)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText(RUN));
    await waitFor(() =>
      expect(mutation.mutate).toHaveBeenCalledWith("mailchimp", expect.anything()),
    );
    expect(
      await screen.findByText("Checked 12 provider rows — 4 imported, 8 already present."),
    ).toBeTruthy();
  });

  it("offers no Sync to a viewer — the mount is ScopeAdmin", async () => {
    reset("viewer");
    const screen = await renderScreen();
    expect(screen.queryByLabelText(SYNC)).toBeNull();
    expect(screen.queryByText(SHEET_TITLE)).toBeNull();
  });

  it("offers no Sync while the online gate is closed — the walk cannot be queued", async () => {
    reset("admin");
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
      isOnline: false,
    });
    const screen = await renderScreen();
    expect(screen.queryByLabelText(SYNC)).toBeNull();
  });
});
