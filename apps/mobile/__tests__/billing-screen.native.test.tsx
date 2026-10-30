/**
 * Plan & usage — the render contract for `app/(tabs)/billing.tsx`.
 *
 * WHY THIS FILE EXISTS. Nothing had ever mounted this screen. `SpendControlsCard`
 * got its own render test (`spend-controls.native.test.tsx`) precisely because
 * the screen it lives on had none, and `lib/billingNormalize.test.ts` proves the
 * arithmetic and the copy are right without ever proving the screen survives
 * being opened. In this programme that distinction has already cost a crashed
 * dashboard: `MaintenanceBanner` shipped with 31 passing policy tests and took
 * the whole screen down with "windows.find is not a function" the first time a
 * query answered something other than an array.
 *
 * THE HARNESS. The shared `@tanstack/react-query` mock returns ONE result for
 * every `useQuery` in the module graph, and this screen has FIVE independent
 * reads (plan summary, usage series, invoices, and the sending add-on plus SMS
 * wallet inside `SpendControlsCard`). Driving it through the shared mock would
 * hand the plan summary to the chart as its point series — a mock-shape
 * mismatch that makes a suite pass while asserting nothing, and which happens
 * to be the exact crash described above. So this file uses the seam
 * `workspace-setup.native.test.tsx` established: a `useQuery` that runs the
 * REAL `queryFn` per key, with the wire mocked one layer lower at
 * `rawRequest`. That keeps `normalizePlanSummary`, `listInvoices`' array
 * coercion, `fetchUsage`' coercion and `normalizeSendingAddon` in the path,
 * which matters because those coercions are the only thing standing between a
 * partial payload and a TypeError.
 *
 * WHAT THIS PROTECTS. This is the screen people open when sending has stopped,
 * so every assertion is about a money sentence being WRONG rather than a card
 * being blank:
 *
 *   - "Nothing here yet" rendered because the plan request failed tells an
 *     operator mid-incident that they have no plan;
 *   - "No sends recorded in this window." rendered because the usage request
 *     failed tells them their sending stopped when it did not — and it is one
 *     collapsed error ladder away from the honest line;
 *   - a projection sentence repeated under every meter attributes the send cap
 *     to resources that have none;
 *   - a row the server did not flag as `exceeded` must still say the cap is
 *     blown, because silence there is the costly direction;
 *   - the portal button below admin is a control whose only possible answer is
 *     403.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

type WireResult = {
  data?: unknown;
  error?: { status: number; message: string };
};

/**
 * One slot per endpoint the screen touches. Must be `mock`-prefixed: the
 * `jest.mock` factory below is hoisted above every declaration in this file,
 * and babel-plugin-jest-hoist only lets a factory reach out to identifiers
 * whose names start with "mock".
 */
const mockWire: {
  plan: WireResult;
  usage: WireResult;
  invoices: WireResult;
  billingState: WireResult;
  smsCredits: WireResult;
} = {
  plan: {},
  usage: {},
  invoices: {},
  billingState: {},
  smsCredits: {},
};

/**
 * A `useQuery` that RUNS the query function, keyed per query, instead of the
 * shared mock's one-result-for-everything. This is what makes `rawRequest` the
 * seam rather than the screen's own reads: each of the five queries gets its
 * own answer, and every normaliser between the wire and the render stays real.
 */
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
                setState({
                  data,
                  isLoading: false,
                  isError: false,
                  error: null,
                });
              }
            },
            (error) => {
              if (alive) {
                setState({
                  data: undefined,
                  isLoading: false,
                  isError: true,
                  error,
                });
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
        // `useManualRefresh` calls every refetch it is handed and awaits them
        // through Promise.allSettled, so this has to be a real thenable.
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

/**
 * The wire, one layer below the API modules. `@/api/billing` and
 * `@/api/spendControls` both reach the network through `rawRequest`, so
 * dispatching on the path leaves their real normalisation in the path — which
 * is the whole point: `resourcePercent` re-deriving a missing percent and
 * `fetchUsage` coercing a non-array are behaviours this screen depends on and
 * a stubbed API module would delete.
 */
jest.mock("@/api/request", () => {
  const actual = jest.requireActual("@/api/request") as object;
  return {
    ...actual,
    __esModule: true,
    rawRequest: async (_method: string, path: string) => {
      switch (String(path).split("?")[0]) {
        case "/api/v1/billing/plan-summary":
          return mockWire.plan;
        case "/api/v1/billing/usage":
          return mockWire.usage;
        case "/api/v1/billing/invoices":
          return mockWire.invoices;
        case "/api/v1/billing/state":
          return mockWire.billingState;
        case "/api/v1/sms/credits/balance":
          return mockWire.smsCredits;
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

/**
 * The mocked gate carries no role by default, and `canAccessMinimumRole`
 * answers false for an unknown one — so every role-gated control would be
 * absent for the right reason by accident. Tests state the role they mean.
 */
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
function planWire(overrides: Record<string, unknown> = {}) {
  return {
    tier: "growth",
    current_period_end: "2026-09-01T00:00:00Z",
    resources: [
      {
        resource: "monthly_sends",
        current: 18_432,
        limit: 50_000,
        percent: 36.9,
        exceeded: false,
      },
      {
        resource: "contacts",
        current: 4_200,
        limit: 10_000,
        percent: 42,
        exceeded: false,
      },
    ],
    ...overrides,
  };
}

/** `sends_projection`, the block mobile used to drop on the floor. */
function projectionWire(overrides: Record<string, unknown> = {}) {
  return {
    current: 18_432,
    limit: 50_000,
    avg_per_day: 1_228,
    days_elapsed: 15,
    days_in_period: 30,
    projected_end_of_period: 36_840,
    projected_exceed_date: null,
    on_track_to_exceed: false,
    ...overrides,
  };
}

const SERVER_ERROR = { status: 500, message: "upstream unavailable" };

beforeEach(() => {
  mockWire.plan = { data: planWire() };
  mockWire.usage = {
    data: [
      { date: "2026-08-14T00:00:00Z", sent: 1_100 },
      { date: "2026-08-15T00:00:00Z", sent: 1_400 },
      { date: "2026-08-16T00:00:00Z", sent: 900 },
    ],
  };
  mockWire.invoices = {
    data: [
      {
        id: "in_1",
        number: "INV-0001",
        date: "Aug 1, 2026",
        amount: "$49.00",
        status: "paid",
        downloadUrl: "https://billing.stripe.com/invoice/abc",
      },
    ],
  };
  // No metered sending add-on and no SMS programme, so `SpendControlsCard`
  // renders nothing and these assertions stay about the billing SCREEN. That
  // card has its own render contract in spend-controls.native.test.tsx.
  mockWire.billingState = { data: { sendingAddon: null } };
  mockWire.smsCredits = { error: { status: 404, message: "no sms programme" } };
});

afterEach(() => {
  hookHarness.__resetOnlineGateForTests();
});

describe("plan & usage render contract", () => {
  it("mounts at all, and shows the plan the operator came for", async () => {
    // The assertion this whole file is really for: before it, nothing had ever
    // rendered this screen.
    online();
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("Usage this period")).toBeTruthy();
    expect(screen.getByText(/^Renews /u)).toBeTruthy();
    // UsageBar deliberately hides its four visual children from the
    // accessibility tree and exposes ONE spoken sentence in their place, so the
    // spoken sentence — not the loose strings — is the thing to assert.
    expect(screen.getByLabelText(/^Monthly sends: /u)).toBeTruthy();
    expect(screen.getByLabelText(/^Contacts: /u)).toBeTruthy();
    expect(screen.getByText("Recent invoices")).toBeTruthy();
    expect(screen.getByText("$49.00")).toBeTruthy();
    // Pinned here so the derived-`exceeded` test below cannot pass by the row
    // simply always carrying the breach line.
    expect(
      screen.queryByText("Over the plan limit.", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  it("attaches the send-cap projection to the sends row and nowhere else", async () => {
    // The projection is about the SEND cap. Repeating it under Contacts would
    // attribute a send forecast to a resource that has nothing to do with it,
    // and the screen's `row.resource === MONTHLY_SENDS` guard is the only thing
    // preventing that.
    online();
    mockWire.plan = {
      data: planWire({
        sends_projection: projectionWire({
          avg_per_day: 3_100,
          projected_end_of_period: 93_000,
          projected_exceed_date: "2026-08-27T00:00:00Z",
          on_track_to_exceed: true,
        }),
      }),
    };
    await render(<BillingScreen />, { wrapper });

    // includeHiddenElements because the footnote lives inside the subtree
    // UsageBar hides from VoiceOver; it is rendered, it is just not an a11y node.
    expect(
      await screen.findAllByText(/On pace to pass the send cap around /u, {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);
    expect(
      screen.getByLabelText(/^Monthly sends: .*On pace to pass the send cap/su),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Contacts: .*On pace/su)).toBeNull();
  });

  it("never invents a forecast the server declined to make", async () => {
    // `avg_per_day === 0` is the server's own insufficient-data signal
    // (limits.ComputeSendsProjection). Extrapolating from it would put a
    // manufactured number, and possibly a manufactured date, on a screen an
    // operator is using to decide whether to keep sending.
    online();
    mockWire.plan = {
      data: planWire({
        sends_projection: projectionWire({
          avg_per_day: 0,
          days_elapsed: 0,
          projected_end_of_period: 0,
        }),
      }),
    };
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText(
        "Not enough sending yet this period to project a total.",
        { includeHiddenElements: true },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/On pace/u, { includeHiddenElements: true }),
    ).toBeNull();
  });

  it("says the cap is blown even when the server did not flag the row", async () => {
    // `exceeded` and `percent` are both derivable, and both are omitted by
    // older gateways. Silence here is the expensive direction: the operator
    // opened this screen because sending stopped, and the row that explains it
    // would have rendered as a perfectly ordinary bar.
    online();
    mockWire.plan = {
      data: planWire({
        resources: [{ resource: "monthly_sends", current: 60_000, limit: 50_000 }],
      }),
    };
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText("Over the plan limit.", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/^Monthly sends: .*Over the plan limit\.$/su),
    ).toBeTruthy();
  });

  it("does not tell a failed plan fetch that they have no plan", async () => {
    // The screen passes no `empty` copy to QueryStates, so its fallback is
    // "Nothing here yet" — which, shown because a request failed, is the most
    // damaging string a billing screen can render. `fetchPlanSummary` throws
    // rather than resolving null specifically so this branch is reachable.
    online();
    mockWire.plan = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText(
        "The server had a problem with this request. Please try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(screen.queryByText("No metered resources on this plan.")).toBeNull();
  });

  it("does not let a failed invoice fetch vanish without a trace", async () => {
    // The sibling of the usage-failure case below, and the one that was still
    // open. `InvoiceSection` returns null at zero rows, so a 500 on
    // GET /api/v1/billing/invoices deleted the whole "Recent invoices" block:
    // no heading, no message, no Retry. "Send me last month's invoice" is a
    // thing people are asked away from a desk (this component's own header
    // comment says so), and a silently absent section is indistinguishable
    // from a workspace that has never been billed — the same lie as "No X yet"
    // over a failed GET, told by omission instead of by copy.
    online();
    mockWire.invoices = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    // The section still exists, and says which of the two it is.
    expect(await screen.findByText("Recent invoices")).toBeTruthy();
    expect(screen.getByText(/Invoices couldn't be loaded/u)).toBeTruthy();
    // The plan is unaffected: one failed secondary read is not a broken plan.
    expect(screen.getByText("growth")).toBeTruthy();
  });

  it("still renders nothing at all when there are genuinely no invoices", async () => {
    // The other half, so the fix above cannot pass by always rendering the
    // heading: a successful empty read has nothing to report and must stay
    // silent rather than manufacture an error the server did not send.
    online();
    mockWire.invoices = { data: [] };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(screen.queryByText("Recent invoices")).toBeNull();
    expect(screen.queryByText(/Invoices couldn't be loaded/u)).toBeNull();
  });

  it("does not tell a failed usage fetch that they sent nothing", async () => {
    // "No sends recorded in this window." and "Send history couldn't be
    // loaded." are one collapsed error ladder apart, and the first one tells an
    // operator their sending has stopped when it has not.
    online();
    mockWire.usage = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText(/Send history couldn't be loaded/u),
    ).toBeTruthy();
    expect(screen.queryByText("No sends recorded in this window.")).toBeNull();
    // And the plan itself is still on screen: one failed secondary read must
    // not be reported as a broken plan.
    expect(screen.getByText("growth")).toBeTruthy();
  });

  it("survives every secondary read failing at once", async () => {
    // Three of the five reads dead. The numbers the operator came for, and the
    // control that fixes their card, both have to still be there — this is the
    // screen someone opens BECAUSE the workspace is unhealthy.
    online();
    mockWire.usage = { error: SERVER_ERROR };
    mockWire.invoices = { error: SERVER_ERROR };
    mockWire.billingState = { error: SERVER_ERROR };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(screen.getByLabelText(/^Monthly sends: /u)).toBeTruthy();
    expect(screen.getByText("Manage plan & payment")).toBeTruthy();
  });

  it("shows a viewer the numbers but no portal button", async () => {
    // The four billing READS are viewer-scoped and POST /billing/portal is
    // admin, so the button can only ever 403 here. It is hidden rather than
    // disabled: a disabled control still reads as "you could do this if you
    // tried harder".
    online("viewer");
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(screen.getByLabelText(/^Monthly sends: /u)).toBeTruthy();
    expect(screen.queryByText("Manage plan & payment")).toBeNull();
    expect(
      screen.queryByText(/secure billing portal outside the app/u),
    ).toBeNull();
  });

  // A separate it() rather than a rerender in the test above: RNTL's `screen`
  // stays bound to an unmounted tree, so a mid-file unmount makes every LATER
  // test in the file query a dead render.
  it("offers an admin the out-of-app hand-off, and says it leaves the app", async () => {
    online("admin");
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("Manage plan & payment")).toBeTruthy();
    expect(
      screen.getByText(/secure billing portal outside the app/u),
    ).toBeTruthy();
  });

  it("invents neither a tier nor a renewal date the payload never carried", async () => {
    // `current_period_end` is omitempty and `tier` can be empty on a workspace
    // with no subscription. "Renews —" or "Renews Invalid Date" would both be
    // the screen making something up about a billing period.
    online();
    mockWire.plan = {
      data: { tier: "", resources: [{ resource: "monthly_sends", limit: 0 }] },
    };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByLabelText("Current plan: unknown.")).toBeTruthy();
    expect(screen.queryByText(/^Renews/u)).toBeNull();
    // An unlimited row is 0%, not 100% full, and it renders no bar at all —
    // so it must say "unlimited" in words rather than leave a blank line.
    expect(
      screen.getByLabelText("Monthly sends: 0 used, unlimited."),
    ).toBeTruthy();
  });

  it("says reconnect when offline, rather than 'Nothing here yet'", async () => {
    // Offline with nothing cached is not an error and not an empty workspace.
    // The screen supplies its own sentence for it; the generic empty copy would
    // claim the plan is gone.
    hookHarness.__setOnlineGateForTests({
      enabled: false,
      tenantId: "t1",
      effectiveRole: "admin",
      online: false,
    });
    await render(<BillingScreen />, { wrapper });

    expect(
      await screen.findByText(
        "Plan and usage need a connection — reconnect to see current numbers.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  it("does not let a non-array usage payload reach the chart", async () => {
    // This is the MaintenanceBanner crash shape. `UsageTrend` hands
    // `points.map(...)` straight to TimeSeriesChart, and the ONLY thing between
    // a usage endpoint that answers an object and a TypeError that takes the
    // whole screen down is `fetchUsage`'s Array.isArray coercion. Rendering
    // through the real API module is what pins that guard in place.
    online();
    mockWire.usage = { data: { days: 30, points: null } };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("growth")).toBeTruthy();
    expect(
      screen.getByText("No sends recorded in this window."),
    ).toBeTruthy();
  });

  it("keeps an invoice row whose link fails the redirect allow-list readable", async () => {
    // The amount and status are why someone opened the list; a row we refuse to
    // open must still show them, and must say so instead of looking tappable.
    online();
    mockWire.invoices = {
      data: [
        {
          id: "in_2",
          number: "INV-0002",
          date: "Jul 1, 2026",
          amount: "$49.00",
          status: "paid",
          downloadUrl: "javascript:alert(1)",
        },
      ],
    };
    await render(<BillingScreen />, { wrapper });

    expect(await screen.findByText("$49.00")).toBeTruthy();
    expect(screen.getByText("No link")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });
});
