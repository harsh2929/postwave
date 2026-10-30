/**
 * ExportRetentionCard — the render contract (register: export retention
 * policy view + edit, settings).
 *
 * The bounds/patch/copy policy is pinned in src/lib/exportRetentionPolicy
 * .test.ts and the transport in src/api/exportRetentionPolicy.test.ts; this
 * file pins the row at the foot of the Workspace-exports card:
 *
 *  - the summary sentence is the server's numbers, never a placeholder;
 *  - inputs seed from the saved policy; Save is disabled until something
 *    changes; a save sends ONLY the changed field and caches the answer;
 *  - an out-of-range draft is refused before any request; a 409 capacity
 *    conflict shows the server's sentence verbatim;
 *  - below admin the policy is readable and the inputs are absent;
 *  - loading / offline / a non-policy shape in the cache are silence, not a
 *    throw; the row is MOUNTED inside DataExportsSection and on Settings.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockPatchCalls: unknown[] = [];
let mockPatchAnswer: { data: unknown; error: unknown } = { data: null, error: null };
jest.mock("@/api/exportRetentionPolicy", () => ({
  getExportRetentionPolicy: jest.fn(async () => ({ data: null, error: null })),
  patchExportRetentionPolicy: async (body: unknown) => {
    mockPatchCalls.push(body);
    return mockPatchAnswer;
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

// eslint-disable-next-line import/first -- must follow the api/toast mocks.
import { DataExportsSection } from "@/components/settings/DataExportsSection";
// eslint-disable-next-line import/first
import { ExportRetentionCard } from "@/components/settings/ExportRetentionCard";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryClientForTests: () => { setQueryData: jest.Mock };
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

/** The policy exactly as lib/exportRetentionPolicy normalizes it. */
const POLICY = {
  retentionDays: 30,
  maxPerTenant: 20,
  currentStorageBytes: 2048,
  updatedAt: "",
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

const SAVE = "Save export retention policy";

afterEach(() => {
  mockPatchCalls.length = 0;
  mockToasts.length = 0;
  mockPatchAnswer = { data: null, error: null };
  refetch.mockClear();
  queryHarness.__getQueryClientForTests().setQueryData.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("ExportRetentionCard", () => {
  it("states the server's numbers and seeds the inputs from them", async () => {
    queryHarness.__setQueryResultForTests(result({ data: POLICY }));
    await render(<ExportRetentionCard />);
    expect(
      screen.getByText(
        "New bundles are kept 30 days after completion, up to 20 active exports. 2 KB stored now.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Not yet saved — using the defaults.")).toBeTruthy();
    expect(screen.getByLabelText("Retention days").props.value).toBe("30");
    expect(screen.getByLabelText("Active exports").props.value).toBe("20");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(true);
  });

  it("sends ONLY the changed field, caches the answer, and mockToasts", async () => {
    queryHarness.__setQueryResultForTests(result({ data: POLICY }));
    const saved = { ...POLICY, retentionDays: 45, updatedAt: "2026-09-02T10:00:00Z" };
    mockPatchAnswer = { data: saved, error: null };
    await render(<ExportRetentionCard />);
    await fireEvent.changeText(screen.getByLabelText("Retention days"), "45");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ retention_days: 45 }]);
    const client = queryHarness.__getQueryClientForTests();
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData.mock.calls[0]?.[1]).toEqual(saved);
    expect(mockToasts).toEqual([
      { kind: "success", message: "Export retention policy saved." },
    ]);
  });

  it("refuses an out-of-range draft before any request leaves the phone", async () => {
    queryHarness.__setQueryResultForTests(result({ data: POLICY }));
    await render(<ExportRetentionCard />);
    await fireEvent.changeText(screen.getByLabelText("Retention days"), "3");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([]);
    expect(screen.getByRole("alert").props.children).toMatch(/7-2555 days/u);
  });

  it("shows a 409 capacity conflict in the server's own words", async () => {
    queryHarness.__setQueryResultForTests(result({ data: POLICY }));
    const sentence =
      "cannot lower max_per_tenant to 2 while 4 export jobs are queued, running, or ready";
    mockPatchAnswer = {
      data: null,
      error: { status: 409, code: "export_capacity_conflict", message: sentence },
    };
    await render(<ExportRetentionCard />);
    await fireEvent.changeText(screen.getByLabelText("Active exports"), "2");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockPatchCalls).toEqual([{ max_per_tenant: 2 }]);
    expect(screen.getByRole("alert").props.children).toBe(sentence);
    expect(mockToasts).toEqual([{ kind: "error", message: sentence }]);
    expect(queryHarness.__getQueryClientForTests().setQueryData).not.toHaveBeenCalled();
  });

  it("lets a lower role read the policy but not edit it", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(result({ data: POLICY }));
    await render(<ExportRetentionCard />);
    expect(screen.getByText(/kept 30 days after completion/u)).toBeTruthy();
    expect(screen.queryByLabelText("Retention days")).toBeNull();
    expect(screen.queryByLabelText(SAVE)).toBeNull();
    expect(screen.getByText("Only workspace admins can change export retention.")).toBeTruthy();
  });

  it("shows a skeleton on first load", async () => {
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<ExportRetentionCard />);
    expect(screen.getByLabelText("Loading export retention")).toBeTruthy();
  });

  // One `it` per render: RNTL's `screen` stays bound to an explicitly
  // unmounted tree, so a second render inside one test queries a dead tree.
  it("shows the offline notice with the gate closed and nothing cached", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(result({ data: undefined }));
    await render(<ExportRetentionCard />);
    expect(screen.getByText("Reconnect to load the export retention policy.")).toBeTruthy();
  });

  it("renders the empty state, not a throw, for a bare array in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: [POLICY] }));
    await render(<ExportRetentionCard />);
    expect(screen.getByText("No retention policy")).toBeTruthy();
    expect(screen.queryByText(/undefined/u)).toBeNull();
  });

  it("renders the empty state, not a throw, for a paged envelope in the cache", async () => {
    queryHarness.__setQueryResultForTests(result({ data: { items: [] } }));
    await render(<ExportRetentionCard />);
    expect(screen.getByText("No retention policy")).toBeTruthy();
  });

  it("is MOUNTED at the foot of DataExportsSection", async () => {
    await render(<DataExportsSection />);
    expect(screen.getByText("Retention")).toBeTruthy();
    expect(screen.getByLabelText("Loading export retention")).toBeTruthy();
  });

  it("reaches the Settings screen for an admin", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
    });
    await render(<Settings />, { wrapper });
    expect(screen.getByLabelText("Loading export retention")).toBeTruthy();
  });
});
