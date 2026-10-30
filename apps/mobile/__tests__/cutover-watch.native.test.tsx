import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Migrations from "../app/(tabs)/migrations";

/**
 * GOVERNANCE#53 — the post-cutover watch, rendered through the real screen.
 *
 * The two behaviours worth pinning are the ones a plausible implementation
 * gets wrong, and both are about NOT making a claim the data cannot support:
 *
 *  1. A STOPPED MONITOR'S COUNTERS ARE FROZEN. "0 source events since cutover"
 *     off a stopped monitor is byte-identical to the same sentence off a live
 *     one, and it is the sentence that loses a customer's data during a pilot
 *     overlap. The stopped fact must outrank every number under it.
 *  2. MOBILE NEVER GRANTS A SIGN-OFF. `PATCH …/source-events/{id}/review`
 *     with status=reviewed requires a reconciliation narrative plus auditable
 *     evidence references. The only control this surface offers is the SAFE
 *     direction — re-opening a sign-off, which puts a cutover gate back.
 *
 * `useCutoverWatch` is mocked because the payload SHAPES matter (every count
 * `number | null`, `enabled` on both monitors); a generic query stub would let
 * every loaded-state assertion pass on the error path (house rule 10).
 */

const mockShadow = { current: undefined as unknown };
const mockEvents = { current: undefined as unknown };
const mockReopen = jest.fn(async () => ({}));

jest.mock("@/hooks/useCutoverWatch", () => ({
  shouldReadCutoverWatch: (status: string | null | undefined) =>
    String(status ?? "").toLowerCase() === "completed",
  useShadowWatch: () => mockShadow.current,
  useSourceEventWatch: () => mockEvents.current,
  useReopenSourceEventReview: () => ({
    isPending: false,
    mutateAsync: mockReopen,
    mutate: jest.fn(),
    reset: jest.fn(),
    data: undefined,
    error: null,
    variables: undefined,
  }),
}));

// The job LIST and its source catalogue moved here from the catch-all
// `@/hooks/useOps` (COMMERCE#60), so this factory — which declares the whole
// module surface — has to carry them or the screen calls `undefined`.
const mockJobs: { current: unknown } = { current: undefined };
const mockSources: { current: unknown } = { current: undefined };
jest.mock("@/hooks/useMigrations", () => ({
  useMobileMigrations: () => mockJobs.current,
  useMobileMigrationSources: () => mockSources.current,
  useMigrationVerification: () => ({
    data: null,
    error: null,
    isError: false,
    isLoading: false,
    refetch: async () => ({ data: null }),
  }),
  useMigrationRollback: () => ({
    data: null,
    error: null,
    isError: false,
    isLoading: false,
    refetch: async () => ({ data: null }),
  }),
  // Empty snapshot: the parity card renders nothing without data, so these
  // assertions stay about the watch screen rather than the card.
  useMobileMailchimpParity: () => ({
    data: null,
    error: null,
    isError: false,
    isLoading: false,
    refetch: async () => ({ data: null }),
  }),
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
    source: "klaviyo",
    status: "completed",
    started_at: "2026-07-20T08:00:00.000Z",
    completed_at: "2026-07-20T14:00:00.000Z",
    progress: { subscribers_done: 1200, subscribers_total: 1200 },
    ...over,
  };
}

function shadowWatch(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalSeconds: 3600,
    lastCheckedAt: "2026-07-25T10:00:00.000Z",
    nextCheckAt: "2026-07-25T11:00:00.000Z",
    lastAction: "ready_for_cutover_review",
    lastError: null,
    history: [],
    ...over,
  };
}

function eventWatch(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalSeconds: 3600,
    enabledSince: "2026-07-20T14:00:00.000Z",
    lastEventAt: null,
    lastSyncedAt: "2026-07-25T10:00:00.000Z",
    nextSyncAt: "2026-07-25T11:00:00.000Z",
    lastError: null,
    eventsSeen: 0,
    eventsApplied: 0,
    events: [],
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
    view.getByLabelText("Open the verification report for the Klaviyo import"),
  );
}

function seedList(rows: readonly unknown[]) {
  mockJobs.current = queryResult({ data: rows });
  mockSources.current = queryResult({ data: [] });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  mockJobs.current = undefined;
  mockSources.current = undefined;
  mockShadow.current = undefined;
  mockEvents.current = undefined;
  mockReopen.mockClear();
});

describe("post-cutover watch", () => {
  it("says nothing is watching rather than implying the source is quiet", async () => {
    seedList([job()]);
    // Both monitors 404 — nobody ever started a watch for this job.
    mockShadow.current = queryResult({ data: null });
    mockEvents.current = queryResult({ data: null });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("No cutover watch is running")).toBeTruthy();
    expect(view.queryByText("Source is quiet")).toBeNull();
  });

  it("only says the source is quiet while the watch is actually running", async () => {
    seedList([job()]);
    mockShadow.current = queryResult({ data: shadowWatch() });
    mockEvents.current = queryResult({ data: eventWatch() });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("Source is quiet")).toBeTruthy();
  });

  // The load-bearing case. Identical counters, one stopped monitor.
  it("outranks frozen counters with the fact that the watch stopped", async () => {
    seedList([job()]);
    mockShadow.current = queryResult({ data: shadowWatch() });
    mockEvents.current = queryResult({
      data: eventWatch({ enabled: false }),
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("The watch is stopped")).toBeTruthy();
    expect(view.queryByText("Source is quiet")).toBeNull();
    // The monitor's own row states it too, as a word rather than a dimming.
    expect(
      view.getByLabelText(/Source events, stopped\./),
    ).toBeTruthy();
  });

  it("renders an unreported count as an em-dash, never as zero", async () => {
    seedList([job()]);
    mockShadow.current = queryResult({ data: shadowWatch() });
    mockEvents.current = queryResult({
      data: eventWatch({ eventsSeen: null, eventsApplied: null }),
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("— seen")).toBeTruthy();
  });

  it("leads with pending manual reviews over a clean shadow verdict", async () => {
    seedList([job()]);
    mockShadow.current = queryResult({ data: shadowWatch() });
    mockEvents.current = queryResult({
      data: eventWatch({
        eventsSeen: 3,
        eventsApplied: 2,
        events: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            resourceType: "activecampaign_non_email_contact",
            action: "manual_review",
            occurredAt: "2026-07-25T09:40:00.000Z",
            applied: false,
            reviewed: false,
            reviewDetail: null,
            reviewedAt: null,
            error: null,
          },
        ],
      }),
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("1 source change needs manual review")).toBeTruthy();
    // An OPEN review carries no re-open control: there is no sign-off to undo.
    expect(view.queryByText("Re-open")).toBeNull();
  });

  it("offers re-open — and only re-open — on a signed-off review", async () => {
    seedList([job()]);
    mockShadow.current = queryResult({ data: shadowWatch() });
    mockEvents.current = queryResult({
      data: eventWatch({
        eventsSeen: 1,
        eventsApplied: 0,
        events: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            resourceType: "activecampaign_non_email_contact",
            action: "manual_review",
            occurredAt: "2026-07-24T09:40:00.000Z",
            applied: false,
            reviewed: true,
            reviewDetail: "Reconciled against the CRM export.",
            reviewedAt: "2026-07-24T12:00:00.000Z",
            error: null,
          },
        ],
      }),
    });
    const view = await renderScreen();
    await openReport(view);
    expect(view.getByText("Re-open")).toBeTruthy();
    // The one direction mobile must never offer.
    expect(view.queryByText(/Sign off/i)).toBeNull();
    expect(view.queryByText(/Mark reviewed/i)).toBeNull();
    expect(view.getByText("Reconciled against the CRM export.")).toBeTruthy();
  });

  it("does not render the watch at all for a job that has not completed", async () => {
    seedList([job({ status: "importing", completed_at: null })]);
    mockShadow.current = queryResult({ data: null });
    mockEvents.current = queryResult({ data: null });
    const view = await renderScreen();
    await openReport(view);
    expect(view.queryByText("Cutover watch")).toBeNull();
  });
});
