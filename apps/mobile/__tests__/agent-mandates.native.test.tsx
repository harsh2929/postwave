/**
 * Agent mandates — the render contract.
 *
 * WHY THIS FILE EXISTS. The screen shipped with 32 policy tests in
 * `lib/agentMandates.test.ts` and NO render test at all: nothing had ever
 * mounted it. Policy tests prove the sentences are right; they cannot prove the
 * screen survives being opened.
 *
 * That distinction is not theoretical here. `MaintenanceBanner` shipped the same
 * way in the same programme, and the dashboard's render test — not its 31 policy
 * tests — caught it crashing the whole screen with "windows.find is not a
 * function" the moment a query returned something other than an array. A screen
 * nobody has rendered is a screen whose first open is the test.
 *
 * WHAT THIS ASSERTS, and why each one is a wrong SENTENCE rather than a blank
 * screen:
 *
 *   - "No mandates granted" shown to somebody whose fetch failed tells them no
 *     agent holds authority over their workspace. On a governance screen that is
 *     the most damaging string available, and it is one collapsed error ladder
 *     away.
 *   - The subtitle counts only LIVE mandates. Counting revoked ones would
 *     overstate how much authority is currently delegated — the single number
 *     this screen exists to make honest.
 *   - A non-admin must still SEE the roster. The nav row deliberately carries no
 *     `minimumRole` (the read is viewer-floored), so the revoke affordance is
 *     gated in place; a screen that hid itself would defeat the reason the row
 *     was opened.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import AgentMandates from "../app/(tabs)/agent-mandates";

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row shaped exactly as `mandate.Summary` marshals it. */
function wireMandate(overrides: Record<string, unknown> = {}) {
  return {
    id: "9d2b7f6e-0000-4000-8000-000000000001",
    purpose: "Draft the weekly digest",
    actions: ["campaigns:send"],
    resources: ["list:42"],
    uses_remaining: 4,
    expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    last_used_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function loaded(rows: readonly unknown[]) {
  return {
    data: rows,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: rows })),
  };
}

function failed() {
  return {
    data: undefined,
    error: new Error("upstream unavailable"),
    isError: true,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
  });
}

describe("agent mandates render contract", () => {
  it("mounts at all", async () => {
    // The assertion the whole file is really for: before this, nothing had ever
    // rendered this screen.
    online();
    queryHarness.__setQueryResultForTests(loaded([wireMandate()]));
    await render(<AgentMandates />, { wrapper });
    expect(screen.getByText("Agent mandates")).toBeTruthy();
  });

  it("renders a mandate's purpose and what it grants", async () => {
    online();
    queryHarness.__setQueryResultForTests(loaded([wireMandate()]));
    await render(<AgentMandates />, { wrapper });
    expect(screen.getByText("Draft the weekly digest")).toBeTruthy();
    expect(screen.getByText(/campaigns:send/u)).toBeTruthy();
  });

  it("counts only LIVE mandates in the subtitle", async () => {
    // Counting a revoked mandate would overstate how much authority is
    // currently delegated — the one number this screen exists to make honest.
    online();
    queryHarness.__setQueryResultForTests(
      loaded([
        wireMandate({ id: "live-1" }),
        wireMandate({
          id: "dead-1",
          revoked_at: new Date(Date.now() - DAY_MS).toISOString(),
        }),
      ]),
    );
    await render(<AgentMandates />, { wrapper });
    expect(screen.getByText("1 active mandate")).toBeTruthy();
  });

  it("does not tell a failed fetch that nothing holds authority", async () => {
    // "No mandates granted" on a governance screen, shown because a request
    // failed, is the most damaging string this app can render.
    online();
    queryHarness.__setQueryResultForTests(failed());
    await render(<AgentMandates />, { wrapper });
    expect(screen.queryByText("No mandates granted")).toBeNull();
  });

  it("shows the roster to a viewer and tells them revoke is not theirs", async () => {
    // The nav row deliberately carries no minimumRole: the read is
    // viewer-floored, and only DELETE is admin.
    online("viewer");
    queryHarness.__setQueryResultForTests(loaded([wireMandate()]));
    await render(<AgentMandates />, { wrapper });
    expect(screen.getByText("Draft the weekly digest")).toBeTruthy();
    expect(screen.getByText(/Read-only for your role/u)).toBeTruthy();
  });

  it("survives a wire row missing every optional field", async () => {
    // Go's `omitempty` drops last_used_at and revoked_at, and a partial row
    // must render rather than throw.
    online();
    queryHarness.__setQueryResultForTests(
      loaded([
        {
          id: "bare",
          purpose: "Bare",
          actions: [],
          resources: [],
          uses_remaining: 0,
          expires_at: "",
        },
      ]),
    );
    await render(<AgentMandates />, { wrapper });
    expect(screen.getByText("Bare")).toBeTruthy();
  });

  it("does not crash when the query resolves to a non-array", async () => {
    // The exact failure MaintenanceBanner shipped with, caught by a render test
    // and not by its policy tests.
    online();
    queryHarness.__setQueryResultForTests(loaded(undefined as never));
    expect(() => render(<AgentMandates />, { wrapper })).not.toThrow();
  });

  it.each([
    ["a bare object", {}],
    ["a paged envelope", { items: [], total: 0 }],
  ])("does not crash when the query resolves to %s", async (_label, payload) => {
    // `data ?? []` is a NULLISH guard: it catches undefined and null and
    // nothing else. Both of these are TRUTHY non-arrays, so they sail straight
    // past it into `.map` — the same "spread/map a non-iterable" crash that
    // took down api-keys. The test above only ever proved the nullish half.
    online();
    queryHarness.__setQueryResultForTests(loaded(payload as never));
    expect(() => render(<AgentMandates />, { wrapper })).not.toThrow();
  });
});
