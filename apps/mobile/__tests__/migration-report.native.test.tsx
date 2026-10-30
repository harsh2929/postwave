import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Migrations from "../app/(tabs)/migrations";

/**
 * GOVERNANCE#7: the verification report was fetchable and unreachable. The two
 * states worth pinning are the ones a naive implementation gets wrong:
 *
 *  1. NO REPORT IS NOT A FAILURE. The service answers 404 with "verification
 *     report not yet available" for any job that has not written one
 *     (services/migration/internal/handlers/migration.go:2910), which is the
 *     normal answer for a job that is still importing. The hook resolves that
 *     to `null`; the sheet must then render the status-appropriate sentence,
 *     not an error card.
 *  2. A COMPLETED IMPORT WITH LOSS MUST NOT READ AS CLEAN. That is the entire
 *     reason a phone needs this screen.
 *
 * `useMigrations` is mocked because the two payload SHAPES matter — the parsed
 * `MigrationVerification` (every count `number | null`) and the rollback
 * progress — and a generic query stub would let the loaded assertions pass on
 * an error path.
 */

const mockVerification = { current: undefined as unknown };
const mockRollback = { current: undefined as unknown };

// The job LIST and its source catalogue moved here from the catch-all
// `@/hooks/useOps` (COMMERCE#60), so this factory — which declares the whole
// module surface — has to carry them or the screen calls `undefined`.
const mockJobs: { current: unknown } = { current: undefined };
const mockSources: { current: unknown } = { current: undefined };
jest.mock("@/hooks/useMigrations", () => ({
  useMobileMigrations: () => mockJobs.current,
  useMobileMigrationSources: () => mockSources.current,
  useMigrationVerification: () => mockVerification.current,
  useMigrationRollback: () => mockRollback.current,
  // Empty snapshot: the parity card renders nothing without data, so these
  // assertions stay about the screen under test rather than the card.
  useMobileMailchimpParity: () => ({ data: undefined, isLoading: false }),
}));


const queryHooks = require("./mocks/queryHooks.cjs");

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function job(over: Record<string, unknown> = {}) {
  return {
    id: "job_0123456789abcdef",
    source: "mailchimp",
    status: "completed",
    started_at: "2026-07-20T08:00:00.000Z",
    progress: { subscribers_done: 1200, subscribers_total: 1200 },
    ...over,
  };
}

function renderScreen() {
  return render(React.createElement(Migrations), {
    wrapper: ({ children }) => (
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

type View = Awaited<ReturnType<typeof renderScreen>>;

async function openReport(view: View) {
  await fireEvent.press(
    view.getByLabelText(
      "Open the verification report for the Mailchimp import",
    ),
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  mockJobs.current = undefined;
  mockSources.current = undefined;
  mockVerification.current = undefined;
  mockRollback.current = undefined;
});

function seedList(rows: readonly unknown[]) {
  mockJobs.current = queryResult({ data: rows });
  mockSources.current = queryResult({ data: [] });
  mockRollback.current = queryResult({ data: null });
}

describe("migration verification report", () => {
  it("offers the report on a job card", async () => {
    seedList([job()]);
    mockVerification.current = queryResult({ data: null });
    const view = await renderScreen();
    expect(
      view.getByLabelText(
        "Open the verification report for the Mailchimp import",
      ),
    ).toBeTruthy();
  });

  it("says a running job simply has no report yet, not that something failed", async () => {
    seedList([job({ status: "importing" })]);
    mockVerification.current = queryResult({ data: null });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText(/No verification report yet/)).toBeTruthy();
    expect(view.queryByText(/Estimated data loss/)).toBeNull();
  });

  it("flags a completed job whose report is missing as unusual", async () => {
    seedList([job({ status: "completed" })]);
    mockVerification.current = queryResult({ data: null });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText(/That is unusual/)).toBeTruthy();
  });

  it("never lets an import with estimated loss read as clean", async () => {
    seedList([job()]);
    mockVerification.current = queryResult({
      data: {
        subscribersImported: 1200,
        suppressionListSize: 40,
        consentKnown: 1100,
        consentUnknown: 100,
        duplicatesMerged: 3,
        segmentsTranslated: 8,
        segmentWarnings: 1,
        automationsTranslated: 4,
        automationsUnsupported: 2,
        templatesImported: null,
        archiveImported: 90,
        customFieldsMapped: 6,
        customFieldsUnmapped: 1,
        dataLossEstimatePct: 2.5,
        resources: [
          {
            resource: "subscribers",
            imported: 1200,
            expected: 1230,
            completeness: 0.9756,
            note: null,
          },
        ],
        discoveryWarnings: ["Source API rate limited during discovery"],
      },
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("Estimated data loss")).toBeTruthy();
    expect(view.queryByText("No warnings")).toBeNull();
    // A count the report omitted is an em-dash, never a zero.
    expect(view.getByLabelText("Templates: not reported")).toBeTruthy();
    expect(view.getByLabelText("Subscribers: 1200")).toBeTruthy();
    expect(
      view.getByLabelText("Unsupported automations: 2"),
    ).toBeTruthy();
    expect(
      view.getByText("Source API rate limited during discovery"),
    ).toBeTruthy();
  });

  it("surfaces a rollback in flight above the report", async () => {
    seedList([job({ status: "rolling_back" })]);
    mockVerification.current = queryResult({ data: null });
    mockRollback.current = queryResult({
      data: {
        state: "running",
        deleted: 400,
        total: 1200,
        startedAt: null,
        finishedAt: null,
        error: null,
      },
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByLabelText("Rollback running, 400 / 1,200 removed")).toBeTruthy();
  });
});
