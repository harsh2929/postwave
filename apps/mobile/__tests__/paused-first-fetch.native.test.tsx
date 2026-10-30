/**
 * A paused first fetch is "offline", not "none" — on the screens that hand
 * QueryStates a HAND-BUILT query composite.
 *
 * `useOnlineQueryGate().enabled` is AUTH state (a validated session), not
 * reachability. A session validated at 09:00 that loses signal at 10:30 keeps
 * the gate open, and TanStack PAUSES the first fetch of any screen it had not
 * cached: `status: 'pending'`, `fetchStatus: 'paused'` — isPending:true,
 * isPaused:true, and isLoading:false because v5 defines isLoading as
 * isPending && isFetching. QueryStates reads the two paused fields for its
 * offline branch, and a direct query result carries them. A literal
 * `query={{ isError, isLoading, error, refetch }}` does not: it drops them,
 * and the screen falls through to its REAL empty sentence — "No provisioning
 * tokens", "DLQ is clear", "No breach incidents" — for data it never fetched.
 * On governance screens that is the worst sentence they can print.
 *
 * Every case below mounts a screen (or the component that owns the composite)
 * with that paused result and asserts the typed-out offline sentence is shown
 * and the empty sentence is not. The source scan in
 * `src/lib/offlineEmptyStateGate.test.ts` holds every composite to the rule;
 * these prove the forwarded fields actually reach QueryStates, including
 * through the prop chains (audit-sinks' DlqSection, the audit tab's export and
 * investigation sheets).
 *
 * The same state reaches past QueryStates: the header counters a screen
 * derives for itself (`isPausedFirstFetch`) must read as unknown, not 0, and
 * the export sheet's Start button must not offer what its copy says it can't.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuditExportSheet } from "@/components/audit/AuditExportSheet";
import { IncidentRegisterEmpty } from "@/components/privacy-incidents/IncidentRegisterEmpty";
import { ToastProvider } from "@/components/Toast";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { EMDASH } from "@/lib/format";

import Audit from "../app/(tabs)/audit";
import AuditAlerts from "../app/(tabs)/audit-alerts";
import AuditSinks from "../app/(tabs)/audit-sinks";
import FlowAbTests from "../app/(tabs)/flow-ab-tests";
import InboundWebhooks from "../app/(tabs)/inbound-webhooks";
import Scim from "../app/(tabs)/scim";
import SubscriberImports from "../app/(tabs)/subscriber-imports";

// `@/hooks/useScimOps`, `useAuditSinkOps`, `useAudit` and `useOnlineQueryGate`
// all resolve to ONE proxy module (jest.routes.config.cjs), so this handle
// drives the gate and those hooks' results; every other query hook runs for
// real against the `@tanstack/react-query` harness below.
const queryHooks = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  /** `useIsOnline()` (OS reachability); reset by __resetOnlineGateForTests. */
  __setIsOnlineForTests: (value: boolean) => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

/** Exactly what TanStack v5 reports for a first fetch paused by NetInfo. */
function pausedFirstFetch() {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    fetchStatus: "paused",
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPaused: true,
    isPending: true,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
    status: "pending",
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("governance screens with a paused first fetch", () => {
  it("SCIM says reconnect for both lists instead of claiming none exist", async () => {
    queryHooks.__setHookResultForTests("useMobileScimTokens", pausedFirstFetch());
    queryHooks.__setHookResultForTests(
      "useMobileScimRoleMappings",
      pausedFirstFetch(),
    );
    await render(<Scim />, { wrapper });

    expect(
      screen.getByText(
        "Reconnect to load SCIM tokens. Revoking a token is never queued for later — it has to reach the server now.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Reconnect to load role mappings.")).toBeTruthy();
    expect(screen.queryByText("No provisioning tokens")).toBeNull();
    expect(screen.queryByText("No role mappings")).toBeNull();
  });

  it("audit sinks says connect for the sinks AND the dead letter queue", async () => {
    queryHooks.__setHookResultForTests("useMobileAuditSinks", pausedFirstFetch());
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      pausedFirstFetch(),
    );
    await render(<AuditSinks />, { wrapper });

    expect(
      screen.getByText(
        "Connect to your workspace to load live sink health. Resetting a circuit is never queued for later — it has to reach the server now.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Connect to your workspace to load the dead letter queue.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No streaming destinations")).toBeNull();
    expect(screen.queryByText("DLQ is clear")).toBeNull();
  });

  it("the alert roster says connect instead of 'No alert rules'", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHooks.__setHookResultForTests("useAuditScopes", {
      data: {
        scopes: ["audit:read", "audit:configure_sinks"],
        auditScopes: ["audit:read", "audit:configure_sinks"],
        isAdmin: true,
      },
      error: null,
      isError: false,
      isLoading: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<AuditAlerts />, { wrapper });

    expect(
      screen.getByText(
        "Connect to your workspace to load the alert roster. A cached answer to 'is this detection watching right now' would be worse than none.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No alert rules")).toBeNull();
  });

  it("the breach register says connect instead of 'No breach incidents'", async () => {
    await render(
      <IncidentRegisterEmpty
        dataState="current"
        forbidden={false}
        incidents={
          pausedFirstFetch() as unknown as React.ComponentProps<
            typeof IncidentRegisterEmpty
          >["incidents"]
        }
        listFailed={false}
        restoredPageMalformed={false}
        rows={[]}
      />,
      { wrapper },
    );

    expect(
      screen.getByText(
        "Connect to your workspace to load the breach register. A cached 72-hour countdown of unknown age would be worse than none.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No breach incidents")).toBeNull();
  });
});

describe("audit tab sheets with a paused first fetch", () => {
  it("the export history says connect instead of 'No exports yet'", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<Audit />, { wrapper });

    await fireEvent.press(screen.getByLabelText("Export the audit log"));
    // The sheet is open (its own standing copy), so what follows is ITS state.
    await waitFor(() =>
      expect(screen.getByText(/Collect the CSV from the web admin/u)).toBeTruthy(),
    );

    expect(
      screen.getByText(
        "Connect to your workspace to see previous exports. An export always runs on the server, so it cannot be started offline.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No exports yet")).toBeNull();
  });

  // The history's paused first fetch IS TanStack saying the device is offline,
  // and the start mutation (networkMode "online") would pause the same way,
  // silently. So the button beside "it cannot be started offline" must not
  // offer to start one.
  it("the Start button agrees with the history: it needs a connection and is disabled", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<Audit />, { wrapper });

    await fireEvent.press(screen.getByLabelText("Export the audit log"));
    await waitFor(() =>
      expect(screen.getByText(/Collect the CSV from the web admin/u)).toBeTruthy(),
    );

    const start = screen.getByLabelText("Export needs a connection");
    expect(start.props.accessibilityState).toEqual({ disabled: true });
    expect(screen.queryByLabelText("Export this window")).toBeNull();
  });

  it("the investigation queue says it needs a connection instead of 'No investigations'", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<Audit />, { wrapper });

    await fireEvent.press(screen.getByLabelText("AI investigations"));
    await waitFor(() =>
      expect(
        screen.getByText(/The investigator agent correlates a window/u),
      ).toBeTruthy(),
    );

    expect(
      screen.getByText(
        "Investigations need a connection. Nothing has been loaded on this device yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No investigations")).toBeNull();
  });
});

// CRIT-2. A paused first fetch is only ONE way the sheet learns the device is
// offline. A history that loaded before the signal dropped is not paused, and
// `canStart` is auth state, so the button went on offering "Export this
// window" beside copy saying an export cannot be started offline. The sheet
// reads OS reachability as well.
describe("the export sheet's Start button once the history has loaded", () => {
  /** Yesterday's finished export: loaded, nothing in flight. */
  const DONE_JOB = {
    id: "job-1",
    status: "completed",
    createdAt: "2026-09-13T08:00:00Z",
    completedAt: "2026-09-13T08:02:00Z",
    exportedRows: 120,
    estimatedRows: 120,
  };

  function renderLoadedSheet(onStart: () => void) {
    return render(
      <AuditExportSheet
        visible
        onClose={jest.fn()}
        scope={{
          body: { since: "2026-09-13T00:00:00Z" },
          applied: "Everything in the last 24 hours.",
          dropped: null,
        }}
        jobs={[DONE_JOB]}
        loading={false}
        isPending={false}
        isPaused={false}
        isError={false}
        canStart
        starting={false}
        onStart={onStart}
        schedules={{
          rows: [],
          loading: false,
          failed: false,
          canManage: false,
          creating: false,
          create: jest.fn(async () => true),
          removing: false,
          remove: jest.fn(async () => true),
        }}
      />,
      { wrapper },
    );
  }

  it("offline, it says it needs a connection and a tap starts nothing", async () => {
    queryHooks.__setIsOnlineForTests(false);
    const onStart = jest.fn();
    await renderLoadedSheet(onStart);

    // The LOADED history, not the paused-first-fetch branch above.
    expect(screen.getByText("Ready · 120 rows")).toBeTruthy();

    const start = screen.getByLabelText("Export needs a connection");
    expect(start.props.accessibilityState).toEqual({ disabled: true });
    expect(screen.queryByLabelText("Export this window")).toBeNull();
    await fireEvent.press(start);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("online, the same loaded sheet offers the export and starts it", async () => {
    const onStart = jest.fn();
    await renderLoadedSheet(onStart);

    expect(screen.getByText("Ready · 120 rows")).toBeTruthy();
    const start = screen.getByLabelText("Export this window");
    expect(start.props.accessibilityState).toEqual({ disabled: false });
    await fireEvent.press(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe("operational screens with a paused first fetch", () => {
  it("subscriber imports says connect instead of 'Nothing importing'", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<SubscriberImports />, { wrapper });

    expect(
      screen.getByText(
        "Connect to your workspace to load import jobs. They aren't cached — a stale answer to 'is it still running' is worse than none.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing importing")).toBeNull();
  });

  it("inbound webhooks says it needs a connection instead of 'No inbound endpoints'", async () => {
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<InboundWebhooks />, { wrapper });

    expect(
      screen.getByText(
        "Inbound endpoints need a connection. Nothing has been loaded on this device yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No inbound endpoints")).toBeNull();
  });

  it("flow A/B tests says connect instead of 'No in-flow A/B tests'", async () => {
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<FlowAbTests />, { wrapper });

    expect(
      screen.getByText(
        "Connect to your workspace to load in-flow A/B tests. A cached conversion rate of unknown age is worse than none.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No in-flow A/B tests")).toBeNull();
  });
});

// The body saying "reconnect" is half of it. The header ABOVE the body is read
// first — and spoken first — so a counter there that says 0 claims exactly the
// zero the body just disowned. On a compliance screen "0 failing" is an
// all-clear. Each counter below must read as unknown (an em-dash), not as 0.
describe("header counters with a paused first fetch", () => {
  it("SCIM's token and mapping tiles are unmeasured, not zero", async () => {
    queryHooks.__setHookResultForTests("useMobileScimTokens", pausedFirstFetch());
    queryHooks.__setHookResultForTests(
      "useMobileScimRoleMappings",
      pausedFirstFetch(),
    );
    await render(<Scim />, { wrapper });

    expect(screen.getByLabelText("Active tokens failed to load")).toBeTruthy();
    expect(screen.getByLabelText("Mappings failed to load")).toBeTruthy();
    expect(screen.queryByLabelText("0 Active tokens")).toBeNull();
    expect(screen.queryByLabelText("0 Mappings")).toBeNull();
  });

  it("audit sinks' open / failing / DLQ counters and the Sinks label are unknown", async () => {
    queryHooks.__setHookResultForTests("useMobileAuditSinks", pausedFirstFetch());
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      pausedFirstFetch(),
    );
    await render(<AuditSinks />, { wrapper });

    expect(screen.getByLabelText("Circuit open unavailable")).toBeTruthy();
    expect(screen.getByLabelText("Failing unavailable")).toBeTruthy();
    expect(screen.getByLabelText("DLQ unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("0 Failing")).toBeNull();
    expect(screen.getByText("Sinks")).toBeTruthy();
    expect(screen.queryByText("Sinks (0)")).toBeNull();
  });

  it("the alert roster's subtitle does not say '0 of 0 rules watching'", async () => {
    queryHooks.__setHookResultForTests("hasAuditReadScope", true);
    queryHooks.__setHookResultForTests("useAuditScopes", {
      data: {
        scopes: ["audit:read", "audit:configure_sinks"],
        auditScopes: ["audit:read", "audit:configure_sinks"],
        isAdmin: true,
      },
      error: null,
      isError: false,
      isLoading: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<AuditAlerts />, { wrapper });

    expect(screen.getByText(`${EMDASH} watching`)).toBeTruthy();
    expect(screen.queryByText("0 of 0 rules watching")).toBeNull();
  });

  it("subscriber imports' subtitle does not say '0 of 0 imports running'", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "admin" });
    queryHarness.__setQueryResultForTests(pausedFirstFetch());
    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText(`${EMDASH} running`)).toBeTruthy();
    expect(screen.queryByText("0 of 0 imports running")).toBeNull();
  });
});
