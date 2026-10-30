/**
 * Audience syncs — the render contract for the list and the detail sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. This surface makes exactly one claim that is
 * not on the wire — whether the platform is LATE — and it reads one that is
 * (`last_run_status`) with more nuance than a two-state UI would. If either
 * regresses, the screen tells an operator the nightly push to their warehouse
 * is fine when it failed at 3am, which is a silent, confident lie and precisely
 * the class of bug a render test can pin and a pure test cannot. The pure
 * derivation rules live in lib/audienceSyncHealth.test.ts; this file proves
 * they reach the screen.
 *
 * WHY THE SHEET IS RENDERED DIRECTLY RATHER THAN OPENED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so a test that opened the sheet would hand the run history the
 * sync array and vice versa — the mock-shape mismatch that makes a suite pass
 * while asserting nothing (house rule 10). The sheet takes its data as props,
 * so it is driven with genuinely run-shaped payloads here and the route keeps
 * genuinely sync-shaped ones.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { AudienceSyncDetailSheet } from "@/components/audience-syncs/AudienceSyncDetailSheet";
import {
  parseSync,
  parseSyncRunList,
  type AudienceSync,
} from "@/lib/audienceSyncs";

import AudienceSyncs from "../app/(tabs)/audience-syncs";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

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

/** The exact shape `useAudienceSyncs` resolves to: `AudienceSync[]`. */
function loaded(syncs: readonly AudienceSync[]) {
  return {
    data: syncs,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: syncs })),
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function sync(overrides: Record<string, unknown> = {}): AudienceSync {
  return parseSync({
    id: "s-1",
    name: "Warehouse mirror",
    source: { segment_id: "seg-1" },
    destination: {
      type: "webhook",
      url: "https://in.example.test/postwave",
      secret_set: true,
      secret_hint: "••••beef",
    },
    schedule: "daily",
    enabled: true,
    last_run_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    last_run_status: "succeeded",
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-06-01T09:00:00Z",
    ...overrides,
  })!;
}

describe("the audience-syncs list", () => {
  it("renders a bounded first frame while the catalogue is still loading", async () => {
    const view = await render(<AudienceSyncs />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Audience syncs").length).toBeGreaterThan(0);
  });

  it("offers the three states worth opening a phone for", async () => {
    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Failing")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("shows a loaded sync with its source, destination and schedule", async () => {
    queryHarness.__setQueryResultForTests(loaded([sync()]));

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText("Warehouse mirror")).toBeTruthy();
    expect(screen.getByText(/Segment/)).toBeTruthy();
    expect(screen.getByText(/Webhook/)).toBeTruthy();
    expect(screen.getByText(/Daily/)).toBeTruthy();
  });

  it("says on the LIST that last night's run failed — no tap required", async () => {
    // This is the whole reason the surface is worth a phone: `last_run_status`
    // is denormalised onto the sync row, so the verdict is one request away.
    queryHarness.__setQueryResultForTests(
      loaded([sync({ last_run_status: "failed" })]),
    );

    await render(<AudienceSyncs />, { wrapper });

    expect(
      screen.getByLabelText(
        "Failing: its last run did not fully succeed, so the destination is out of date.",
      ),
    ).toBeTruthy();
  });

  it("treats a PARTIAL run as failing, not as a success with a caveat", async () => {
    // Rows DID leave the platform, so the destination holds part of the
    // audience. Anything that reads as "succeeded" here is a data-integrity lie.
    queryHarness.__setQueryResultForTests(
      loaded([sync({ last_run_status: "partial" })]),
    );

    await render(<AudienceSyncs />, { wrapper });

    // "Failing" is also a filter chip, so assert the row's PILL by its
    // accessibility label — unique, and what a screen-reader user receives.
    expect(
      screen.getByLabelText(
        "Failing: its last run did not fully succeed, so the destination is out of date.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("badges a scheduled sync the platform has actually missed", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([
        sync({ last_run_at: new Date(Date.now() - 5 * DAY_MS).toISOString() }),
      ]),
    );

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText(/Overdue since/)).toBeTruthy();
  });

  it("does not badge a sync that is merely approaching its next run", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([
        sync({ last_run_at: new Date(Date.now() - 1 * HOUR_MS).toISOString() }),
      ]),
    );

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText(/Next run/)).toBeTruthy();
    expect(screen.queryByText(/Overdue since/)).toBeNull();
  });

  it("never renders a never-run sync as though it ran at the epoch", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([sync({ last_run_at: null, last_run_status: "" })]),
    );

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText(/Never run/)).toBeTruthy();
    expect(screen.queryByText(/1970/)).toBeNull();
    expect(screen.queryByText(/1 January/)).toBeNull();
  });

  it("says a paused sync reaches its destination not at all", async () => {
    queryHarness.__setQueryResultForTests(loaded([sync({ enabled: false })]));

    await render(<AudienceSyncs />, { wrapper });

    // "Paused" appears twice by design — the filter chip and this row's pill —
    // so assert the PILL by its accessibility label, which is unique and is
    // what a screen-reader user actually receives.
    expect(
      screen.getByLabelText(
        "Paused: the scheduler skips this sync entirely, so nothing reaches the destination on its own.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Paused — no automatic runs/)).toBeTruthy();
  });

  it("reads an offline session as offline, never as an empty catalogue", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No audience syncs yet")).toBeNull();
  });

  it("renders the genuinely-empty catalogue as empty, and says where syncs come from", async () => {
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText("No audience syncs yet")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no syncs'", async () => {
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: new Error("boom"),
      isError: true,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    });

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.queryByText("No audience syncs yet")).toBeNull();
  });

  /**
   * A REHYDRATED NON-ARRAY CACHE MUST NOT TAKE THE TAB DOWN.
   *
   * The query cache is persisted to disk and restored on launch
   * (lib/secureQueryPersister), whose own header records that a restored
   * payload is handed straight to components writing `query.data ?? []` — a
   * NULLISH guard that passes `{}` and `{items: []}` through. This screen fed
   * that value to `syncFilterCounts`, which iterates with for-of, so the whole
   * tab died with "syncs is not iterable" before a single row rendered.
   *
   * `{items: []}` is the exact envelope the route answers
   * (sync_handlers.go:45), i.e. what a build that skipped `parseSyncList`
   * would have written into the cache.
   */
  it("survives a restored cache holding a truthy non-array", async () => {
    queryHarness.__setQueryResultForTests({
      ...loaded([]),
      data: { items: [] } as unknown as AudienceSync[],
    });

    const view = await render(<AudienceSyncs />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    expect(screen.getByText("Audience syncs")).toBeTruthy();
  });

  it("still renders real rows — the guard must not swallow good input", async () => {
    // A coercion that returned [] unconditionally would pass the test above.
    queryHarness.__setQueryResultForTests(loaded([sync()]));

    await render(<AudienceSyncs />, { wrapper });

    expect(screen.getByText("Warehouse mirror")).toBeTruthy();
  });
});

/** The exact shape `useAudienceSyncRuns` resolves to: `AudienceSyncRun[]`. */
const RUNS = parseSyncRunList({
  items: [
    {
      id: "run-2",
      sync_id: "s-1",
      status: "failed",
      rows_exported: 0,
      batches_sent: 0,
      source_members_observed: 4120,
      excluded_count: 118,
      cap_exceeded: false,
      error: "destination returned 502 Bad Gateway",
      trigger_kind: "scheduled",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      id: "run-1",
      sync_id: "s-1",
      status: "succeeded",
      rows_exported: 4002,
      batches_sent: 9,
      source_members_observed: 4120,
      excluded_count: 118,
      cap_exceeded: false,
      trigger_kind: "manual",
      provider_status: "AUDIENCE_READY",
      external_job_id: "job-77",
      started_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
      finished_at: new Date(Date.now() - 8 * DAY_MS + 42_000).toISOString(),
    },
  ],
});

const SETTLED_RUNS = {
  isError: false,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
};

function sheetProps(overrides: Record<string, unknown> = {}) {
  return {
    sync: sync(),
    runs: RUNS,
    runsQuery: SETTLED_RUNS,
    gate: { enabled: true },
    now: Date.now(),
    onClose: jest.fn(),
    onRunNow: jest.fn(),
    running: false,
    canRun: true,
    online: true,
    ...overrides,
  };
}

describe("the sync detail sheet", () => {
  it("is where the REASON lives, and shows both terminal states", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();
    // The failure text is the operator's only lead on why.
    expect(screen.getByText("destination returned 502 Bad Gateway")).toBeTruthy();
  });

  it("keeps resolved, withheld and delivered as three separate numbers", async () => {
    // Conflating them would let someone conclude their audience shrank when in
    // fact their consent posture tightened.
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Withheld").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    expect(screen.getAllByText("118").length).toBeGreaterThan(0);
    expect(screen.getByText("4,002")).toBeTruthy();
  });

  it("echoes the provider's own words rather than translating them", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/AUDIENCE_READY/)).toBeTruthy();
  });

  it("states that batches are signed, without ever holding the key", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/Signed with an HMAC key ending/)).toBeTruthy();
  });

  it("warns when a webhook destination has no signing key at all", async () => {
    await render(
      <AudienceSyncDetailSheet
        {...sheetProps({
          sync: sync({
            destination: {
              type: "webhook",
              url: "https://in.example.test/postwave",
              secret_set: false,
            },
          }),
        })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/cannot verify these batches came from Moosewave/)).toBeTruthy();
  });

  it("offers Run now to an editor", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Run now")).toBeTruthy();
    expect(screen.queryByText(/Read-only for your role/)).toBeNull();
  });

  it("tells a viewer why, instead of letting them discover a 403", async () => {
    await render(
      <AudienceSyncDetailSheet {...sheetProps({ canRun: false })} />,
      { wrapper },
    );

    expect(screen.getByText(/Read-only for your role/)).toBeTruthy();
    expect(screen.queryByText("Run now")).toBeNull();
  });

  it("disables Run now on a PAUSED sync, because the server refuses it", async () => {
    // beginSyncOperation returns ErrLifecycleBlocked → 409. This is the
    // opposite of agent routines, where a manual run on a paused routine works.
    await render(
      <AudienceSyncDetailSheet {...sheetProps({ sync: sync({ enabled: false }) })} />,
      { wrapper },
    );

    expect(screen.getByText(/server refuses a manual run on a paused sync/)).toBeTruthy();
    expect(screen.getByLabelText("Run now").props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it("refuses to start a run offline, and says why it is not queued", async () => {
    await render(
      <AudienceSyncDetailSheet {...sheetProps({ online: false })} />,
      { wrapper },
    );

    expect(screen.getByText(/never queued for later/)).toBeTruthy();
  });

  it("says the run is inline, so nobody waits for a background result", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/the result comes back with it/)).toBeTruthy();
  });

  it("renders an empty history as 'never run', not as a failure", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps({ runs: [] })} />, {
      wrapper,
    });

    expect(screen.getByText("No runs recorded")).toBeTruthy();
  });

  it("renders a failed history fetch as an error, never as 'never run'", async () => {
    await render(
      <AudienceSyncDetailSheet
        {...sheetProps({
          runs: [],
          runsQuery: { ...SETTLED_RUNS, isError: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("No runs recorded")).toBeNull();
  });

  it("says the source and destination are edited elsewhere", async () => {
    await render(<AudienceSyncDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText(/edited on desktop/)).toBeTruthy();
  });
});
