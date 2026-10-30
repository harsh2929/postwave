/**
 * RepliesSection — the render contract.
 *
 * The parsing and copy rules are pinned in src/lib/replyAnalytics.test.ts and
 * the transport in src/api/replyAnalytics.test.ts; this file pins what the
 * analytics reader meets:
 *
 *  - the summary owns the ladder: skeleton, failure-with-retry, offline,
 *    absent-subsystem and data are five different sentences;
 *  - the trend and the responders load and fail on their OWN lines, and
 *    neither prints a "nothing here" sentence while still in flight;
 *  - a flat-at-zero week draws inside its CardBoundary without tripping it;
 *  - an empty window is one headline, not a chart of zeros plus an empty list;
 *  - the Analytics screen actually MOUNTS the section (an unmounted section is
 *    a phantom capability).
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CardBoundary } from "@/components/dashboard/CardBoundary";
import {
  REPLIES_ABSENT_COPY,
  REPLIES_EMPTY_HEADLINE,
  REPLIES_OFFLINE_COPY,
  TOP_SENDERS_CAPTION,
  TOP_SENDERS_TITLE,
  TREND_NO_POINTS,
  TREND_ONE_POINT,
  TREND_TITLE,
} from "@/lib/replyAnalytics";

type Query = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch: () => Promise<unknown>;
};

function loaded(data: unknown): Query {
  return { data, isLoading: false, isError: false, refetch: jest.fn(async () => undefined) };
}
function loading(): Query {
  return { data: undefined, isLoading: true, isError: false, refetch: jest.fn(async () => undefined) };
}
function idle(): Query {
  return { data: undefined, isLoading: false, isError: false, refetch: jest.fn(async () => undefined) };
}
function failed(status = 500): Query {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    error: Object.assign(new Error("upstream fell over"), { status }),
    refetch: jest.fn(async () => undefined),
  };
}

const SUMMARY = {
  windowDays: 30,
  total: 212,
  humanReplies: 180,
  excludedNonHuman: 20,
  unclassified: 12,
  matched: 207,
  unmatched: 5,
};
const HEADLINE = "212 replies · 180 written by people";
const day = (n: number, replies: number | null) => ({
  date: `2026-09-${String(n).padStart(2, "0")}`,
  replies,
});
const POINTS = [day(1, 3), day(2, 0), day(3, 9)];
const SENDERS = [
  { email: "ana@example.com", replies: 8, lastAt: "2026-08-30T10:00:00Z" },
  { email: "bo@example.com", replies: 2, lastAt: null },
];

// Shapes match the hooks' real return types: `useReplySummary` resolves to
// `ReplySummary | null`, the other two to parsed arrays.
const mockReply = {
  summary: loaded(SUMMARY),
  timeseries: loaded(POINTS),
  senders: loaded(SENDERS),
};

jest.mock("@/hooks/useReplyAnalytics", () => ({
  useReplySummary: () => mockReply.summary,
  useReplyTimeseries: () => mockReply.timeseries,
  useReplyTopSenders: () => mockReply.senders,
}));

/* ------------- the screen's other hooks, for the mount test only ------------ */

function mockScreenQuery(data: unknown = undefined) {
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
const mockScreen = {
  funnel: mockScreenQuery({ steps: [], cohortCount: 0 }),
  clv: mockScreenQuery({
    profileCount: null,
    scoredProfiles: null,
    medianTotalCents: null,
    p90TotalCents: null,
    atRiskProfiles: null,
    atRiskAvgCents: null,
    lastCalculatedAt: null,
  }),
};
jest.mock("@/hooks/useAnalytics", () => ({
  rangeLabelFor: (range: string) =>
    `Last ${range === "7d" ? 7 : range === "90d" ? 90 : 30} days`,
  FUNNEL_MONTHS: 12,
  useSubscriberTimeseries: () => mockScreenQuery([]),
  useTemplateLeaderboard: () => mockScreenQuery([]),
  useSendFatigue: () => mockScreenQuery([]),
  useRevenueAttribution: () => mockScreenQuery(),
  useBenchmarks: () => mockScreenQuery(),
  useHumanEngagedReach: () => ({ data: undefined, isLoading: false }),
  useCohorts: () => mockScreenQuery([]),
  useSubscriberFunnel: () => mockScreen.funnel,
  useGroupedTimeseries: () => mockScreenQuery([]),
  useClvSummary: () => mockScreen.clv,
  useDataSufficiency: () => mockScreenQuery(null),
  useRfmSegments: () => mockScreenQuery([]),
}));
jest.mock("@/hooks/useAnalyticsAsk", () => ({
  useAnalyticsAsk: () => ({
    answer: null,
    asking: false,
    errorMessage: null,
    ask: jest.fn(),
    reset: jest.fn(),
  }),
}));
jest.mock("@/hooks/useDashboard", () => ({
  ...(jest.requireActual("@/hooks/useDashboard") as object),
  useDashboardStatsQuery: () => mockScreenQuery(),
}));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import { RepliesSection } from "@/components/analytics/RepliesSection";
// eslint-disable-next-line import/first
import Analytics from "../app/(tabs)/analytics";

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

function renderSection(gateEnabled = true) {
  return render(
    <RepliesSection
      range="30d"
      rangeLabel="Last 30 days"
      gate={{ enabled: gateEnabled }}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  mockReply.summary = loaded(SUMMARY);
  mockReply.timeseries = loaded(POINTS);
  mockReply.senders = loaded(SENDERS);
});

describe("RepliesSection — the summary's ladder", () => {
  it("shows a labelled skeleton under the title while the summary loads", async () => {
    mockReply.summary = loading();
    await renderSection();
    expect(screen.getByText("Replies")).toBeTruthy();
    expect(screen.getByLabelText("Loading replies")).toBeTruthy();
    expect(screen.queryByText(REPLIES_EMPTY_HEADLINE)).toBeNull();
  });

  it("renders a failed load as a failure whose retry refetches the summary", async () => {
    mockReply.summary = failed(500);
    await renderSection();
    expect(screen.queryByText(REPLIES_EMPTY_HEADLINE)).toBeNull();
    expect(screen.queryByText(REPLIES_ABSENT_COPY)).toBeNull();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(mockReply.summary.refetch).toHaveBeenCalledTimes(1);
  });

  it("names the offline case rather than an empty one", async () => {
    mockReply.summary = idle();
    await renderSection(false);
    expect(screen.getByText(REPLIES_OFFLINE_COPY)).toBeTruthy();
  });

  it("renders nothing when the query never ran online — the screen owns that", async () => {
    mockReply.summary = idle();
    await renderSection(true);
    expect(screen.queryByText("Replies")).toBeNull();
  });

  it("says the capability is absent for a deployment without the reply subsystem", async () => {
    mockReply.summary = loaded(null);
    await renderSection();
    expect(screen.getByText(REPLIES_ABSENT_COPY)).toBeTruthy();
    expect(screen.queryByText(TREND_TITLE)).toBeNull();
  });
});

describe("RepliesSection — loaded", () => {
  it("renders the headline, its provenance, the trend, the responders and the window caveat", async () => {
    await renderSection();
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(
      screen.getByText(
        "20 auto-responders and bounce chatter excluded · 12 not yet classified · 5 not matched to a campaign.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(TREND_TITLE)).toBeTruthy();
    expect(screen.getByText(TOP_SENDERS_TITLE)).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.getByText("8 replies")).toBeTruthy();
    expect(screen.getByText("bo@example.com")).toBeTruthy();
    expect(screen.getByText("2 replies")).toBeTruthy();
    // VoiceOver gets address, count and recency in one frame.
    expect(
      screen.getByLabelText(/^ana@example\.com, 8 replies, last on /u),
    ).toBeTruthy();
    expect(screen.getByLabelText("bo@example.com, 2 replies")).toBeTruthy();
    expect(screen.getByText(TOP_SENDERS_CAPTION)).toBeTruthy();
    expect(screen.getByText(/^Last 30 days\. Counts every inbound reply/u)).toBeTruthy();
  });

  it("an empty window is one headline — no chart of zeros, no empty ranking", async () => {
    mockReply.summary = loaded({ ...SUMMARY, total: 0, humanReplies: 0 });
    mockReply.timeseries = loaded([day(1, 0), day(2, 0)]);
    mockReply.senders = loaded([]);
    await renderSection();
    expect(screen.getByText(REPLIES_EMPTY_HEADLINE)).toBeTruthy();
    expect(screen.queryByText(TREND_TITLE)).toBeNull();
    expect(screen.queryByText(TOP_SENDERS_TITLE)).toBeNull();
  });

  it("refuses to draw a one-day trend and says why", async () => {
    mockReply.timeseries = loaded([day(1, 5)]);
    await renderSection();
    expect(screen.getByText(TREND_ONE_POINT)).toBeTruthy();
    expect(screen.queryByText(TREND_TITLE)).toBeNull();
  });

  it("draws a flat-at-zero week inside its boundary without tripping it", async () => {
    mockReply.summary = loaded({ ...SUMMARY, total: 1, humanReplies: 1 });
    mockReply.timeseries = loaded([1, 2, 3, 4, 5, 6, 7].map((n) => day(n, 0)));
    await render(
      <CardBoundary
        label="Replies"
        colors={{ surface: "#fff", border: "#ccc", text: "#000" }}
      >
        <RepliesSection range="7d" rangeLabel="Last 7 days" gate={{ enabled: true }} />
      </CardBoundary>,
      { wrapper },
    );
    expect(screen.queryAllByLabelText(/could not be displayed/u)).toHaveLength(0);
    expect(screen.getByText(TREND_TITLE)).toBeTruthy();
  });

  it("survives a non-array trend or responder payload from an older cache", async () => {
    mockReply.timeseries = loaded({ points: [] });
    mockReply.senders = loaded({ senders: [] });
    await render(
      <CardBoundary
        label="Replies"
        colors={{ surface: "#fff", border: "#ccc", text: "#000" }}
      >
        <RepliesSection range="30d" rangeLabel="Last 30 days" gate={{ enabled: true }} />
      </CardBoundary>,
      { wrapper },
    );
    expect(screen.queryAllByLabelText(/could not be displayed/u)).toHaveLength(0);
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(screen.getByText(TREND_NO_POINTS)).toBeTruthy();
  });
});

describe("RepliesSection — the secondary reads stand on their own", () => {
  it("a failed trend keeps the headline and offers its own retry", async () => {
    mockReply.timeseries = failed(500);
    await renderSection();
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(mockReply.timeseries.refetch).toHaveBeenCalledTimes(1);
    expect(mockReply.summary.refetch).not.toHaveBeenCalled();
  });

  it("never prints a no-trend sentence while the trend is still loading", async () => {
    mockReply.timeseries = loading();
    mockReply.senders = loading();
    await renderSection();
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(screen.getByLabelText("Loading reply trend")).toBeTruthy();
    expect(screen.getByLabelText("Loading top responders")).toBeTruthy();
    expect(screen.queryByText(TREND_NO_POINTS)).toBeNull();
    expect(screen.queryByText(TOP_SENDERS_TITLE)).toBeNull();
  });

  it("omits the ranking entirely when nobody replied, rather than an empty header", async () => {
    mockReply.senders = loaded([]);
    await renderSection();
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(screen.queryByText(TOP_SENDERS_TITLE)).toBeNull();
    expect(screen.queryByText(TOP_SENDERS_CAPTION)).toBeNull();
  });
});

describe("Analytics screen", () => {
  it("mounts the replies section inside its own boundary", async () => {
    await render(React.createElement(Analytics), { wrapper });
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.queryAllByLabelText(/could not be displayed/u)).toHaveLength(0);
  });
});
