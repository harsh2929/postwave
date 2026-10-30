import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The Analytics screen had no route-render test at all — it is not in the
 * all-route sweep in `routes.native.test.tsx` — so nothing pinned the two
 * claims this screen now makes about the world:
 *
 *   - ASK is a question box that runs ONE server-selected saved report and
 *     shows its answer, its provenance and its AI disclosure. The disclosure
 *     is a legal obligation (Art. 50) and the provenance line is the only way
 *     a reader can tell whether the question was understood, so both are
 *     asserted, not assumed.
 *   - COHORT RETENTION renders a comparison ONLY when the cohorts can support
 *     one. The server truncates an immature cohort's week array rather than
 *     padding it with zeros, so a naive read produces "July: 0%" — the exact
 *     false headline this screen must never print.
 *
 * Mock shapes match the hooks' real return types exactly: `useCohorts`
 * resolves to `CohortRow[]` (already parsed), and `useAnalyticsAsk` returns
 * the `AnalyticsAskState` object, not a raw mutation.
 */
type Query = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  isSuccess?: boolean;
  error?: unknown;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
};

function query(data: unknown = undefined): Query {
  return {
    data,
    isLoading: false,
    isError: false,
    isFetching: false,
    isSuccess: data !== undefined,
    dataUpdatedAt: data === undefined ? 0 : 1_700_000_000_000,
    refetch: jest.fn(async () => undefined),
  };
}

const mocks = {
  stats: query(),
  growth: query([]),
  leaderboard: query([]),
  fatigue: query([]),
  revenue: query(),
  benchmarks: query(),
  cohorts: query([]),
  // Shapes match the hooks' real return types exactly (house rule 10):
  // `useSubscriberFunnel` resolves to a parsed `SubscriberFunnel`,
  // `useGroupedTimeseries` to `GroupedSeries[]`, `useClvSummary` to a parsed
  // `ClvSummary`. A loose shape here would let every loaded-state assertion
  // below pass on an error path.
  funnel: query({ steps: [], cohortCount: 0 }),
  grouped: query([]),
  clv: query({
    profileCount: null,
    scoredProfiles: null,
    medianTotalCents: null,
    p90TotalCents: null,
    atRiskProfiles: null,
    atRiskAvgCents: null,
    lastCalculatedAt: null,
  }),
  // DASHBOARD#31. Shapes match the hooks exactly: `useDataSufficiency`
  // resolves to `DataSufficiency | null` — and null is the REAL answer for a
  // workspace that has never been recomputed, because the endpoint returns a
  // zeroed report with HTTP 200 and the parser refuses to read that as 0%
  // coverage. `useRfmSegments` resolves to `RfmSegment[]`.
  sufficiency: query(null),
  rfm: query([]),
};

const mockAsk = {
  answer: null as unknown,
  asking: false,
  errorMessage: null as string | null,
  ask: jest.fn(),
  reset: jest.fn(),
};

jest.mock("@/hooks/useAnalytics", () => ({
  rangeLabelFor: (range: string) =>
    `Last ${range === "7d" ? 7 : range === "90d" ? 90 : 30} days`,
  // A CONSTANT, not a hook. The screen passes it straight into the funnel
  // caption, so omitting it prints "the last undefined signup months".
  FUNNEL_MONTHS: 12,
  useSubscriberTimeseries: () => mocks.growth,
  useTemplateLeaderboard: () => mocks.leaderboard,
  useSendFatigue: () => mocks.fatigue,
  useRevenueAttribution: () => mocks.revenue,
  useBenchmarks: () => mocks.benchmarks,
  // Idle by default: the reach section renders nothing without data, so these
  // assertions stay about the screen rather than the new card.
  useHumanEngagedReach: () => ({ data: undefined, isLoading: false }),
  useCohorts: () => mocks.cohorts,
  useSubscriberFunnel: () => mocks.funnel,
  useGroupedTimeseries: () => mocks.grouped,
  useClvSummary: () => mocks.clv,
  useDataSufficiency: () => mocks.sufficiency,
  useRfmSegments: () => mocks.rfm,
}));

jest.mock("@/hooks/useAnalyticsAsk", () => ({
  useAnalyticsAsk: () => mockAsk,
}));

// Only the QUERY is replaced. Stubbing the whole module would drop the
// `pickPrevious*` derivations DeliverabilitySection calls and turn a render
// test into a test of the stub (house rule 10).
jest.mock("@/hooks/useDashboard", () => ({
  ...(jest.requireActual("@/hooks/useDashboard") as object),
  useDashboardStatsQuery: () => mocks.stats,
}));

// eslint-disable-next-line import/first
import Analytics from "../app/(tabs)/analytics";

async function renderScreen() {
  return await render(React.createElement(Analytics), {
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

beforeEach(() => {
  mocks.growth = query([]);
  mocks.leaderboard = query([]);
  mocks.fatigue = query([]);
  mocks.cohorts = query([]);
  mocks.funnel = query({ steps: [], cohortCount: 0 });
  mocks.grouped = query([]);
  mocks.clv = query({
    profileCount: null,
    scoredProfiles: null,
    medianTotalCents: null,
    p90TotalCents: null,
    atRiskProfiles: null,
    atRiskAvgCents: null,
    lastCalculatedAt: null,
  });
  mocks.sufficiency = query(null);
  mocks.rfm = query([]);
  mockAsk.answer = null;
  mockAsk.asking = false;
  mockAsk.errorMessage = null;
});

describe("Analytics screen — payloads whose shape we cannot read", () => {
  it("survives every list section resolving to a truthy non-array", async () => {
    // The screen binds SIX sections with `query.data ?? []` — a NULLISH guard,
    // which passes `{}` and `{items: []}` through untouched. The sections then
    // iterate: `TopPerformersSection` maps its rows BEFORE its QueryStates
    // ladder even runs, so the throw happens on the way in and takes the whole
    // reporting screen with it. Reachable from a restored persisted query cache
    // written by an older response shape — the same route by which api-keys
    // shipped "Invalid attempt to spread non-iterable instance" in this repo.
    mocks.growth = query({ items: [] });
    mocks.leaderboard = query({ items: [] });
    mocks.fatigue = query({ items: [] });
    mocks.cohorts = query({ items: [] });
    mocks.grouped = query({ items: [] });
    mocks.rfm = query({ items: [] });
    const screen = await renderScreen();
    // Not merely "the process survived": each section sits in its own
    // CardBoundary, so an unguarded iterate degrades to a card that says it
    // could not be displayed. That fallback is the tell, and none of the six
    // may show it.
    expect(
      screen.queryAllByLabelText(/could not be displayed/u),
    ).toHaveLength(0);
  });
});

describe("Analytics screen", () => {
  it("mounts the lifecycle rollup beside model coverage", async () => {
    // LifecycleSection owns its query (real hook; the global react-query mock
    // answers isLoading), so the mount is visible as the section's labelled
    // skeleton. An unmounted section is a phantom capability — this is the
    // assertion that the analytics reader can actually reach it.
    const screen = await renderScreen();
    expect(screen.getByText("Lifecycle stages")).toBeTruthy();
  });

  it("offers the question box above the charts", async () => {
    const screen = await renderScreen();
    expect(
      screen.getByLabelText(
        "Ask a question about this workspace's analytics",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Ask")).toBeTruthy();
  });

  it("asks the server when a suggestion is pressed", async () => {
    const screen = await renderScreen();
    fireEvent.press(
      screen.getByLabelText("Ask: Which campaigns got the most opens?"),
    );
    expect(mockAsk.ask).toHaveBeenCalledWith(
      "Which campaigns got the most opens?",
    );
  });

  it("renders an answer with its provenance AND its AI disclosure", async () => {
    mockAsk.answer = {
      question: "which campaigns got the most opens?",
      kind: "table",
      template: "top_campaigns_by_opens",
      windowDays: 30,
      limit: 10,
      columns: ["campaign_name", "unique_opens"],
      rows: [
        {
          id: "March newsletter",
          label: "March newsletter",
          value: 4120,
          cells: [
            { column: "campaign_name", text: "March newsletter", value: null },
            { column: "unique_opens", text: "4120", value: 4120 },
          ],
        },
      ],
      summaryText: "Returned 1 result row(s) for the last 30 days.",
      labelColumn: "campaign_name",
      valueColumn: "unique_opens",
    };
    const screen = await renderScreen();
    await waitFor(() => {
      expect(
        screen.getByText("Returned 1 result row(s) for the last 30 days."),
      ).toBeTruthy();
    });
    // Provenance: WHICH saved report ran, over WHAT window.
    expect(
      screen.getByText(/Ran the saved report .Top campaigns by opens./u),
    ).toBeTruthy();
    expect(screen.getByText(/over the last 30 days/u)).toBeTruthy();
    // Art. 50 disclosure, plus the sentence bounding what the model did.
    expect(
      screen.getByText(/never sent to the model/u),
    ).toBeTruthy();
  });

  it("shows a failure as a failure, never as an empty answer", async () => {
    mockAsk.errorMessage =
      "This workspace has used its daily question budget. It resets at midnight UTC.";
    const screen = await renderScreen();
    expect(
      screen.getByText(/daily question budget/u),
    ).toBeTruthy();
  });

  it("refuses a cohort comparison the data cannot support", async () => {
    // Two cohorts, but the newest has no mature week: comparing at week 4
    // would print "0%" for a cohort that simply has not got there.
    mocks.cohorts = query([
      { label: "2026-07", size: 300, weeks: [] },
      { label: "2026-06", size: 400, weeks: [0.5, 0.4, 0.3, 0.25] },
    ]);
    const screen = await renderScreen();
    expect(screen.getByText(/Not enough history to compare cohorts/u)).toBeTruthy();
  });

  it("states the cohort headline at the deepest COMMON week", async () => {
    mocks.cohorts = query([
      { label: "2026-07", size: 300, weeks: [0.55, 0.4] },
      { label: "2026-06", size: 400, weeks: [0.5, 0.5, 0.3, 0.25] },
    ]);
    const screen = await renderScreen();
    // Week index 1 (both have it), 0.40 vs 0.50 → 10 points less.
    expect(
      screen.getByText(
        "July 2026 signups are engaging 10.0 points less than June 2026's by week 2.",
      ),
    ).toBeTruthy();
    // And it says the screen's window control does not reach this card.
    expect(
      screen.getByText(/the reporting window above does not apply/u),
    ).toBeTruthy();
  });
  /* ------------------------- signup → purchase funnel ------------------------ */

  it("refuses to draw a store-less workspace as a total collapse", async () => {
    // What EVERY workspace without commerce orders receives: a well-formed
    // payload whose last two stages are zero. Drawing it is a picture of a
    // business that lost all of its customers.
    mocks.funnel = query({
      steps: [
        { stage: "signup", label: "Signed Up", count: 4200, conversionPct: 100 },
        { stage: "first_purchase", label: "First Purchase", count: 0, conversionPct: 0 },
        { stage: "repeat_purchase", label: "Repeat Purchase", count: 0, conversionPct: 0 },
      ],
      cohortCount: 12,
    });
    const screen = await renderScreen();
    expect(
      screen.getByText(/No paid orders are matched to these signup cohorts/u),
    ).toBeTruthy();
    expect(screen.queryByText("First Purchase")).toBeNull();
  });

  it("sizes every funnel stage against signups, and says both denominators", async () => {
    mocks.funnel = query({
      steps: [
        { stage: "signup", label: "Signed Up", count: 1000, conversionPct: 100 },
        { stage: "first_purchase", label: "First Purchase", count: 250, conversionPct: 25 },
        { stage: "repeat_purchase", label: "Repeat Purchase", count: 100, conversionPct: 40 },
      ],
      cohortCount: 3,
    });
    const screen = await renderScreen();
    // The last stage is 40% of the stage above it but only 10% of signups.
    // A reader who takes 40% as the funnel's floor overstates it fourfold, so
    // both numbers appear on the same line.
    expect(screen.getByText("10.0% of signups · 40.0% of the stage above")).toBeTruthy();
    // VoiceOver gets the exact figure, not the bar.
    expect(
      screen.getByLabelText(/Repeat Purchase, 100 , 10 percent of signups/u),
    ).toBeTruthy();
    // And the card names its OWN window — the screen's range control does not
    // reach a funnel bucketed by signup month.
    expect(
      screen.getByText(/Across the last 12 signup months · 3 cohorts/u),
    ).toBeTruthy();
  });

  /* ----------------------------- grouped breakdown --------------------------- */

  it("never offers the `list` dimension the handler rejects with a 400", async () => {
    const screen = await renderScreen();
    expect(screen.getByLabelText("Campaign")).toBeTruthy();
    expect(screen.getByLabelText("Domain")).toBeTruthy();
    expect(screen.queryByLabelText("List")).toBeNull();
  });

  it("folds the long tail into one named line rather than drawing ten", async () => {
    const day = (n: number) => `2026-07-0${n}`;
    const s = (key: string, label: string, v: number[]) => ({
      key,
      label,
      points: v.map((value, i) => ({ date: day(i + 1), value })),
      total: v.reduce((a, b) => a + b, 0),
    });
    mocks.grouped = query([
      s("a", "Alpha", [10, 12]),
      s("b", "Bravo", [8, 9]),
      s("c", "Charlie", [5, 5]),
      s("d", "Delta", [2, 2]),
      s("e", "Echo", [1, 1]),
      s("other", "Other", [30, 30]),
    ]);
    const screen = await renderScreen();
    // Two named series spilled; the server's own rollup is in there too, so
    // the label must not claim the count is the whole story.
    expect(screen.getByText("Other (2 more + rest)")).toBeTruthy();
    expect(screen.getByText(/folds 2 more into the trailing line/u)).toBeTruthy();
  });

  /* ------------------------------ customer value ----------------------------- */

  it("distinguishes a never-computed snapshot from a worthless one", async () => {
    mocks.clv = query({
      profileCount: 900,
      scoredProfiles: 100,
      medianTotalCents: 0,
      p90TotalCents: 0,
      atRiskProfiles: 0,
      atRiskAvgCents: 0,
      lastCalculatedAt: null,
    });
    const screen = await renderScreen();
    expect(screen.getByText(/Customer values are all zero/u)).toBeTruthy();
  });

  it("prints customer value without asserting a currency the server never set", async () => {
    mocks.clv = query({
      profileCount: 5000,
      scoredProfiles: 1200,
      medianTotalCents: 4200,
      p90TotalCents: 88000,
      atRiskProfiles: 340,
      atRiskAvgCents: 120000,
      lastCalculatedAt: "2026-07-20T09:00:00Z",
    });
    const screen = await renderScreen();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("Median customer value · top 10% at 880+")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
    // historic_clv_cents is sum(total_cents) with NO grouping by currency, so
    // a "$" here would assert a denomination the server never established.
    expect(
      screen.getByText(/does not record one currency for this figure/u),
    ).toBeTruthy();
    // The scored share is disclosed: a median over a snapshot where four in
    // five rows cannot be scored is a number the reader should discount.
    expect(screen.getByText(/1200 \(24%\) have enough order history/u)).toBeTruthy();
  });
  // DASHBOARD#31 — model coverage. The value card states the model's output;
  // this states how much of it is worth believing.
  it("says no snapshot exists rather than reporting zero coverage", async () => {
    // `GET /api/v1/predictive/data-sufficiency` answers a never-recomputed
    // workspace with a ZEROED report and HTTP 200
    // (apps/api/internal/predictive/repo.go:360). The parser resolves that to
    // null precisely so this sentence, not "0%", reaches the reader.
    mocks.sufficiency = query(null);
    const screen = await renderScreen();
    expect(screen.getByText("No prediction snapshot yet")).toBeTruthy();
    expect(screen.queryByText(/0% of profiles/u)).toBeNull();
  });

  it("discloses coverage on the confidently-scored band alone", async () => {
    mocks.sufficiency = query({
      insufficient: { count: 400, percentage: 40 },
      limited: { count: 200, percentage: 20 },
      sufficient: { count: 400, percentage: 40 },
      total: 1000,
      lastUpdated: "2026-07-24T02:00:00Z",
    });
    const screen = await renderScreen();
    // Folding `limited` in would read 60%, and `limited` is explicitly the
    // band the model scores WITHOUT enough history.
    expect(
      screen.getByText("Only 40% of profiles are confidently scored"),
    ).toBeTruthy();
    expect(screen.getByText(/400 of 1000 profiles/u)).toBeTruthy();
  });

  it("names an RFM band this build has never seen and speaks its exact count", async () => {
    mocks.sufficiency = query({
      insufficient: { count: 0, percentage: 0 },
      limited: { count: 0, percentage: 0 },
      sufficient: { count: 100, percentage: 100 },
      total: 100,
      lastUpdated: null,
    });
    mocks.rfm = query([
      { key: "champions", label: "Champions", profiles: 60, avgMonetaryCents: 48000, share: 0.6 },
      { key: "a_new_band", label: "a new band", profiles: 40, avgMonetaryCents: 0, share: 0.4 },
    ]);
    const screen = await renderScreen();
    expect(screen.getByText("Champions")).toBeTruthy();
    // A key the client does not recognise is rendered, never dropped.
    expect(screen.getByText("a new band")).toBeTruthy();
    // The compacted bar always travels with an exact spoken value.
    expect(
      screen.getByLabelText("Champions: 60 profiles, 60% of scored profiles"),
    ).toBeTruthy();
  });
  // DASHBOARD#40 — dataset export. Mobile could share a SENTENCE about a
  // metric and nothing else; this shares the rows behind them.
  it("offers no export while every section is empty", async () => {
    const screen = await renderScreen();
    expect(screen.queryByText("Export")).toBeNull();
  });

  it("exports the rows on screen and warns which sections are missing", async () => {
    mocks.growth = query([
      { date: "2026-07-01", count: 100 },
      { date: "2026-07-02", count: 140 },
    ]);
    // A failed section must be NAMED in the file, not silently omitted —
    // missing rows read as measured zeroes.
    mocks.revenue = { ...query(null), isError: true, error: new Error("403") };
    const screen = await renderScreen();
    expect(
      screen.getByLabelText("Export 2 analytics rows for Last 30 days as CSV"),
    ).toBeTruthy();
  });

  /**
   * BarChart shipped a complete tappable-row branch — Pressable, haptics,
   * accessibilityRole="button", a 44pt target — that no chart on the phone
   * ever passed a handler for, so it had never rendered in the shipped app.
   *
   * Only the revenue chart gets one, and the test is what stops that becoming
   * "every chart, because the branch exists": a bar is worth tapping when its
   * id addresses a screen. `campaign_id` does (attribution.go AttributionItem
   * → /(tabs)/campaigns/[id]); an ISP name and a tool name do not, and mobile
   * has no template detail route at all.
   */
  it("drills from a revenue bar into the campaign that earned it", async () => {
    mocks.revenue = query({
      items: [
        {
          id: "cmp_top",
          name: "August newsletter",
          conversions: 12,
          revenueCents: 250_000,
          emailsSent: 4_000,
          revenuePerSendCents: 62.5,
        },
      ],
      provenance: {
        explicit: 12,
        lastTouch: 0,
        none: 0,
        unclassified: 0,
        total: 12,
      },
      totalRevenueCents: 250_000,
      unattributedCents: 0,
      unattributedConversions: 0,
      currency: "USD",
      currencies: [],
      totalCampaigns: 1,
      days: 30,
    });
    const screen = await renderScreen();
    const bar = screen.getByLabelText(/^August newsletter: /u);
    // The branch that had never rendered: a bar is a button, not a label.
    expect(bar.props.accessibilityRole).toBe("button");
    fireEvent.press(bar);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "cmp_top" },
    });
  });

  it("never offers to export a screen that cannot read its own numbers", async () => {
    mocks.growth = query([{ date: "2026-07-01", count: 100 }]);
    // A restricted session paints a scope notice, not a wall of em-dashes —
    // and must not offer to export what it could not read.
    mocks.stats = {
      ...query(undefined),
      isError: true,
      error: Object.assign(new Error("insufficient scope"), { status: 403 }),
    };
    const screen = await renderScreen();
    expect(screen.queryByText("Export")).toBeNull();
  });
});
