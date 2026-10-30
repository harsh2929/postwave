/**
 * Agent routines — the render contract for the list and the detail sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH. The list screen makes ONE claim per row that
 * is not on the wire: when the platform will next run the routine, and whether
 * it is late. That is arithmetic over `last_run_at` + the schedule interval,
 * mirroring `Repo.FindDue`. If it regresses, the screen tells an operator their
 * Monday brief is fine when it has not run in a week — a silent, confident lie,
 * which is exactly the class of bug a render test can pin and a pure test
 * cannot (the pure ordering/derivation rules live in
 * lib/agentRoutineSchedule.test.ts; this file proves they reach the screen).
 *
 * WHY THE SHEET IS RENDERED DIRECTLY RATHER THAN OPENED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so a route test that opened the sheet would hand the run
 * history the routine array and vice versa — the mock-shape mismatch that made
 * a whole round of suites pass while asserting nothing (house rule 10). The
 * sheet takes its data as props, so it is driven with genuinely run-shaped
 * payloads here and the route keeps genuinely routine-shaped ones.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { AgentRoutineDetailSheet } from "@/components/agent-routines/AgentRoutineDetailSheet";
import {
  parseRoutine,
  parseRunList,
  type AgentRoutine,
} from "@/lib/agentRoutines";

import AgentRoutines from "../app/(tabs)/agent-routines";

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

/** The exact shape `useAgentRoutines` resolves to: `AgentRoutine[]`. */
function loaded(routines: readonly AgentRoutine[]) {
  return {
    data: routines,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: routines })),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function routine(overrides: Record<string, unknown> = {}): AgentRoutine {
  return parseRoutine({
    id: "r-1",
    name: "Monday re-engagement",
    prompt: "Draft a win-back campaign for subscribers idle 90 days",
    kind: "draft_campaign",
    schedule: "weekly",
    require_approval: true,
    enabled: true,
    last_run_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    created_by: "ops@example.test",
    created_at: "2026-06-01T09:00:00Z",
    ...overrides,
  })!;
}

describe("the agent-routines list", () => {
  it("renders a bounded first frame while the catalogue is still loading", async () => {
    const view = await render(<AgentRoutines />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Agent routines").length).toBeGreaterThan(0);
  });

  it("offers the four buckets that partition the set the scheduler sees", async () => {
    await render(<AgentRoutines />, { wrapper });

    // Scheduled / Manual / Paused mirror `WHERE enabled AND schedule <>
    // 'manual'` exactly, so every routine appears in precisely one of them.
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Scheduled")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("shows a loaded routine with its schedule and its approval gate", async () => {
    queryHarness.__setQueryResultForTests(loaded([routine()]));

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText("Monday re-engagement")).toBeTruthy();
    expect(screen.getByText(/Drafts a campaign/)).toBeTruthy();
    expect(screen.getByText(/Weekly/)).toBeTruthy();
    // `require_approval` is the safety story; the row states it rather than
    // leaving the reader to assume a human is still in the loop.
    expect(screen.getByText("Approval gated")).toBeTruthy();
  });

  it("says plainly when a routine has NO approval gate", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([routine({ require_approval: false })]),
    );

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText("No approval gate")).toBeTruthy();
    expect(screen.queryByText("Approval gated")).toBeNull();
  });

  it("badges a routine the platform has actually missed", async () => {
    // Weekly, last run nine days ago: `FindDue` has been matching this for two
    // days. This is the one claim the list can make about health, and it is
    // the reason the surface is worth opening on a phone.
    queryHarness.__setQueryResultForTests(
      loaded([
        routine({ last_run_at: new Date(Date.now() - 9 * DAY_MS).toISOString() }),
      ]),
    );

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText(/Overdue since/)).toBeTruthy();
  });

  it("does not badge a routine that is merely approaching its next run", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([
        routine({ last_run_at: new Date(Date.now() - 1 * DAY_MS).toISOString() }),
      ]),
    );

    await render(<AgentRoutines />, { wrapper });

    expect(screen.queryByText("Overdue")).toBeNull();
    expect(screen.getByText(/Next run/)).toBeTruthy();
  });

  it("never renders a never-run routine as though it ran at the epoch", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([routine({ last_run_at: null })]),
    );

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText(/Never run/)).toBeTruthy();
    expect(screen.queryByText(/1970/)).toBeNull();
    expect(screen.queryByText(/1 January/)).toBeNull();
  });

  it("marks a paused routine as one the scheduler cannot see", async () => {
    queryHarness.__setQueryResultForTests(
      loaded([routine({ enabled: false })]),
    );

    await render(<AgentRoutines />, { wrapper });

    // "Paused" appears twice by design — once as the filter chip and once as
    // this row's status pill — so assert the PILL by its accessibility label,
    // which is unique and is what a screen-reader user actually receives.
    expect(
      screen.getByLabelText("Paused: this routine never runs automatically."),
    ).toBeTruthy();
    expect(screen.getByText(/Paused — no automatic runs/)).toBeTruthy();
  });

  it("reads an offline session as offline, never as an empty catalogue", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText("No agent routines yet")).toBeNull();
  });

  it("renders the genuinely-empty catalogue as empty, and says where routines come from", async () => {
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<AgentRoutines />, { wrapper });

    expect(screen.getByText("No agent routines yet")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'no routines'", async () => {
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

    await render(<AgentRoutines />, { wrapper });

    expect(screen.queryByText("No agent routines yet")).toBeNull();
  });
});

/** The exact shape `useAgentRoutineRuns` resolves to: `AgentRoutineRun[]`. */
const RUNS = parseRunList({
  items: [
    {
      id: "run-2",
      routine_id: "r-1",
      status: "failed",
      error: "voice service returned 502",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      id: "run-1",
      routine_id: "r-1",
      status: "succeeded",
      output_kind: "campaign",
      output_ref: "cmp-9",
      approval_id: "apr-4",
      reasoning: "4,120 lapsed subscribers; a win-back offer fits the brief.",
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
    routine: routine(),
    runs: RUNS,
    runsQuery: SETTLED_RUNS,
    gate: { enabled: true },
    now: Date.now(),
    onClose: jest.fn(),
    onRunNow: jest.fn(),
    running: false,
    canRun: true,
    online: true,
    onToggleEnabled: jest.fn(),
        togglingEnabled: false,
        onOpenApproval: jest.fn(),
    ...overrides,
  };
}

describe("the routine detail sheet", () => {
  it("is the only place a run OUTCOME appears, and shows both terminal states", async () => {
    await render(<AgentRoutineDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();
    // The failure text is the operator's only lead on why.
    expect(screen.getByText("voice service returned 502")).toBeTruthy();
  });

  it("shows the model's own reasoning, which is the trust record", async () => {
    await render(<AgentRoutineDetailSheet {...sheetProps()} />, { wrapper });

    expect(
      screen.getByText(/4,120 lapsed subscribers/),
    ).toBeTruthy();
  });

  it("links a run straight to the approval it opened", async () => {
    await render(<AgentRoutineDetailSheet {...sheetProps()} />, { wrapper });

    // `Run.approval_id` is on the wire, so this hand-off costs no request.
    expect(screen.getByText("Review the approval it opened")).toBeTruthy();
  });

  it("offers Run now to an editor", async () => {
    await render(<AgentRoutineDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Run now")).toBeTruthy();
    expect(screen.queryByText(/Read-only for your role/)).toBeNull();
  });

  it("tells a viewer why, instead of letting them discover a 403", async () => {
    await render(
      <AgentRoutineDetailSheet {...sheetProps({ canRun: false })} />,
      { wrapper },
    );

    expect(screen.getByText(/Read-only for your role/)).toBeTruthy();
    expect(screen.queryByText("Run now")).toBeNull();
  });

  it("refuses to start a run offline, and says why it is not queued", async () => {
    await render(
      <AgentRoutineDetailSheet {...sheetProps({ online: false })} />,
      { wrapper },
    );

    expect(screen.getByText(/never queued for later/)).toBeTruthy();
  });

  it("renders an empty history as 'never run', not as a failure", async () => {
    await render(
      <AgentRoutineDetailSheet {...sheetProps({ runs: [] })} />,
      { wrapper },
    );

    expect(screen.getByText("No runs recorded")).toBeTruthy();
  });

  it("renders a failed history fetch as an error, never as 'never run'", async () => {
    await render(
      <AgentRoutineDetailSheet
        {...sheetProps({
          runs: [],
          runsQuery: { ...SETTLED_RUNS, isError: true, isSuccess: false },
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("No runs recorded")).toBeNull();
  });

  it("shows the standing brief the agent is actually given", async () => {
    await render(<AgentRoutineDetailSheet {...sheetProps()} />, { wrapper });

    expect(
      screen.getByText("Draft a win-back campaign for subscribers idle 90 days"),
    ).toBeTruthy();
  });
});
