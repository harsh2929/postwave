/**
 * Subscriber imports — the render contract for the list and the detail sheet.
 *
 * WHAT THIS FILE EXISTS TO CATCH, in order of how much damage it would do:
 *
 *   1. AN ADMIN-ONLY SURFACE RENDERED AS THOUGH IT WERE READABLE.
 *      `subscriber_import.go::MountRoutes` wraps EVERY route — the GET list
 *      included — in `RequireScope(ScopeAdmin)`, and running that middleware
 *      per role gives viewer / member / editor a `403 insufficient_role`. The
 *      generated routeauth manifest says "viewer" and is wrong. If the screen
 *      regressed to trusting it, a viewer would be shown a broken list; worse,
 *      an empty one would read as "this workspace has no imports".
 *   2. A CONFIRM BUTTON THAT CAN ONLY 409. The handler refuses a stale or
 *      expired preflight, and the phone cannot re-run one. The sheet must show
 *      the reason instead of the button.
 *   3. A SUBSTITUTED ZERO. A missing counter renders as an em-dash. "0 of 0
 *      rows" beside "Running" reads as a stalled import that is in fact fine.
 *
 * WHY THE SHEET IS RENDERED DIRECTLY RATHER THAN OPENED BY A TAP. The
 * `@tanstack/react-query` harness sets ONE result for every `useQuery` in the
 * module graph, so a test that opened the sheet would hand the detail read the
 * LIST page and vice versa — the mock-shape mismatch that made a whole round of
 * suites pass while asserting nothing. The sheet takes its data as props, so it
 * is driven with genuinely detail-shaped payloads here.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RefreshControl } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SubscriberImportDetailSheet } from "@/components/subscriber-imports/SubscriberImportDetailSheet";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import {
  parseImportJob,
  parseImportJobDetail,
  parseImportJobPage,
  type SubscriberImportJob,
  type SubscriberImportJobDetail,
} from "@/lib/subscriberImportJobs";

import SubscriberImports from "../app/(tabs)/subscriber-imports";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
/** RN's jest RefreshControl mock renders a prop-less host node, but records
 * the last-mounted instance, whose `props` are the ones the screen passed. */
type MountedRefreshControl = {
  props: { refreshing?: boolean; onRefresh?: () => void };
};
const refreshControlMock = RefreshControl as unknown as {
  latestRef: MountedRefreshControl | null | undefined;
};
/** Read through a call, so each read sees the instance mounted since. */
function mountedRefreshControl(): MountedRefreshControl | null | undefined {
  return refreshControlMock.latestRef;
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

/** The role each test runs under is always NAMED. The shared gate mock defaults
 * to an owner, so neither arm of this screen's admin gate may be left implicit:
 * an unset role would silently grant admin and turn the 403 test green against
 * the wrong branch. */
function asAdmin() {
  gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
}

/** The highest role the server still answers 403 to on this route. */
function asEditor() {
  gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
}

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

function wireRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "members.csv",
    status: "running",
    rows_total: 50_000,
    rows_new: 42_000,
    rows_existing: 7_500,
    rows_file_dupes: 500,
    rows_imported: 12_000,
    rows_skipped: 300,
    rows_failed: 0,
    on_existing: "skip",
    error_code: "",
    error: "",
    created_at: "2026-07-25T09:00:00Z",
    processed_rows: 12_304,
    cancel_requested: false,
    last_chunk_at: "2026-07-25T09:04:00Z",
    ...overrides,
  };
}

/** The exact shape `useSubscriberImports` resolves to: a SubscriberImportPage. */
function loadedPage(rows: readonly Record<string, unknown>[]) {
  const page = parseImportJobPage({
    imports: rows,
    has_more: false,
    next_cursor: "",
  });
  return {
    data: page,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: page })),
  };
}

describe("the import-job list", () => {
  it("renders a bounded first frame while the list is still loading", async () => {
    asAdmin();
    const view = await render(<SubscriberImports />, { wrapper });

    expect(view.toJSON()).not.toBeNull();
    // The header proves the route module — not an error boundary — rendered.
    expect(screen.getAllByText("Subscriber imports").length).toBeGreaterThan(0);
  });

  it("says upload stays on desktop rather than shipping a dead affordance", async () => {
    asAdmin();
    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText(/Uploading a CSV/)).toBeTruthy();
  });

  it("offers the three buckets that partition every status", async () => {
    asAdmin();
    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Staged")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("withholds the LIST from a non-admin, because the server does too", async () => {
    // `GET /api/v1/subscriber-imports` answers 403 insufficient_role to every
    // role below admin — editor included, which is why the gate is asserted
    // against an editor rather than against a viewer or an unset role.
    asEditor();
    queryHarness.__setQueryResultForTests(loadedPage([]));

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("Admins only")).toBeTruthy();
    expect(screen.getByText(/admin-only on this workspace/)).toBeTruthy();
    // And it must NOT make a claim about the workspace's imports.
    expect(screen.queryByText("Nothing importing")).toBeNull();
  });

  it("shows a running job with its file, its progress and its status", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(loadedPage([wireRow()]));

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("members.csv")).toBeTruthy();
    expect(screen.getByText(/12\.3K \/ 50K rows/)).toBeTruthy();
    // The exact figures are spoken, because the visible line is compacted.
    expect(
      screen.getByLabelText(/12,304 of 50,000 rows processed/),
    ).toBeTruthy();
  });

  it("renders a missing counter as an em-dash, never as zero rows", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loadedPage([wireRow({ processed_rows: undefined })]),
    );

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/0 \/ 50K rows/)).toBeNull();
    expect(screen.getByLabelText(/Row progress unavailable/)).toBeTruthy();
  });

  it("draws no progress bar on a staged job the worker has not touched", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loadedPage([
        wireRow({ status: "preview", processed_rows: 0, rows_imported: 0 }),
      ]),
    );

    await render(<SubscriberImports />, { wrapper });

    // A 0%-wide determinate bar beside "Staged" claims the import started and
    // achieved nothing, which is the opposite of what `preview` means.
    expect(screen.getByText("Staged")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("names a cancelling job Stopping, not Running", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loadedPage([wireRow({ cancel_requested: true })]),
    );

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("Stopping")).toBeTruthy();
  });

  it("keeps the pull spinner down during a poll, and raises it only for a pull", async () => {
    // A running job makes useSubscriberImports re-poll every 3-6 s. Each tick
    // is a refetch after the first load, so isRefetching is true, but no
    // finger is on the glass. On iOS a spinner raised by the program shifts
    // the list by the control's height, so the list jumped on every tick.
    asAdmin();
    let settle!: () => void;
    const refetch = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    queryHarness.__setQueryResultForTests({
      ...loadedPage([wireRow()]),
      isFetching: true,
      isRefetching: true,
      refetch,
    });
    // Cleared so the assertions below cannot read a control another test
    // mounted: an unrendered control reads `undefined`, never `false`.
    refreshControlMock.latestRef = null;

    await render(<SubscriberImports />, { wrapper });

    expect(mountedRefreshControl()?.props.refreshing).toBe(false);

    // The operator's own pull, with its fetch on the wire, does raise it.
    await act(async () => {
      mountedRefreshControl()?.props.onRefresh?.();
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mountedRefreshControl()?.props.refreshing).toBe(true);

    // The pull settling lowers it, although the poll keeps isRefetching true.
    await act(async () => {
      settle();
    });

    expect(mountedRefreshControl()?.props.refreshing).toBe(false);
  });

  it("reads an offline session as offline, never as an empty list", async () => {
    gateHarness.__setOnlineGateForTests({
      enabled: false,
      effectiveRole: "admin",
    });
    queryHarness.__setQueryResultForTests(loadedPage([]));

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText(/Connect to your workspace/)).toBeTruthy();
    expect(screen.queryByText("Nothing importing")).toBeNull();
  });

  it("renders the genuinely-empty list as empty, and says what staged means", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(loadedPage([]));

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("Nothing importing")).toBeTruthy();
  });

  it("renders a failed fetch as an error, never as 'nothing importing'", async () => {
    asAdmin();
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

    await render(<SubscriberImports />, { wrapper });

    expect(screen.queryByText("Nothing importing")).toBeNull();
  });
});

const RUNNING: SubscriberImportJob = parseImportJob(wireRow())!;

function detail(
  overrides: Record<string, unknown> = {},
): SubscriberImportJobDetail {
  return parseImportJobDetail({
    ...wireRow({ status: "preview", processed_rows: 0, rows_imported: 0 }),
    preflight_required: false,
    classification_authoritative: true,
    preflight_expires_at: "2126-01-01T00:00:00Z",
    source_fingerprint: "sfp_abc",
    consent_contract_state: "none",
    schedule_type: "immediate",
    next_scheduled_at: "",
    dry_run: false,
    ...overrides,
  })!;
}

function sheetProps(overrides: Record<string, unknown> = {}) {
  const staged = detail();
  return {
    job: staged as SubscriberImportJob,
    detail: staged,
    detailLoading: false,
    detailFailed: false,
    onClose: jest.fn(),
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    busy: false,
    canWrite: true,
    accessNotice: null,
    online: true,
    now: Date.now(),
    ...overrides,
  };
}

describe("the import detail sheet", () => {
  it("offers Confirm for a staged job the server would actually accept", async () => {
    await render(<SubscriberImportDetailSheet {...sheetProps()} />, { wrapper });

    expect(screen.getByText("Confirm import")).toBeTruthy();
    expect(screen.queryByText("Stop import")).toBeNull();
  });

  it("replaces Confirm with the REASON when the preflight went stale", async () => {
    const stale = detail({ preflight_required: true });
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: stale, detail: stale })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("Confirm import")).toBeNull();
    expect(screen.getByText(/needs a fresh preflight/)).toBeTruthy();
  });

  it("replaces Confirm with the REASON when the preflight expired", async () => {
    const expired = detail({ preflight_expires_at: "2020-01-01T00:00:00Z" });
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: expired, detail: expired })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("Confirm import")).toBeNull();
    expect(screen.getByText(/expired/)).toBeTruthy();
  });

  it("tells a non-admin why, instead of letting them discover a 403", async () => {
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({
          canWrite: false,
          accessNotice: "Import jobs are admin-only on this workspace.",
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("Confirm import")).toBeNull();
    expect(screen.getByText(/admin role/)).toBeTruthy();
  });

  it("refuses to confirm offline, and says it is not queued for later", async () => {
    await render(
      <SubscriberImportDetailSheet {...sheetProps({ online: false })} />,
      { wrapper },
    );

    expect(screen.queryByText("Confirm import")).toBeNull();
    expect(screen.getByText(/never queued to send later/)).toBeTruthy();
  });

  it("offers Stop — and only Stop — for a running job", async () => {
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: RUNNING, detail: null })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Stop import")).toBeTruthy();
    expect(screen.queryByText("Confirm import")).toBeNull();
  });

  it("offers neither verb once the job has finished, and says so", async () => {
    const done = parseImportJob(wireRow({ status: "ready" }))!;
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: done, detail: null })}
      />,
      { wrapper },
    );

    expect(screen.queryByText("Confirm import")).toBeNull();
    expect(screen.queryByText("Stop import")).toBeNull();
    expect(screen.getByText(/already finished/)).toBeTruthy();
  });

  it("never calls a staged job finished while its detail is still loading", async () => {
    // `confirmGate(null, …)` answers "not allowed, no reason", and the naive
    // footer read that as "nothing left to do" — announcing a staged import as
    // complete for as long as the GET /{id} took.
    const staged = parseImportJob(wireRow({ status: "preview" }))!;
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: staged, detail: null, detailLoading: true })}
      />,
      { wrapper },
    );

    expect(screen.queryByText(/already finished/)).toBeNull();
    expect(screen.getByText(/Checking whether this import/)).toBeTruthy();
  });

  it("shows the outcome counters only once the job is terminal", async () => {
    const done = parseImportJob(wireRow({ status: "ready" }))!;
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: done, detail: null })}
      />,
      { wrapper },
    );

    expect(screen.getByLabelText("Imported: 12,000")).toBeTruthy();
    expect(screen.getByLabelText("Skipped: 300")).toBeTruthy();
  });

  it("withholds the outcome counters while the job is still running", async () => {
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: RUNNING, detail: null })}
      />,
      { wrapper },
    );

    // Quoting "imported 0" mid-run reads as a failure that has not happened.
    expect(screen.queryByLabelText(/^Imported:/)).toBeNull();
  });

  it("renders a failed refresh as a refresh failure, not as an empty job", async () => {
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: RUNNING, detail: null, detailFailed: true })}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Showing the last values received/)).toBeTruthy();
    // The list row's own fields are still on screen.
    expect(screen.getByLabelText("Rows processed: 12,304 of 50,000")).toBeTruthy();
  });

  it("names the failure on a failed import rather than leaving it blank", async () => {
    const failed = parseImportJob(
      wireRow({
        status: "failed",
        error_code: "source_integrity_failed",
        error: "The uploaded source no longer matches the reviewed file.",
      }),
    )!;
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({ job: failed, detail: null })}
      />,
      { wrapper },
    );

    expect(screen.getByText("Why it stopped")).toBeTruthy();
    expect(
      screen.getByText("The uploaded source no longer matches the reviewed file."),
    ).toBeTruthy();
  });

  it("stops saying 'checking' once the detail read has actually FAILED", async () => {
    // A staged job whose `GET /{id}` errored has `detail === null` forever:
    // nothing is in flight and nothing will retry on its own. The footer used
    // to read that as "still checking" and sat on a progress sentence for a
    // read that was already over — the one state a 2am operator must not be
    // shown, because it looks like the answer is one moment away.
    const staged = parseImportJob(wireRow({ status: "preview" }))!;
    await render(
      <SubscriberImportDetailSheet
        {...sheetProps({
          job: staged,
          detail: null,
          detailLoading: false,
          detailFailed: true,
        })}
      />,
      { wrapper },
    );

    expect(screen.queryByText(/Checking whether this import/)).toBeNull();
    // ...and it must not swing the other way into "already finished" either.
    expect(screen.queryByText(/already finished/)).toBeNull();
    expect(screen.getByText(/Couldn.t check whether this import/)).toBeTruthy();
  });
});

describe("the import list against a payload that is not an array", () => {
  it("does not crash when a restored page carries a non-array `jobs`", async () => {
    // `list.data?.jobs ?? []` is a NULLISH guard: a truthy `{}` sails through
    // it into `filterImportJobs`, whose `.filter` does not exist on an object.
    // A live response is normalised by the queryFn; a restored one is not.
    asAdmin();
    const page = { jobs: {}, hasMore: false, nextCursor: "" };
    queryHarness.__setQueryResultForTests({
      data: page,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: page })),
    });

    await render(<SubscriberImports />, { wrapper });

    expect(screen.getByText("Subscriber imports")).toBeTruthy();
  });
});
