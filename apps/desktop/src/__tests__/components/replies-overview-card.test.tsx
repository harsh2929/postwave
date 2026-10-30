// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  RepliesSummary,
  ReplyTimeseriesResponse,
  ReplyTopSendersResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  topSenders: vi.fn(),
  timeseries: vi.fn(),
  byCampaign: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  replyAnalyticsApi: {
    summary: mocks.summary,
    topSenders: mocks.topSenders,
    timeseries: mocks.timeseries,
    byCampaign: mocks.byCampaign,
  },
}));

vi.mock("../../components/charts/LineChart", () => ({
  LineChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="reply-chart">{data.length} points</div>
  ),
}));

import { RepliesOverviewCard } from "../../components/replies/RepliesOverviewCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function summary(
  windowDays = 30,
  overrides: Partial<RepliesSummary> = {},
): RepliesSummary {
  return {
    window_days: windowDays,
    total: 8,
    matched: 6,
    unmatched: 2,
    top_campaigns: [{ campaign_id: "campaign-1", replies: 6 }],
    ...overrides,
  };
}

function topSenders(
  windowDays = 30,
  email = "reader@example.com",
): ReplyTopSendersResponse {
  return {
    window_days: windowDays,
    senders: [
      {
        recipient_email: email,
        replies: 3,
        last_at: "2026-07-15T08:00:00.000Z",
      },
    ],
  };
}

function timeseries(windowDays = 30): ReplyTimeseriesResponse {
  return {
    window_days: windowDays,
    points: [
      { date: "2026-07-14", replies: 2 },
      { date: "2026-07-15", replies: 6 },
    ],
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function component(): ReactElement {
  return (
    <RepliesOverviewCard
      campaigns={[{ id: "campaign-1", name: "Launch campaign" }]}
    />
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function changeWindow(value: number): void {
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Replies window"]',
  );
  if (!select) throw new Error("Missing replies-window select");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, String(value));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("RepliesOverviewCard", () => {
  it("loads lazily and renders the campaign drilldown", async () => {
    mocks.summary.mockResolvedValueOnce({ data: summary() });
    mocks.topSenders.mockResolvedValueOnce({ data: topSenders() });
    mocks.timeseries.mockResolvedValueOnce({ data: timeseries() });
    mocks.byCampaign.mockResolvedValueOnce({
      data: {
        campaign_id: "campaign-1",
        replies: 6,
        distinct_replyers: 4,
        unique_recipients: 40,
        reply_rate: 0.1,
        recent: [],
      },
    });
    render(component());
    expect(mocks.summary).not.toHaveBeenCalled();

    act(() => button("Reply analytics").click());
    await waitFor(() => {
      expect(mocks.summary).toHaveBeenCalledWith(30);
      expect(mocks.topSenders).toHaveBeenCalledWith(30);
      expect(mocks.timeseries).toHaveBeenCalledWith(30);
      expect(document.body.textContent).toContain("Launch campaign");
      expect(document.body.textContent).toContain("reader@example.com");
      expect(document.body.textContent).toContain("2 points");
    });

    act(() => button("Details").click());
    await waitFor(() => {
      expect(mocks.byCampaign).toHaveBeenCalledWith("campaign-1");
      expect(document.body.textContent).toContain("10.0%");
      expect(document.body.textContent).toContain(
        "Reply rate (distinct replyers ÷ unique recipients)",
      );
      expect(document.body.textContent).toContain(
        "No recent reply previews for Launch campaign",
      );
    });
    expect(document.body.textContent).toContain("Campaign ID: campaign-1");
    expect(container?.querySelector("[title]")).toBeNull();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("renders summary failure as an error rather than an empty state", async () => {
    mocks.summary.mockResolvedValueOnce({
      error: { message: "Summary failed" },
    });
    mocks.topSenders.mockResolvedValueOnce({
      error: { message: "Senders failed" },
    });
    mocks.timeseries.mockResolvedValueOnce({
      error: { message: "Series failed" },
    });
    render(component());
    act(() => button("Reply analytics").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Couldn't load reply analytics: The server could not verify this data.",
      );
    });
    expect(document.body.textContent).not.toContain("No replies tracked yet");
  });

  it("ignores an older window response that finishes last", async () => {
    const oldSummary = deferred<{ data: RepliesSummary }>();
    const oldSenders = deferred<{ data: ReplyTopSendersResponse }>();
    const oldSeries = deferred<{ data: ReplyTimeseriesResponse }>();
    mocks.summary
      .mockReturnValueOnce(oldSummary.promise)
      .mockResolvedValueOnce({ data: summary(7, { total: 2 }) });
    mocks.topSenders
      .mockReturnValueOnce(oldSenders.promise)
      .mockResolvedValueOnce({ data: topSenders(7, "new-window@example.com") });
    mocks.timeseries
      .mockReturnValueOnce(oldSeries.promise)
      .mockResolvedValueOnce({ data: timeseries(7) });
    render(component());
    act(() => button("Reply analytics").click());
    changeWindow(7);

    await waitFor(() => {
      expect(document.body.textContent).toContain("new-window@example.com");
      expect(document.body.textContent).toContain("2 replies / 7d");
    });
    oldSummary.resolve({ data: summary(30, { total: 99 }) });
    oldSenders.resolve({ data: topSenders(30, "stale@example.com") });
    oldSeries.resolve({ data: timeseries(30) });
    await act(async () => Promise.resolve());

    expect(document.body.textContent).toContain("new-window@example.com");
    expect(document.body.textContent).not.toContain("stale@example.com");
    expect(document.body.textContent).not.toContain("99 replies");
  });

  it("contains synchronous summary failures and single-flights the visible retry", async () => {
    mocks.summary
      .mockImplementationOnce(() => {
        throw new Error("private reply database detail");
      })
      .mockResolvedValueOnce({ data: summary() });
    mocks.topSenders.mockResolvedValue({ data: topSenders() });
    mocks.timeseries.mockResolvedValue({ data: timeseries() });
    render(component());
    act(() => button("Reply analytics").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service could not be reached. Check the connection and retry.",
      );
    });
    expect(document.body.textContent).not.toContain(
      "private reply database detail",
    );
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Launch campaign");
    });
    expect(mocks.summary).toHaveBeenCalledTimes(2);
  });

  it("single-flights drilldown and ignores an older same-campaign response", async () => {
    mocks.summary.mockResolvedValue({ data: summary() });
    mocks.topSenders.mockResolvedValue({ data: topSenders() });
    mocks.timeseries.mockResolvedValue({ data: timeseries() });
    const older = deferred<{
      data: {
        campaign_id: string;
        replies: number;
        distinct_replyers: number;
        unique_recipients: number;
        reply_rate: number;
        recent: Array<{
          recipient_email: string;
          subject: string;
          received_at: string;
        }>;
      };
    }>();
    const newer = deferred<{
      data: {
        campaign_id: string;
        replies: number;
        distinct_replyers: number;
        unique_recipients: number;
        reply_rate: number;
        recent: Array<{
          recipient_email: string;
          subject: string;
          received_at: string;
        }>;
      };
    }>();
    mocks.byCampaign
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(component());
    act(() => button("Reply analytics").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Launch campaign");
    });

    const details = button("Details");
    await act(async () => {
      details.click();
      details.click();
      await Promise.resolve();
    });
    expect(mocks.byCampaign).toHaveBeenCalledTimes(1);
    act(() => button("Hide").click());
    await act(async () => {
      button("Details").click();
      await Promise.resolve();
    });
    expect(mocks.byCampaign).toHaveBeenCalledTimes(2);

    newer.resolve({
      data: {
        campaign_id: "campaign-1",
        replies: 2,
        distinct_replyers: 2,
        unique_recipients: 10,
        reply_rate: 0.2,
        recent: [
          {
            recipient_email: "fresh-reader@example.com",
            subject: "Fresh reply",
            received_at: "2026-07-16T08:00:00.000Z",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("fresh-reader@example.com");
    });
    older.resolve({
      data: {
        campaign_id: "campaign-1",
        replies: 99,
        distinct_replyers: 99,
        unique_recipients: 100,
        reply_rate: 0.99,
        recent: [
          {
            recipient_email: "stale-reader@example.com",
            subject: "Stale reply",
            received_at: "2026-07-15T08:00:00.000Z",
          },
        ],
      },
    });
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain("fresh-reader@example.com");
    expect(document.body.textContent).not.toContain("stale-reader@example.com");
    expect(document.body.textContent).not.toContain("99.0%");
  });
});
