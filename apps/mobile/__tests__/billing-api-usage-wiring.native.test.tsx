/**
 * Plan & usage × API usage & cost — pins that the billing SCREEN mounts the
 * section (P2.54), not merely that the section renders on its own.
 *
 * `api-usage-section.native.test.tsx` drives <ApiUsageSection /> directly and
 * owns its money sentences; `billing-screen.native.test.tsx` predates the
 * section and answers 404 to every path it does not know. Neither can fail if
 * the one line that mounts the section in app/(tabs)/billing.tsx is deleted —
 * proven by mutation while this file was written — so this file exists for
 * exactly that line, plus the two things the HOST decides: the section sits
 * inside the plan's success branch (a failed plan is not also five failed
 * reads), and the viewer/admin split survives being hosted next to a control
 * that IS admin-gated.
 *
 * Same harness as the billing-screen test: a `useQuery` that runs the real
 * queryFn per key, with the wire mocked one layer lower at `rawRequest`, so
 * every normaliser between the wire and the render stays in the path.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type WireResult = {
  data?: unknown;
  error?: { status: number; message: string };
};

/** One slot per endpoint; `mock`-prefixed so the hoisted factory may use it. */
const mockWire: {
  plan: WireResult;
  usage: WireResult;
  invoices: WireResult;
  billingState: WireResult;
  summary: WireResult;
  keys: WireResult;
  timeseries: WireResult;
  costs: WireResult;
} = {
  plan: {},
  usage: {},
  invoices: {},
  billingState: {},
  summary: {},
  keys: {},
  timeseries: {},
  costs: {},
};

/** Every path the wire was asked for, so a test can assert what was NOT read. */
const mockRequested: string[] = [];

jest.mock("@tanstack/react-query", () => {
  const react = require("react") as typeof import("react");
  return {
    __esModule: true,
    useQuery: ({
      queryKey,
      queryFn,
      enabled,
    }: {
      queryKey: unknown[];
      queryFn: () => Promise<unknown>;
      enabled?: boolean;
    }) => {
      const [state, setState] = react.useState<{
        data: unknown;
        isLoading: boolean;
        isError: boolean;
        error: unknown;
      }>({ data: undefined, isLoading: true, isError: false, error: null });
      const key = JSON.stringify(queryKey);
      react.useEffect(() => {
        if (enabled === false) return;
        let alive = true;
        void Promise.resolve()
          .then(queryFn)
          .then(
            (data) => {
              if (alive) {
                setState({ data, isLoading: false, isError: false, error: null });
              }
            },
            (error) => {
              if (alive) {
                setState({ data: undefined, isLoading: false, isError: true, error });
              }
            },
          );
        return () => {
          alive = false;
        };
      }, [key, enabled]);
      return {
        ...state,
        isFetching: false,
        isPending: state.isLoading,
        isRefetching: false,
        isSuccess: !state.isLoading && !state.isError,
        refetch: async () => ({ data: state.data }),
      };
    },
    useMutation: () => ({
      data: undefined,
      error: null,
      isError: false,
      isPending: false,
      mutate: jest.fn(),
      mutateAsync: jest.fn(async () => ({})),
      reset: jest.fn(),
      variables: undefined,
    }),
    useQueryClient: () => ({
      invalidateQueries: jest.fn(async () => undefined),
      setQueryData: jest.fn(),
    }),
  };
});

jest.mock("@/api/request", () => {
  const actual = jest.requireActual("@/api/request") as object;
  return {
    ...actual,
    __esModule: true,
    rawRequest: async (_method: string, path: string) => {
      mockRequested.push(String(path));
      switch (String(path).split("?")[0]) {
        case "/api/v1/billing/plan-summary":
          return mockWire.plan;
        case "/api/v1/billing/usage":
          return mockWire.usage;
        case "/api/v1/billing/invoices":
          return mockWire.invoices;
        case "/api/v1/billing/state":
          return mockWire.billingState;
        case "/api/v1/api-usage/summary":
          return mockWire.summary;
        case "/api/v1/api-usage/keys":
          return mockWire.keys;
        case "/api/v1/api-usage/timeseries":
          return mockWire.timeseries;
        case "/api/v1/costs":
          return mockWire.costs;
        default:
          return { error: { status: 404, message: "unrouted in test" } };
      }
    },
  };
});

import * as Gate from "@/hooks/useOnlineQueryGate";

import BillingScreen from "../app/(tabs)/billing";

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

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

function online(role = "admin") {
  hookHarness.__setOnlineGateForTests({
    enabled: true,
    tenantId: "t1",
    effectiveRole: role,
    online: true,
    baseUrl: "https://api.postwave.test",
  });
}

/** GET /api/v1/billing/plan-summary as `limits.PlanSummary` marshals it. */
function planWire() {
  return {
    tier: "growth",
    current_period_end: "2026-09-01T00:00:00Z",
    resources: [
      { resource: "monthly_sends", current: 18_432, limit: 50_000, percent: 36.9, exceeded: false },
    ],
  };
}

/** GET /api-usage/summary as api_usage_dashboard.go Summary writes it. */
function summaryWire() {
  return {
    window_days: 30,
    since: "2026-08-02T00:00:00Z",
    total_sends: 12_450,
    total_cost_cents: 1_245,
    active_keys: 3,
    avg_sends_per_day: 415,
    avg_cost_cents_per_day: 41.5,
    projected_30d_sends: 12_450,
    projected_30d_cost_cents: 1_245,
  };
}

/** GET /costs?by=kind — camelCase, as cost.CostRow marshals. */
function costsWire() {
  return {
    rows: [
      { kind: "send", cents: 1_200, microcents: 12_000_000, quantity: 12_000, count: 12 },
      { kind: "ai_generation", cents: 45, microcents: 450_000, quantity: 3, count: 3 },
    ],
  };
}

const SERVER_ERROR = { status: 500, message: "upstream unavailable" };

beforeEach(() => {
  mockRequested.length = 0;
  mockWire.plan = { data: planWire() };
  mockWire.usage = { data: [{ date: "2026-08-14T00:00:00Z", sent: 1_100 }] };
  mockWire.invoices = { data: [] };
  mockWire.billingState = { data: { sendingAddon: null } };
  mockWire.summary = { data: summaryWire() };
  mockWire.keys = {
    data: {
      window_days: 30,
      keys: [
        { id: "k1", label: "Zapier", prefix: "pw_live_ab", actor_type: "agent", sends: 9_000, cost_cents: 900 },
      ],
      count: 1,
    },
  };
  mockWire.timeseries = {
    data: {
      window_days: 30,
      points: [
        { date: "2026-08-30", sends: 400, cost_cents: 40 },
        { date: "2026-08-31", sends: 500, cost_cents: 40 },
      ],
    },
  };
  mockWire.costs = { data: costsWire() };
});

afterEach(() => {
  hookHarness.__resetOnlineGateForTests();
});

describe("plan & usage hosts the API usage & cost section", () => {
  it("mounts the section under the plan for an admin", async () => {
    // The assertion this file is really for: delete `<ApiUsageSection />`
    // from billing.tsx and every other suite in the repo stays green.
    online("admin");
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(await screen.findByText("API usage & cost")).toBeTruthy();
    expect(await screen.findByLabelText(/^Sends \(30d\): /u)).toBeTruthy();
    expect(await screen.findByLabelText(/^Total: 15 entries/u)).toBeTruthy();
    expect(screen.getByLabelText("View the itemized cost ledger")).toBeTruthy();
    // Hosted beside the admin-only portal button, and both are present.
    expect(screen.getByText("Manage plan & payment")).toBeTruthy();
  });

  it("keeps the viewer split when hosted: cost totals yes, admin reads never fired", async () => {
    // The screen's own `canManageBilling` hides the portal button below admin.
    // Had the section been placed inside that gate, a viewer would lose the
    // cost totals the manifest says they may read; had it been placed with no
    // gate at all, the admin-only reads would fire and 403 with a heading.
    online("viewer");
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(await screen.findByLabelText(/^Total: 15 entries/u)).toBeTruthy();
    expect(
      screen.getByText("Per-key API usage and send counts are shown to workspace admins."),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Sends \(30d\)/u)).toBeNull();
    expect(screen.queryByText("Manage plan & payment")).toBeNull();
    expect(mockRequested.filter((p) => p.startsWith("/api/v1/api-usage/"))).toEqual([]);
  });

  it("does not fire the section's reads under a failed plan", async () => {
    // The section lives in the plan's success branch on purpose: an operator
    // whose plan read failed gets ONE failure and one Retry, not a page of
    // five failure blocks each retrying a different thing.
    online("admin");
    mockWire.plan = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText("The server had a problem with this request. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByText("API usage & cost")).toBeNull();
    expect(
      mockRequested.filter(
        (p) => p.startsWith("/api/v1/api-usage/") || p.startsWith("/api/v1/costs"),
      ),
    ).toEqual([]);
  });

  it("keeps the plan on screen when the cost totals fail", async () => {
    // One failed secondary read is not a broken plan — the same rule the
    // invoice and usage reads already follow on this screen.
    online("admin");
    mockWire.costs = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(await screen.findByText("Cost totals couldn't be loaded.")).toBeTruthy();
    expect(screen.getByLabelText(/^Monthly sends: /u)).toBeTruthy();
    expect(screen.queryByText(/No metered cost in the last/u)).toBeNull();
  });
});
