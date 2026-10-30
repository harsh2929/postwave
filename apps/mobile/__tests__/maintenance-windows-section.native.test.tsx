/**
 * MaintenanceWindowsSection — the render contract (register: maintenance
 * windows list + CRUD, settings).
 *
 * Phase/grouping/validation/actions are pinned in src/lib/maintenanceWindows
 * .test.ts and the transport in src/api/maintenanceWindows.test.ts; this file
 * pins what an on-call admin meets on the Settings screen:
 *
 *  - windows group under Active / Upcoming / Past with a worded phase pill;
 *    a platform-wide row says so and offers no verb;
 *  - an admin gets Start now / Mark complete / Cancel per the status, each a
 *    single call that re-reads the list; Cancel confirms first and a declined
 *    confirm sends nothing; a 403 on a verb mockToasts the role rule;
 *  - a viewer sees the rows and no verbs, and no schedule button;
 *  - the schedule sheet refuses an empty title before any request and POSTs
 *    the validated body;
 *  - a 403/404 hides the card; a 500 says so with Retry; a paged envelope is
 *    the empty state; the card is MOUNTED on Settings for an admin.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockCalls: Array<{ verb: string; args: unknown[] }> = [];
let mockWriteAnswer: { data: unknown; error: unknown } = { data: { updated: true }, error: null };
jest.mock("@/api/maintenanceWindows", () => ({
  listMaintenanceWindows: jest.fn(async () => ({ data: [], error: null })),
  createMaintenanceWindow: async (...args: unknown[]) => {
    mockCalls.push({ verb: "create", args });
    return mockWriteAnswer;
  },
  setMaintenanceWindowStatus: async (...args: unknown[]) => {
    mockCalls.push({ verb: "status", args });
    return mockWriteAnswer;
  },
  cancelMaintenanceWindow: async (...args: unknown[]) => {
    mockCalls.push({ verb: "cancel", args });
    return mockWriteAnswer;
  },
}));

const mockConfirmCalls: Record<string, unknown>[] = [];
let mockConfirmAnswer = true;
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockConfirmCalls.push(options);
    return mockConfirmAnswer;
  },
}));

const mockToasts: Array<{ kind: string; message: string }> = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the mocks above.
import { MaintenanceWindowsSection } from "@/components/settings/MaintenanceWindowsSection";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const refetch = jest.fn(async () => ({}));

function result(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch,
    ...over,
  };
}

const FAR = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * 3_600_000).toISOString();

/** Rows exactly as lib/maintenanceWindows normalizes them (the query's data). */
function win(over: Record<string, unknown> = {}) {
  return {
    id: "w1",
    title: "DB failover",
    description: "swap primary",
    components: ["api", "smtp"],
    startsAt: FAR(24),
    endsAt: FAR(25),
    status: "scheduled",
    platform: false,
    ...over,
  };
}

const ROWS = [
  win(),
  win({ id: "live", title: "Cert rotation", status: "in_progress", components: [], description: "renewing" }),
  win({ id: "plat", title: "Region move", platform: true, description: "", components: [] }),
  win({ id: "done", title: "Old patch", status: "completed", startsAt: FAR(-48), endsAt: FAR(-47), components: ["dashboard"], description: "" }),
];

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

afterEach(() => {
  mockCalls.length = 0;
  mockConfirmCalls.length = 0;
  mockToasts.length = 0;
  mockConfirmAnswer = true;
  mockWriteAnswer = { data: { updated: true }, error: null };
  refetch.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("MaintenanceWindowsSection", () => {
  it("groups windows by phase with a worded pill, and marks platform-wide rows", async () => {
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("Maintenance windows")).toBeTruthy();
    for (const label of ["Active", "Upcoming", "Past"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("DB failover")).toBeTruthy();
    expect(screen.getByText("Affects api, smtp")).toBeTruthy();
    expect(screen.getByText("swap primary")).toBeTruthy();
    expect(screen.getByText("Cert rotation")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Platform-wide — managed by Moosewave.")).toBeTruthy();
    // A platform-wide row is not this tenant's to change.
    expect(screen.queryByLabelText("Start now: Region move")).toBeNull();
    expect(screen.queryByLabelText("Cancel: Region move")).toBeNull();
  });

  it("offers an admin the status-appropriate verbs and re-reads after one", async () => {
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByLabelText("Schedule a maintenance window")).toBeTruthy();
    expect(screen.getByLabelText("Mark complete: Cert rotation")).toBeTruthy();
    expect(screen.queryByLabelText("Start now: Old patch")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Start now: DB failover"));
    await act(async () => {});
    expect(mockCalls).toEqual([{ verb: "status", args: ["w1", "in_progress"] }]);
    expect(mockConfirmCalls).toEqual([]);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mockToasts).toEqual([{ kind: "success", message: '"DB failover" is now in progress.' }]);
  });

  it("confirms before cancelling, and a declined confirm sends nothing", async () => {
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    mockConfirmAnswer = false;
    await render(<MaintenanceWindowsSection />);
    await fireEvent.press(screen.getByLabelText("Cancel: DB failover"));
    await act(async () => {});
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockConfirmCalls[0]?.destructive).toBe(true);
    expect(mockCalls).toEqual([]);
    expect(refetch).not.toHaveBeenCalled();

    mockConfirmAnswer = true;
    mockWriteAnswer = { data: { cancelled: true }, error: null };
    await fireEvent.press(screen.getByLabelText("Cancel: DB failover"));
    await act(async () => {});
    expect(mockCalls).toEqual([{ verb: "cancel", args: ["w1"] }]);
    expect(mockToasts).toEqual([{ kind: "success", message: 'Cancelled "DB failover".' }]);
  });

  it("toasts the role rule when a verb answers 403 and does not re-read", async () => {
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    mockWriteAnswer = { data: null, error: { status: 403, message: "forbidden" } };
    await render(<MaintenanceWindowsSection />);
    await fireEvent.press(screen.getByLabelText("Mark complete: Cert rotation"));
    await act(async () => {});
    expect(mockToasts).toEqual([
      { kind: "error", message: "Only workspace admins can change maintenance windows." },
    ]);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("shows a viewer the rows with no verbs and no schedule button", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(result({ data: ROWS }));
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("DB failover")).toBeTruthy();
    expect(screen.queryByLabelText("Schedule a maintenance window")).toBeNull();
    expect(screen.queryByLabelText("Start now: DB failover")).toBeNull();
    expect(screen.queryByLabelText("Cancel: DB failover")).toBeNull();
  });

  it("refuses to schedule without a title, then POSTs the validated body", async () => {
    queryHarness.__setQueryResultForTests(result({ data: [] }));
    mockWriteAnswer = { data: { id: "w9" }, error: null };
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("No maintenance windows")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Schedule a maintenance window"));
    await fireEvent.press(screen.getByLabelText("Schedule window"));
    await act(async () => {});
    expect(mockCalls).toEqual([]);
    expect(screen.getByText("Give the window a title.")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Title"), " Rotate certs ");
    await fireEvent.changeText(screen.getByLabelText("Affected components"), "api, smtp,, api");
    await fireEvent.press(screen.getByLabelText("Schedule window"));
    await act(async () => {});
    expect(mockCalls).toHaveLength(1);
    const body = mockCalls[0]?.args[0] as Record<string, unknown>;
    expect(body.title).toBe("Rotate certs");
    expect(body.components).toEqual(["api", "smtp"]);
    expect(new Date(body.ends_at as string).getTime()).toBeGreaterThan(
      new Date(body.starts_at as string).getTime(),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mockToasts).toEqual([{ kind: "success", message: 'Scheduled "Rotate certs".' }]);
  });

  // One `it` per render: RNTL's `screen` stays bound to an explicitly
  // unmounted tree, so a second render inside one test queries a dead tree.
  it("hides on a 403 — the Go mount floors the read at admin", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("forbidden"), { status: 403 }),
      }),
    );
    await render(<MaintenanceWindowsSection />);
    expect(screen.toJSON()).toBeNull();
  });

  it("says a 500 failed and Retry refetches THIS query", async () => {
    queryHarness.__setQueryResultForTests(
      result({
        isError: true,
        isSuccess: false,
        error: Object.assign(new Error("upstream down"), { status: 500 }),
      }),
    );
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("Maintenance windows")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("treats a paged envelope in the cache as empty, never a throw", async () => {
    queryHarness.__setQueryResultForTests(result({ data: { items: [] } }));
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("No maintenance windows")).toBeTruthy();
  });

  it("folds past windows beyond three behind a counted disclosure", async () => {
    const past = [1, 2, 3, 4, 5].map((n) =>
      win({ id: `p${n}`, title: `Past ${n}`, status: "completed", startsAt: FAR(-n * 24), endsAt: FAR(-n * 24 + 1) }),
    );
    queryHarness.__setQueryResultForTests(result({ data: past }));
    await render(<MaintenanceWindowsSection />);
    expect(screen.getByText("Past 3")).toBeTruthy();
    expect(screen.queryByText("Past 4")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Show 2 older windows"));
    expect(screen.getByText("Past 5")).toBeTruthy();
  });

  it("is MOUNTED on the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    await render(<Settings />, { wrapper });
    expect(screen.getByLabelText("Loading maintenance windows")).toBeTruthy();
  });
});
