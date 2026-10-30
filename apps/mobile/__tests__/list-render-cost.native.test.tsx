/**
 * What five list surfaces are allowed to spend per row, per page, and per second.
 *
 * These are not style rules. Each one is a specific way a screen quietly stops
 * working on the only data set that matters — a big one:
 *
 *   THE DUPLICATE QUEUE pages 25 pairs at a time with no ceiling, and every
 *   fetched page used to be `.map()`ed inside a ScrollView. Ten presses of
 *   "Load more" mounted 250 row components at once, none of which could ever be
 *   recycled, on the screen whose whole argument is that it is cheap to open.
 *
 *   THE DSAR QUEUE fetches 100 requests per page into a FlatList with
 *   `scrollEnabled={false}` nested in the sheet's ScrollView. A FlatList that
 *   does not scroll is handed the full content height by its parent, so its
 *   render window covers everything and virtualization is defeated — the list
 *   looks virtualized and is not.
 *
 *   THE SEQUENCES LIST declared its separator inline, which makes it a NEW
 *   component TYPE on every parent render. React cannot reconcile two different
 *   types, so every separator between every visible row is unmounted and
 *   remounted on each keystroke in the search field.
 *
 *   THE LOOKALIKE LIST threaded a 1 Hz clock into the memo that filters and
 *   sorts the whole catalogue and into the props of every row. `LookalikeRow`
 *   is `React.memo`'d, but a `now` that moves every second (and an inline
 *   `onPress`) means the memo never holds, so every visible row re-rendered
 *   once a second for a label ("built 3 weeks ago") that changes once a month.
 *
 *   THE TWO LIST PICKERS ("add to list", "add members") repeated the sequences
 *   defect verbatim: an inline `ItemSeparatorComponent` arrow. Both sit above a
 *   search field whose `q` state is NOT debounced — only the query it sends is
 *   — so the sheet re-renders on every keystroke, and MEASURED, none of the
 *   rendered separators survived one.
 *
 *   THE AGENCY CHILD ROSTER handed every card a fresh `onToggle` arrow and the
 *   card was not memo'd, so expanding one card re-rendered every loaded card
 *   (PERF-6). At 60 cards the toggle cost as much as mounting the roster.
 *
 * The clock assertion below is the same bucket-to-the-minute rule
 * `useDiscountsScreen` documents, which is where this pattern comes from. Its
 * screen-level twin — how many renders a MINUTE of wall time is allowed to
 * cost — lives in ticker-render-cost.native.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import type { MobileAgencyChild } from "@/api/agencyReads";
import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { ChildrenSection } from "@/components/agency/ChildrenSection";
import { DuplicatesScreen } from "@/components/duplicates/DuplicatesScreen";
import { ListAddMembersSheet } from "@/components/lists/ListAddMembersSheet";
import { PrivacyRequestQueue } from "@/components/settings/PrivacyRequestQueue";
import { normalizeDuplicateScanPage } from "@/lib/duplicateScan";
import { parseLookalikeAudience } from "@/lib/lookalikeAudiences";

import Lookalike from "../app/(tabs)/lookalike";
import SequencesIndex from "../app/(tabs)/sequences/index";

const duplicateHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useSubscriberDuplicates", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * The lookalike clock is driven by hand rather than by timers: the claim is
 * about what a SECOND of wall time costs versus a MINUTE, and a real 1 Hz
 * interval would make that a sixty-second test.
 *
 * The stand-in HONOURS `resolutionMs`, which is what keeps the assertions
 * below load-bearing after the bucketing moved from the screen into the hook.
 * The real hook floors to the bucket and suppresses the state update while the
 * bucket is unchanged; a caller that forgets to ask for `MINUTE_MS` gets the
 * default of 1 — the raw clock — and the "unchanged across a second" test
 * fails, exactly as it would in the app.
 */
const mockClock = { now: Date.parse("2026-08-22T10:00:00.000Z") };
jest.mock("@/hooks/useTickingNow", () => ({
  MINUTE_MS: 60_000,
  useTickingNow: (_active: boolean, resolutionMs = 1) =>
    resolutionMs > 1
      ? Math.floor(mockClock.now / resolutionMs) * resolutionMs
      : mockClock.now,
}));

/**
 * The row is replaced by a recorder rather than counted through its real
 * `React.memo`: what the screen controls is the PROPS it hands down, and `now`
 * plus `onPress` are exactly the two the real memo compares. Asserting on them
 * pins the fix without the test depending on the stand-in also being memoised.
 */
const mockLookalikeRowProps: Record<string, unknown>[] = [];
jest.mock("@/components/lookalike/LookalikeRow", () => ({
  LookalikeRow: (props: Record<string, unknown>) => {
    mockLookalikeRowProps.push(props);
    return null;
  },
}));

/** The agency child card, recorded for the same reason as the lookalike row. */
const mockChildCardProps: Record<string, unknown>[] = [];
jest.mock("@/components/agency/ChildCard", () => ({
  ChildCard: (props: Record<string, unknown>) => {
    mockChildCardProps.push(props);
    return null;
  },
}));

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __resetOnlineGateForTests: () => void;
};

beforeEach(() => {
  mockLookalikeRowProps.length = 0;
  mockChildCardProps.length = 0;
  mockClock.now = Date.parse("2026-08-22T10:00:00.000Z");
});

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  duplicateHooks.__resetHookResultsForTests();
  duplicateHooks.__resetOnlineGateForTests();
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

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    hasNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => ({ data: undefined })),
    ...over,
  };
}

/**
 * The host instance behind a rendered element, which React creates on mount and
 * REUSES for every later update of the same component type. Two reads that
 * return the same object prove the subtree was updated in place; two different
 * objects prove it was torn down and rebuilt.
 */
function hostInstances(
  container: { queryAll: (p: (n: { type: string; props: Record<string, unknown> }) => boolean) => unknown[] },
  predicate: (n: { type: string; props: Record<string, unknown> }) => boolean,
): unknown[] {
  return container
    .queryAll(predicate)
    .map((node) => (node as { unstable_fiber?: { stateNode?: unknown } }).unstable_fiber?.stateNode);
}

/**
 * Compared by reference and reported as a BOOLEAN: these are React's internal
 * instances, and handing a mismatched pair to `toEqual`/`toBe` makes the
 * matcher walk the whole fiber graph to build a diff, which overflows the
 * stack rather than failing the test.
 */
function sameHosts(before: unknown[], after: unknown[]): boolean {
  return (
    before.length === after.length &&
    before.every((instance, i) => instance === after[i])
  );
}

/* ------------------------------------------------------------------ *
 * 1. The duplicate queue virtualizes its pairs.
 * ------------------------------------------------------------------ */

const SCAN_ID = "11111111-1111-4111-8111-111111111111";

function manyPairs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    primary_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    primary_email: `mounted-${i}@example.com`,
    duplicate_id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
    duplicate_email: `Mounted-${i}@example.com`,
    primary_updated_at: "2026-07-20T00:00:00Z",
    duplicate_updated_at: "2026-07-21T00:00:00Z",
    kind: "case_diff",
    confidence: 1,
    evidence: [
      {
        kind: "case_diff",
        confidence: 1,
        reason: "The stored email addresses normalize to the same value.",
      },
    ],
    stale: false,
  }));
}

describe("the duplicate queue's render ceiling", () => {
  it("mounts a window of rows, not every pair the pager has fetched", async () => {
    const pairs = manyPairs(200);
    duplicateHooks.__setHookResultForTests(
      "useDuplicateScan",
      queryResult({
        data: normalizeDuplicateScanPage({
          scan: {
            scan_id: SCAN_ID,
            status: "complete",
            subscriber_count: 42_000,
            candidate_count: pairs.length,
            created_at: "2026-07-25T09:00:00Z",
            completed_at: "2026-07-25T09:00:04Z",
            expires_at: "2099-01-01T00:00:00Z",
            complete: true,
          },
          pairs,
          count: pairs.length,
          complete: true,
        }),
      }),
    );
    duplicateHooks.__setHookResultForTests(
      "useDuplicatePairPages",
      queryResult({ data: { pages: [] } }),
    );

    const view = await render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          ConfirmProvider,
          null,
          React.createElement(DuplicatesScreen),
        ),
      ),
      { wrapper },
    );

    const mounted = view.queryAllByText(/^mounted-\d+@example\.com$/u);
    // Vacuity floor: a screen that rendered nothing at all would satisfy an
    // upper bound too, so the lower bound is asserted first.
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(pairs.length);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The DSAR queue owns its scrolling.
 * ------------------------------------------------------------------ */

function dsarRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    request_id: `req-${i}`,
    type: "erasure",
    status: "pending",
    region: "gdpr",
    // Overdue, so the sheet's default "urgent" filter keeps every row.
    due_at: "2026-08-01T00:00:00Z",
    requested_at: "2026-07-01T00:00:00Z",
    subject_email: `subject-${i}@example.com`,
    legal_hold: false,
  }));
}

describe("the DSAR queue's scroll container", () => {
  it("scrolls itself instead of being a non-scrolling list inside a sheet", async () => {
    const rows = dsarRows(120);
    queryHarness.__setQueryResultForTests(
      queryResult({ data: { pages: [{ rows, nextCursor: null }] } }),
    );

    const view = await render(
      <PrivacyRequestQueue visible onClose={() => {}} />,
      { wrapper },
    );

    const scrollers = view.container.queryAll(
      (node) => node.type === "RCTScrollView",
    );
    // Vacuity floor: the sheet has to have rendered a list at all.
    expect(scrollers.length).toBeGreaterThan(0);
    // Exactly one. Two means the FlatList is nested inside a plain ScrollView,
    // which is what hands it an unbounded height and renders every row.
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]!.props.scrollEnabled).not.toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The sequences separator keeps its component type.
 * ------------------------------------------------------------------ */

const SEPARATOR = (node: { type: string; props: Record<string, unknown> }) =>
  node.type === "View" &&
  !Array.isArray(node.props.style) &&
  (node.props.style as { height?: number } | undefined)?.height === 8;

const SHEET = (node: { type: string }) => node.type === "RNCSafeAreaView";

describe("the sequences list separator", () => {
  it("survives a parent re-render instead of being torn down and rebuilt", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({
        data: {
          items: [
            { id: "seq-a", name: "Welcome", status: "draft", steps: 3 },
            { id: "seq-b", name: "Winback", status: "draft", steps: 2 },
          ],
          error: null,
          fromSnapshot: false,
        },
      }),
    );

    const view = await render(<SequencesIndex />, { wrapper });
    const separatorBefore = hostInstances(view.container, SEPARATOR);
    const screenBefore = hostInstances(view.container, SHEET);

    await view.rerender(<SequencesIndex />);

    // Vacuity floor, in two parts: the separator must have been found at all,
    // and an element that CANNOT have remounted must read as unchanged — so a
    // "changed" verdict below means a real remount, not a broken probe.
    expect(separatorBefore).toHaveLength(1);
    expect(sameHosts(screenBefore, hostInstances(view.container, SHEET))).toBe(
      true,
    );
    expect(
      sameHosts(separatorBefore, hostInstances(view.container, SEPARATOR)),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The lookalike list's clock is bucketed to the minute.
 * ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

function lookalikeAudiences() {
  return [
    parseLookalikeAudience({
      id: "look-1",
      name: "High-value buyers lookalike",
      seed_segment_id: "seg-1",
      size_requested: 5000,
      member_count: 5000,
      seed_count: 800,
      confidence_threshold: null,
      model_version: "first-party-v1",
      status: "ready",
      exported_destination_id: null,
      payload: {
        candidate_count: 40_000,
        scored: 5000,
        feature_dims: ["email_domain"],
        bands: { high: 3000, medium: 1500, low: 500 },
        data_use_notice_version: "first-party-lookalike-v1",
      },
      error: "",
      created_at: new Date(mockClock.now - 2 * DAY_MS).toISOString(),
      updated_at: new Date(mockClock.now - 2 * DAY_MS).toISOString(),
    })!,
  ];
}

describe("the lookalike list's clock", () => {
  it("hands the rows an unchanged clock and callback across a second", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ data: lookalikeAudiences() }),
    );

    const view = await render(<Lookalike />, { wrapper });
    const before = mockLookalikeRowProps.at(-1);

    // One tick of the 1 Hz ticker. Nothing a row displays can have changed.
    mockClock.now += 1_000;
    await view.rerender(<Lookalike />);
    const after = mockLookalikeRowProps.at(-1);

    // Vacuity floor: the row has to have rendered, twice.
    expect(mockLookalikeRowProps.length).toBeGreaterThan(1);
    expect(after!.now).toBe(before!.now);
    expect(after!.onPress).toBe(before!.onPress);
  });

  it("still ages the rows once the minute rolls over", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ data: lookalikeAudiences() }),
    );

    const view = await render(<Lookalike />, { wrapper });
    const before = mockLookalikeRowProps.at(-1);

    // Vacuity floor for the test above: a clock frozen at mount would pass it
    // while "built 3 weeks ago" quietly stopped ageing.
    mockClock.now += 61_000;
    await view.rerender(<Lookalike />);

    expect(mockLookalikeRowProps.at(-1)!.now).not.toBe(before!.now);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The list pickers' separator keeps its component type.
 * ------------------------------------------------------------------ */

const CANDIDATES = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

describe("the add-members picker's separator", () => {
  it("survives a keystroke instead of being torn down and rebuilt", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({
        data: {
          items: CANDIDATES.map((id, i) => ({
            id,
            email: `candidate-${i}@example.com`,
            status: "enabled",
            name: "",
          })),
          total: CANDIDATES.length,
          memberIds: new Set<string>(),
        },
      }),
    );

    // A FRESH element tree on each render, not a reused one: React bails out of
    // an identical element, which would make this pass without reconciling
    // anything at all.
    const onClose = () => undefined;
    const onAdded = () => undefined;
    const tree = () => (
      <ListAddMembersSheet
        visible
        listId="7"
        listName="Weekly"
        onClose={onClose}
        onAdded={onAdded}
      />
    );

    const view = await render(tree(), { wrapper });
    const separatorsBefore = hostInstances(view.container, SEPARATOR);
    const sheetBefore = hostInstances(view.container, SHEET);

    await view.rerender(tree());

    // Vacuity floor, in two parts, as above: separators must have been found,
    // and an element that CANNOT have remounted must read as unchanged.
    expect(separatorsBefore.length).toBe(CANDIDATES.length - 1);
    expect(sameHosts(sheetBefore, hostInstances(view.container, SHEET))).toBe(
      true,
    );
    expect(
      sameHosts(separatorsBefore, hostInstances(view.container, SEPARATOR)),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Expanding one agency child card leaves every other card alone.
 * ------------------------------------------------------------------ */

/** One full roster page (MOBILE_AGENCY_CHILDREN_PAGE_SIZE). */
const AGENCY_CHILDREN: MobileAgencyChild[] = Array.from(
  { length: 20 },
  (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    slug: `child-${i}`,
    name: `Child ${i}`,
    tier: "studio" as const,
    parent_tenant_id: "22222222-2222-4222-8222-222222222222",
    billing_mode: "parent" as const,
    reseller_markup_bps: 250,
    whitelabel_enabled: false,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  }),
);

interface ChildCardCall {
  child: MobileAgencyChild;
  expanded: boolean;
  onToggle: (id: string) => void;
}

/** The props each card was handed on its most recent render, by child id. */
function latestChildCardProps(): Map<string, ChildCardCall> {
  const latest = new Map<string, ChildCardCall>();
  for (const props of mockChildCardProps as unknown as ChildCardCall[]) {
    latest.set(props.child.id, props);
  }
  return latest;
}

function renderRoster() {
  return render(
    <ChildrenSection
      rows={AGENCY_CHILDREN}
      notAgency={false}
      accessRestricted={false}
      unavailable={false}
      hasMore={false}
      canLoadMore
      isFetchingNextPage={false}
      isNextPageError={false}
      onLoadMore={() => undefined}
    />,
    { wrapper },
  );
}

describe("the agency child roster", () => {
  it("expands one card without handing any other card a changed prop", async () => {
    await renderRoster();
    const before = latestChildCardProps();
    const target = AGENCY_CHILDREN[10]!;

    // Vacuity floor: every card rendered once, and none started expanded.
    expect(mockChildCardProps).toHaveLength(AGENCY_CHILDREN.length);
    expect([...before.values()].filter((p) => p.expanded)).toHaveLength(0);

    await act(async () => {
      before.get(target.id)!.onToggle(target.id);
    });
    const after = latestChildCardProps();

    // The section did re-render, and the pressed card is the open one.
    expect(mockChildCardProps.length).toBeGreaterThan(AGENCY_CHILDREN.length);
    expect(after.get(target.id)!.expanded).toBe(true);

    // Every OTHER card must be handed exactly the props it already had, or its
    // memo cannot hold and it re-renders for a press it had nothing to do with.
    const changed = AGENCY_CHILDREN.filter((row) => row.id !== target.id)
      .filter((row) => {
        const was = before.get(row.id)!;
        const now = after.get(row.id)!;
        return (
          was.onToggle !== now.onToggle ||
          was.child !== now.child ||
          was.expanded !== now.expanded
        );
      })
      .map((row) => row.slug);
    expect(changed).toEqual([]);
  });

  it("still collapses on a second press and moves on a press elsewhere", async () => {
    // The stable callback must not freeze the state it reads: a
    // `useCallback` closing over `expandedId` would never collapse.
    await renderRoster();
    const target = AGENCY_CHILDREN[10]!;
    const other = AGENCY_CHILDREN[3]!;

    await act(async () => {
      latestChildCardProps().get(target.id)!.onToggle(target.id);
    });
    expect(latestChildCardProps().get(target.id)!.expanded).toBe(true);

    await act(async () => {
      latestChildCardProps().get(target.id)!.onToggle(target.id);
    });
    expect(latestChildCardProps().get(target.id)!.expanded).toBe(false);

    await act(async () => {
      latestChildCardProps().get(target.id)!.onToggle(target.id);
    });
    await act(async () => {
      latestChildCardProps().get(other.id)!.onToggle(other.id);
    });
    const latest = latestChildCardProps();
    expect(latest.get(other.id)!.expanded).toBe(true);
    expect(latest.get(target.id)!.expanded).toBe(false);
  });

  it("memoises the real card, so unchanged props actually skip its render", () => {
    const actual = jest.requireActual("@/components/agency/ChildCard") as {
      ChildCard: { $$typeof?: symbol };
    };
    expect(actual.ChildCard.$$typeof).toBe(Symbol.for("react.memo"));
  });
});
