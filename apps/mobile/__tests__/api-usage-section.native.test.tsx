/**
 * API usage & cost — the render contract for the section Plan & usage grew
 * for desktop parity (P2.54): summary tiles, per-key usage, cost totals, and
 * the push into the cost-ledger sheet.
 *
 * THE HARNESS is the one billing-screen.native.test.tsx established: a
 * `useQuery` that runs the REAL queryFn per key, with the wire mocked one
 * layer lower at `rawRequest`, dispatched by path. That keeps every
 * normaliser in lib/apiUsage in the path — the casing split between the
 * snake_case /api-usage family and the camelCase /costs family is exactly
 * the kind of thing a stubbed API module would hide.
 *
 * WHAT THIS PROTECTS. Every assertion is about a money sentence being WRONG
 * rather than a card being blank:
 *   - a failed read rendered as zeros tells an operator the API cost nothing;
 *   - an empty window rendered as $0.00 tiles is a manufactured zero bill;
 *   - "$0.00/day" over sends with no metered cost invents a charge that
 *     cannot happen (metering unconfigured);
 *   - firing the admin-only reads for a viewer is a 403 with a heading.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type WireResult = {
  data?: unknown;
  error?: { status: number; message: string };
};

/** One slot per endpoint; `mock`-prefixed so the hoisted factory may use it. */
const mockWire: {
  summary: WireResult;
  keys: WireResult;
  timeseries: WireResult;
  costs: WireResult;
  ledger: WireResult;
} = { summary: {}, keys: {}, timeseries: {}, costs: {}, ledger: {} };

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
              if (alive) setState({ data, isLoading: false, isError: false, error: null });
            },
            (error) => {
              if (alive) setState({ data: undefined, isLoading: false, isError: true, error });
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
        case "/api/v1/api-usage/summary":
          return mockWire.summary;
        case "/api/v1/api-usage/keys":
          return mockWire.keys;
        case "/api/v1/api-usage/timeseries":
          return mockWire.timeseries;
        case "/api/v1/costs":
          return mockWire.costs;
        case "/api/v1/costs/ledger":
          return mockWire.ledger;
        default:
          return { error: { status: 404, message: "unrouted in test" } };
      }
    },
  };
});

import * as Gate from "@/hooks/useOnlineQueryGate";

import { ApiUsageSection } from "@/components/billing/ApiUsageSection";

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

/** GET /api-usage/summary as api_usage_dashboard.go Summary writes it. */
function summaryWire(over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

function keysWire() {
  return {
    window_days: 30,
    keys: [
      { id: "k1", label: "Zapier", prefix: "pw_live_ab", actor_type: "agent", sends: 9_000, cost_cents: 900 },
      { id: "k2", label: "", prefix: "pw_live_cd", actor_type: "human", sends: 3_450, cost_cents: 345 },
    ],
    count: 2,
  };
}

function pointsWire(costCents = 40) {
  return {
    window_days: 30,
    points: [
      { date: "2026-08-30", sends: 400, cost_cents: costCents },
      { date: "2026-08-31", sends: 500, cost_cents: costCents },
    ],
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
  mockWire.summary = { data: summaryWire() };
  mockWire.keys = { data: keysWire() };
  mockWire.timeseries = { data: pointsWire() };
  mockWire.costs = { data: costsWire() };
  mockWire.ledger = {
    data: {
      rows: [
        { id: 1, apiKeyId: "k1", kind: "send", cents: 2, quantity: 1, at: "2026-08-31T10:00:00Z" },
      ],
    },
  };
});

afterEach(() => {
  hookHarness.__resetOnlineGateForTests();
});

describe("API usage & cost render contract", () => {
  it("mounts for an admin and shows the aggregates the operator came for", async () => {
    online("admin");
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByText("Sends (30d)", { includeHiddenElements: true })).toBeTruthy();
    // Tiles expose ONE spoken sentence each; the visual children are hidden.
    expect(screen.getByLabelText(/^Sends \(30d\): .+\/day average\.$/u)).toBeTruthy();
    expect(screen.getByLabelText(/^Metered cost \(30d\): \$12\.45, \$0\.42\/day average\.$/u)).toBeTruthy();
    expect(screen.getByLabelText("Active keys: 3.")).toBeTruthy();
    expect(screen.getByLabelText(/^Projected cost \(30d\): \$12\.45, .*estimate/u)).toBeTruthy();
    // Per-key rows, cost-desc, with the unlabeled key named as such.
    expect(screen.getByLabelText(/^Zapier \(pw_live_ab…\), agent: .+\$9\.00 metered cost\.$/u)).toBeTruthy();
    expect(screen.getByLabelText(/^\(unlabeled\) \(pw_live_cd…\), human: /u)).toBeTruthy();
    // Cost totals from the camelCase family, plus the footer.
    expect(screen.getByLabelText(/^send: 12 entries, .+\$12\.00\.$/u)).toBeTruthy();
    expect(screen.getByLabelText(/^Total: 15 entries, .+\$12\.45\.$/u)).toBeTruthy();
    expect(screen.getByLabelText("View the itemized cost ledger")).toBeTruthy();
    expect(screen.getByText(/Cost figures come from the metering ledger\./u)).toBeTruthy();
  });

  it("says API usage FAILED rather than rendering zeros, and keeps cost totals", async () => {
    online("admin");
    mockWire.summary = { error: SERVER_ERROR };
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByText("API usage couldn't be loaded.")).toBeTruthy();
    expect(screen.getByLabelText("Retry loading api usage")).toBeTruthy();
    expect(screen.queryByLabelText(/^Sends \(30d\)/u)).toBeNull();
    expect(screen.queryByText(/No API usage recorded/u)).toBeNull();
    // One failed read is not a broken section: the viewer-scoped half stands.
    expect(await screen.findByLabelText(/^Total: 15 entries/u)).toBeTruthy();
  });

  it("states an empty window in words, never as a row of $0.00 tiles", async () => {
    online("admin");
    mockWire.summary = {
      data: summaryWire({
        total_sends: 0,
        total_cost_cents: 0,
        active_keys: 0,
        avg_sends_per_day: 0,
        avg_cost_cents_per_day: 0,
        projected_30d_sends: 0,
        projected_30d_cost_cents: 0,
      }),
    };
    mockWire.timeseries = { data: { window_days: 30, points: [{ date: "2026-08-31", sends: 0, cost_cents: 0 }] } };
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByText("No API usage recorded in the last 30 days.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Sends \(30d\)/u)).toBeNull();
    expect(screen.queryByLabelText(/^Projected cost/u)).toBeNull();
    expect(screen.queryByText("Usage by API key")).toBeNull();
  });

  it("never claims a charge when metering recorded no cost", async () => {
    // Sends happened; the ledger has cents=0 for all of them (pricing not
    // configured). "$0.00/day average" and a projected "$0.00" would both
    // present a manufactured zero bill.
    online("admin");
    mockWire.summary = {
      data: summaryWire({ total_cost_cents: 0, avg_cost_cents_per_day: 0, projected_30d_cost_cents: 0 }),
    };
    mockWire.timeseries = { data: pointsWire(0) };
    await render(<ApiUsageSection />, { wrapper });

    expect(
      await screen.findByLabelText(/^Metered cost \(30d\): \$0\.00, No metered cost recorded for these sends\.$/u),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Projected cost/u)).toBeNull();
    expect(screen.queryByText(/billed|charged/iu, { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByLabelText(/billed|charged/iu)).toBeNull();
  });

  it("shows a viewer the cost totals and the ledger, and never fires the admin reads", async () => {
    online("viewer");
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByLabelText(/^Total: 15 entries/u)).toBeTruthy();
    expect(screen.getByText("Per-key API usage and send counts are shown to workspace admins.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Sends \(30d\)/u)).toBeNull();
    expect(screen.queryByText("Usage by API key")).toBeNull();
    expect(screen.getByLabelText("View the itemized cost ledger")).toBeTruthy();
    expect(mockRequested.filter((p) => p.startsWith("/api/v1/api-usage/"))).toEqual([]);
  });

  it("says cost totals FAILED instead of 'no metered cost'", async () => {
    online("admin");
    mockWire.costs = { error: SERVER_ERROR };
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByText("Cost totals couldn't be loaded.")).toBeTruthy();
    expect(screen.getByLabelText("Retry loading cost totals")).toBeTruthy();
    expect(screen.queryByText(/No metered cost in the last/u)).toBeNull();
    // The admin half is unaffected.
    expect(await screen.findByLabelText(/^Sends \(30d\)/u)).toBeTruthy();
  });

  it("states an empty cost window in words", async () => {
    online("admin");
    mockWire.costs = { data: { rows: [] } };
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByText("No metered cost in the last 30 days.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Total: /u)).toBeNull();
  });

  it("pushes into the cost ledger sheet on tap, reading the same window", async () => {
    online("viewer");
    await render(<ApiUsageSection />, { wrapper });

    expect(await screen.findByLabelText("View the itemized cost ledger")).toBeTruthy();
    expect(mockRequested.some((p) => p.startsWith("/api/v1/costs/ledger"))).toBe(false);
    await fireEvent.press(screen.getByLabelText("View the itemized cost ledger"));

    expect(await screen.findByText("Cost ledger")).toBeTruthy();
    expect(await screen.findByLabelText(/^send on .+, key k1: quantity 1, \$0\.02\.$/u)).toBeTruthy();
    expect(mockRequested.some((p) => p.startsWith("/api/v1/costs/ledger?since=30d"))).toBe(true);
  });

  it("says reconnect when offline instead of firing reads", async () => {
    hookHarness.__setOnlineGateForTests({
      enabled: false,
      tenantId: "t1",
      effectiveRole: "admin",
      online: false,
    });
    await render(<ApiUsageSection />, { wrapper });

    expect(
      await screen.findByText("API usage and cost need a connection — reconnect to see current numbers."),
    ).toBeTruthy();
    expect(mockRequested).toEqual([]);
  });
});
