import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * GOVERNANCE#33 — governance is the cluster you are most likely to consult AWAY
 * from connectivity, and two of its six screens answered dishonestly offline.
 *
 * Both hooks behind them are gated `enabled: gate.enabled && Boolean(tenantId)`
 * (useMigrations.ts:72/91, useAgencyOps.ts:51), so with the gate closed the
 * query is DISABLED: `isLoading` false, `isError` false, `data` undefined. Every
 * branch the screens tested was therefore false, and:
 *
 *   - MIGRATIONS fell through to its empty state — "No migration jobs / Start
 *     migrations from desktop; their progress will appear here" — telling an
 *     operator on a train that the import they started an hour ago is not there.
 *   - AGENCY rendered NOTHING. Not an error, not an empty state: a blank
 *     ScrollView presented as a finished screen.
 *
 * These tests pin the honest answer AND its negative — the false sentence must
 * be absent, because an offline notice added *beside* the old empty state would
 * pass a naive assertion while leaving the lie on screen.
 */

const mockJobs: { current: unknown } = { current: undefined };
const mockSources: { current: unknown } = { current: undefined };
jest.mock("@/hooks/useMigrations", () => ({
  useMobileMigrations: () => mockJobs.current,
  useMobileMigrationSources: () => mockSources.current,
  useMigrationVerification: () => ({ data: undefined, isLoading: false }),
  useMigrationRollback: () => ({ data: undefined, isLoading: false }),
  // Empty snapshot: the parity card renders nothing without data, so these
  // assertions stay about the screen under test rather than the card.
  useMobileMailchimpParity: () => ({ data: undefined, isLoading: false }),
}));

import Agency from "../app/(tabs)/agency";
import AuditSinks from "../app/(tabs)/audit-sinks";
import Migrations from "../app/(tabs)/migrations";
import Scim from "../app/(tabs)/scim";

const queryHooks = require("./mocks/queryHooks.cjs");

/**
 * The shape a DISABLED TanStack v5 query actually has. Getting this wrong is
 * the whole point: `isLoading: true` would render a skeleton and the offline
 * branch would never be reached, so the test would pass without testing it.
 */
function disabledQuery(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: true,
    isRefetching: false,
    dataUpdatedAt: 0,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function renderScreen(Component: React.ComponentType) {
  return render(React.createElement(Component), {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
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
  queryHooks.__resetOnlineGateForTests();
  mockJobs.current = undefined;
  mockSources.current = undefined;
});

describe("migrations offline", () => {
  it("says it has no answer — never that there are no jobs", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    mockJobs.current = disabledQuery();
    mockSources.current = disabledQuery();

    const result = await renderScreen(Migrations);

    expect(result.getByText("Reconnect to load migrations")).toBeTruthy();
    expect(result.queryByText("No migration jobs")).toBeNull();
    expect(result.getByText("Reconnect to load source coverage")).toBeTruthy();
    expect(result.queryByText("No source matrix")).toBeNull();
  });

  it("renders the count strip as em-dashes, not a confident 0/0/0", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    mockJobs.current = disabledQuery();
    mockSources.current = disabledQuery();

    const result = await renderScreen(Migrations);

    // ABSENCE IS NOT ZERO: three tiles, all unmeasured.
    expect(result.queryAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(result.queryAllByText("0")).toHaveLength(0);
  });

  it("keeps cached job cards and explains the staleness instead of hiding them", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    mockJobs.current = disabledQuery({
      data: [
        {
          id: "job_0123456789abcdef",
          source: "mailchimp",
          status: "running",
          started_at: "2026-07-20T08:00:00.000Z",
          progress: { subscribers_done: 12, subscribers_total: 100 },
        },
      ],
    });
    mockSources.current = disabledQuery();

    const result = await renderScreen(Migrations);

    // The blocking notice must NOT replace rows we actually hold…
    expect(result.queryByText("Reconnect to load migrations")).toBeNull();
    // …and the counts derived from those rows stay real measurements.
    expect(
      result.getByText(
        "Reconnect before acting on a job. Showing the last loaded progress.",
      ),
    ).toBeTruthy();
    // No Retry affordance: the query is disabled, so a retry could only fail
    // silently.
    expect(result.queryByLabelText("Retry")).toBeNull();
  });

  it("still says 'no migration jobs' when the fetch genuinely succeeded empty", async () => {
    mockJobs.current = disabledQuery({ data: [], isPending: false });
    mockSources.current = disabledQuery({ data: [], isPending: false });

    const result = await renderScreen(Migrations);

    expect(result.getByText("No migration jobs")).toBeTruthy();
    expect(result.queryByText("Reconnect to load migrations")).toBeNull();
  });
});

/**
 * The OTHER half of GOVERNANCE#33: the finding names five screens, and three of
 * them were already honest by the time this ran — approvals through
 * `approvalGateNotice` (pinned in approvalPresentation.test.ts), SCIM and audit
 * sinks through `QueryStates`' offline rung. Reading a component is not proof
 * that a screen wires it, so the two QueryStates callers are rendered here.
 * Without these, a later refactor could drop the `gate` prop and silently
 * reintroduce exactly the state this finding is about.
 */
describe("governance surfaces that were already honest stay honest", () => {
  it("scim reports a lost connection rather than an unprovisioned tenant", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests("useMobileScimTokens", disabledQuery());
    queryHooks.__setHookResultForTests(
      "useMobileScimRoleMappings",
      disabledQuery(),
    );

    const result = await renderScreen(Scim);

    expect(
      result.getByText(
        "Reconnect to load SCIM tokens. Revoking a token is never queued for later — it has to reach the server now.",
      ),
    ).toBeTruthy();
    // The catastrophic misread: "no provisioning tokens" to an admin whose IdP
    // is provisioning users right now.
    expect(result.queryByText("No provisioning tokens")).toBeNull();
    // And the token/mapping counters are unmeasured, not zero.
    expect(result.queryAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("audit sinks report a lost connection rather than an all-clear", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests("useMobileAuditSinks", disabledQuery());
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      disabledQuery(),
    );

    const result = await renderScreen(AuditSinks);

    expect(
      result.getByText(
        "Connect to your workspace to load live sink health. Resetting a circuit is never queued for later — it has to reach the server now.",
      ),
    ).toBeTruthy();
    expect(result.queryByText("No streaming destinations")).toBeNull();
  });
});

describe("agency offline", () => {
  it("never renders private server diagnostics from a partial agency read", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAgencyOverview",
      disabledQuery({
        data: {
          branding: null,
          children: [],
          notAgency: false,
          accessRestricted: false,
          brandingUnavailable: true,
          childrenUnavailable: false,
          errors: [
            {
              surface: "Audit branding",
              message: "private database topology and tenant secret",
            },
          ],
        },
      }),
    );

    const result = await renderScreen(Agency);

    expect(
      result.getByText(
        "Some agency data couldn't be loaded. Audit branding could not be verified.",
      ),
    ).toBeTruthy();
    expect(result.queryByText(/private database topology/u)).toBeNull();
  });

  it("renders an honest notice where it used to render a blank screen", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests(
      "useMobileAgencyOverview",
      disabledQuery(),
    );

    const result = await renderScreen(Agency);

    expect(result.getByText("Reconnect to load your portfolio")).toBeTruthy();
  });

  it("reports a missing workspace before a missing connection", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, tenantId: null });
    queryHooks.__setHookResultForTests(
      "useMobileAgencyOverview",
      disabledQuery(),
    );

    const result = await renderScreen(Agency);

    expect(result.getByText("Reconnect your workspace")).toBeTruthy();
    expect(result.queryByText("Reconnect to load your portfolio")).toBeNull();
  });

  it("keeps the last-good portfolio on screen and marks it stale", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests(
      "useMobileAgencyOverview",
      disabledQuery({
        data: {
          branding: null,
          children: [],
          notAgency: false,
          accessRestricted: false,
          brandingUnavailable: true,
          childrenUnavailable: false,
          errors: [],
        },
      }),
    );

    const result = await renderScreen(Agency);

    expect(result.queryByText("Reconnect to load your portfolio")).toBeNull();
    expect(
      result.getByText(
        "Reconnect to refresh the child roster and stored audit-portal branding. No billing estimate is shown.",
      ),
    ).toBeTruthy();
  });
});
