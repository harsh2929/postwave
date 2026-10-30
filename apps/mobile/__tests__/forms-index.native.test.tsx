/**
 * Forms index — the render contract for "did the new pop-up capture anything?".
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/forms/index.tsx` had no render test of its
 * own: `reviews-forms.native.test.tsx` covers the reviews half of that pairing,
 * and nothing had ever mounted this route with a payload.
 *
 * The state it protects is the one every list screen gets wrong in the same
 * direction — the STALE-WHILE-ERROR state. A failed background refetch leaves
 * TanStack holding the last successful `data` alongside a live `error`, so the
 * screen keeps painting rows. What must not happen is for that failure to be
 * silent, and what must REALLY not happen is for the screen to react to it by
 * quietly removing the search field and the KPI strip: an operator who pulled
 * to refresh watches the controls disappear, is told nothing, and reads the
 * remaining numbers as current.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import FormsIndex from "../app/(tabs)/forms/index";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
});

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

/** A row as `forms.FormListItem` marshals it. */
function formRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    name: "Newsletter popup",
    status: "enabled",
    submissions30d: 12,
    visits30d: 400,
    conversionRate: 3,
    ...overrides,
  };
}

/** The full result shape: `listForms` resolves an AIApiResult envelope. */
function state(overrides: Record<string, unknown> = {}) {
  return {
    data: { data: { items: [formRow()] }, error: null },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: Date.now() - 60_000,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...overrides,
  };
}

function online() {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    userId: "u1",
    effectiveRole: "admin",
    online: true,
  });
}

describe("forms index render contract", () => {
  it("mounts and renders a form with its 30-day capture", async () => {
    online();
    queryHarness.__setQueryResultForTests(state());
    await render(<FormsIndex />, { wrapper });
    expect(screen.getByText("Newsletter popup")).toBeTruthy();
    expect(screen.getByLabelText("Search forms by name or slug")).toBeTruthy();
  });

  it("keeps the controls, and SAYS SO, when a refresh fails over loaded rows", async () => {
    // Stale-while-error. `loadFailed` was a term in `showControls`, so a failed
    // background refetch deleted the search field, the filter chips and the KPI
    // strip from a screen that was still showing rows — and `ListEmptyComponent`
    // never renders while rows exist, so the failure had nowhere to be said.
    // The operator saw the tools vanish, no message, and stale numbers.
    online();
    queryHarness.__setQueryResultForTests(
      state({
        error: new Error("gateway exploded"),
        isError: true,
        isSuccess: false,
      }),
    );
    await render(<FormsIndex />, { wrapper });
    expect(screen.getByText("Newsletter popup")).toBeTruthy();
    expect(screen.getByLabelText("Search forms by name or slug")).toBeTruthy();
    expect(
      screen.getByLabelText("Showing previously loaded data; latest refresh failed"),
    ).toBeTruthy();
  });

  it("still renders the failure as an error when there are no rows to keep", async () => {
    // The other half of the same ladder: with nothing loaded, a failure is a
    // full error state and never "No signup forms yet".
    online();
    queryHarness.__setQueryResultForTests(
      state({
        data: { data: { items: [] }, error: null },
        error: new Error("gateway exploded"),
        isError: true,
        isSuccess: false,
      }),
    );
    await render(<FormsIndex />, { wrapper });
    expect(screen.queryByText("No signup forms yet")).toBeNull();
    expect(screen.getByText("Couldn't load forms")).toBeTruthy();
  });
});
