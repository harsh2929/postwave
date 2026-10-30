import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

/**
 * SavedReportsSection — DASHBOARD#33.
 *
 * Four claims, each of them a way this surface could mislead:
 *
 *   - TWO GATES, NOT ONE. Reading definitions/runs is `ScopeReadReports`
 *     (any role); RUNNING is `ScopeAdmin` (owner|admin). A viewer must see the
 *     shortlist and NOT see a Run control — the previous generation of this
 *     mistake was hiding the whole section from people entitled to read it.
 *   - THE 202 IS NOT A QUEUE. `Repo.RunDefinition` inserts the row already
 *     `completed` and the handler answers 202, so the toast must report the
 *     OUTCOME. A run that came back `failed` is an error, not a success.
 *   - A NEVER-RUN REPORT IS NOT A ZERO-ROW REPORT.
 *   - COPY IS OFFERED ONLY FOR A COMPLETED RUN, because `RunResultToJSON`
 *     refuses any other status with a 422.
 *
 * Mock shapes match the hooks' real return types — `useSavedReportDefinitions`
 * resolves to `SavedReportDefinition[]`, already parsed (house rule 10).
 */
import type {
  SavedReportDefinition,
  SavedReportRun,
} from "@/lib/savedReports";

function def(over: Partial<SavedReportDefinition> = {}): SavedReportDefinition {
  return {
    id: "def-1",
    name: "Weekly revenue",
    description: "",
    productArea: "commerce",
    status: "active",
    metricCount: 2,
    dimensions: ["day"],
    window: "last 7 days",
    updatedAt: "2026-07-20T00:00:00Z",
    ...over,
  };
}

function run(over: Partial<SavedReportRun> = {}): SavedReportRun {
  return {
    id: "run-1",
    definitionId: "def-1",
    status: "completed",
    rowsTotal: 42,
    error: "",
    completedAt: "2026-07-25T09:00:00Z",
    createdAt: "2026-07-25T09:00:00Z",
    ...over,
  };
}

const mockState = {
  definitions: [def()] as SavedReportDefinition[],
  runs: [run()] as SavedReportRun[],
  role: "owner" as string,
  readEnabledWith: [] as boolean[],
  runCalls: [] as string[],
  runResult: run() as SavedReportRun | null,
  runThrows: false,
  toasts: [] as { kind: string; message: string }[],
};

jest.mock("@/hooks/useSavedReports", () => ({
  useSavedReportDefinitions: (allowed: boolean) => {
    mockState.readEnabledWith.push(allowed);
    return {
      data: allowed ? mockState.definitions : undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      isSuccess: allowed,
      refetch: jest.fn(async () => undefined),
    };
  },
  useSavedReportRuns: (allowed: boolean) => ({
    data: allowed ? mockState.runs : undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    isSuccess: allowed,
    refetch: jest.fn(async () => undefined),
  }),
  useRunSavedReport: () => ({
    isPending: false,
    mutate: (
      id: string,
      opts: {
        onSuccess?: (result: SavedReportRun | null) => void;
        onError?: (err: unknown) => void;
      } = {},
    ) => {
      mockState.runCalls.push(id);
      if (mockState.runThrows) opts.onError?.(new Error("boom"));
      else opts.onSuccess?.(mockState.runResult);
    },
  }),
}));

jest.mock("@/api/savedReports", () => ({
  fetchSavedReportExport: async () => ({ run_id: "run-1", rows: [] }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (value: { kind: string; message: string }) => {
      mockState.toasts.push(value);
    },
  }),
}));

jest.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    enabled: true,
    baseUrl: "https://api.moosewave.com",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: mockState.role,
    canReadOfflineSnapshots: true,
  }),
}));

// eslint-disable-next-line import/first
import { SavedReportsSection } from "@/components/analytics/SavedReportsSection";

beforeEach(() => {
  mockState.definitions = [def()];
  mockState.runs = [run()];
  mockState.role = "owner";
  mockState.readEnabledWith = [];
  mockState.runCalls = [];
  mockState.runResult = run();
  mockState.runThrows = false;
  mockState.toasts = [];
});

const HIDDEN = { includeHiddenElements: true } as const;

async function renderSection() {
  return await render(React.createElement(SavedReportsSection));
}

describe("SavedReportsSection", () => {
  it("lets a VIEWER read the shortlist — the reads are ScopeReadReports", async () => {
    mockState.role = "viewer";
    const screen = await renderSection();
    expect(screen.getByText("Saved reports", HIDDEN)).toBeTruthy();
    expect(screen.getByText("Weekly revenue", HIDDEN)).toBeTruthy();
    expect(mockState.readEnabledWith.every((v) => v === true)).toBe(true);
  });

  it("hides the Run control from a viewer — running is ScopeAdmin", async () => {
    mockState.role = "viewer";
    const screen = await renderSection();
    expect(screen.queryByLabelText("Run Weekly revenue now")).toBeNull();
    // …but the read-only action stays, because the export route is a read.
    expect(
      screen.getByLabelText("Copy the last export of Weekly revenue"),
    ).toBeTruthy();
  });

  it("offers Run to an owner and reports the OUTCOME, never 'queued'", async () => {
    const screen = await renderSection();
    const button = screen.getByLabelText("Run Weekly revenue now");
    fireEvent.press(button);

    expect(mockState.runCalls).toEqual(["def-1"]);
    await waitFor(() =>
      expect(mockState.toasts).toContainEqual({
        kind: "success",
        message: "Run completed — 42 rows.",
      }),
    );
  });

  it("treats a run that came back FAILED as an error despite the 202", async () => {
    mockState.runResult = run({
      status: "failed",
      error: "metric blocked",
      rowsTotal: 0,
    });
    const screen = await renderSection();
    fireEvent.press(screen.getByLabelText("Run Weekly revenue now"));

    await waitFor(() =>
      expect(mockState.toasts).toContainEqual({
        kind: "error",
        message: "Run failed: metric blocked",
      }),
    );
  });

  it("says a never-run report has never run, rather than showing zero rows", async () => {
    mockState.runs = [];
    const screen = await renderSection();
    expect(screen.getByText("Never run from here.", HIDDEN)).toBeTruthy();
    expect(screen.queryByText(/0 rows/, HIDDEN)).toBeNull();
  });

  it("does not offer Copy for a run that is not completed", async () => {
    mockState.runs = [run({ status: "failed", error: "metric blocked" })];
    const screen = await renderSection();
    expect(
      screen.queryByLabelText("Copy the last export of Weekly revenue"),
    ).toBeNull();
    // The failure is still stated — and as a word, not just a colour.
    expect(screen.getByLabelText("The last run of this report failed")).toBeTruthy();
  });

  it("is an empty state, not a claim, when no report has been authored", async () => {
    mockState.definitions = [];
    const screen = await renderSection();
    expect(screen.getByText("No saved reports", HIDDEN)).toBeTruthy();
  });
});
