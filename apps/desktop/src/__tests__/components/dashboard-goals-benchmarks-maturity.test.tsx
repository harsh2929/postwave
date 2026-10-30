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

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  progress: vi.fn(),
  remove: vi.fn(),
  benchmarks: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getDashboardBenchmarks: mocks.benchmarks,
    },
    goalsApi: {
      ...actual.goalsApi,
      progress: mocks.progress,
      remove: mocks.remove,
    },
  };
});

vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return {
    ...actual,
    useCanAdmin: () => mocks.canAdmin,
  };
});

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { BenchmarksCard } from "../../components/dashboard/BenchmarksCard";
import { GoalsCard } from "../../components/dashboard/GoalsCard";
import type {
  DashboardStatsResponse,
  TenantGoal,
  TenantGoalProgress,
} from "../../lib/api-client";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const goal: TenantGoal = {
  id: "goal-1",
  name: "A very long subscriber acquisition goal that still needs to reflow",
  metric: "subscribers",
  target: 1_000,
  period: "monthly",
  starts_at: "2026-07-01T00:00:00.000Z",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

const progress: TenantGoalProgress = {
  goal,
  current: 425,
  target: 1_000,
  pct: 0.425,
  pace: "on_track",
  period_start: "2026-07-01T00:00:00.000Z",
  period_end: "2026-07-31T23:59:59.000Z",
  as_of: "2026-07-18T08:15:00.000Z",
};

const stats: DashboardStatsResponse = {
  // Gross totals are intentionally contradictory and must never drive rates.
  emails_sent_30d: 1,
  opens_total_30d: 9_999,
  clicks_total_30d: 8_888,
  bounces_total_30d: 7_777,
  unique_opens_30d: 320,
  unique_clicks_30d: 40,
  unique_bounces_30d: 20,
  unique_delivered_30d: 800,
  unique_sent_30d: 1_000,
};

const benchmarkResponse = {
  data: {
    rows: [
      { metric: "opens", average: 0.2, source: "Industry cohort report" },
      { metric: "clicks", average: 0.08, source: "Industry cohort report" },
      { metric: "bounces", average: 0.05, source: "Deliverability panel" },
      { metric: "unsubs", average: 0.002, source: "Industry cohort report" },
    ],
    note: "Illustrative averages from comparable senders.",
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.progress.mockResolvedValue({
    data: { progress: [progress], as_of: progress.as_of },
  });
  mocks.remove.mockResolvedValue({ data: undefined });
  mocks.benchmarks.mockResolvedValue(benchmarkResponse);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function benchmarkDataRows(): string[][] {
  const table = Array.from(document.querySelectorAll("table")).find(
    (candidate) =>
      candidate.querySelector("caption")?.textContent?.trim() ===
      "Workspace rates compared with industry benchmarks data",
  );
  if (!table) throw new Error("Expected semantic benchmark data table");
  return Array.from(table.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("th, td")).map(
      (cell) => cell.textContent?.trim() ?? "",
    ),
  );
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

describe("dashboard goals and benchmarks maturity", () => {
  it("renders exact, semantic, provenance-rich comparisons without native tooltips", async () => {
    render(
      <>
        <GoalsCard />
        <BenchmarksCard stats={stats} range="30d" />
      </>,
    );
    await flush();

    expect(document.querySelectorAll("section[aria-labelledby]")).toHaveLength(
      2,
    );
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("43");
    expect(document.body.textContent).toContain("Moosewave goals progress API");
    expect(document.body.textContent).toContain("Data as of");
    expect(document.body.textContent).toContain("Uniform scale 0–50.00%");
    expect(document.body.textContent).toContain("Industry cohort report");
    expect(document.body.textContent).toContain("Ahead");
    expect(document.body.textContent).toContain("Opportunity");
    expect(document.body.textContent).toContain("Awaiting your data");
    expect(document.body.textContent).toContain(
      "Benchmark snapshot time was not supplied",
    );
    expect(document.body.textContent).toContain("800 unique delivered");
    expect(document.body.textContent).toContain("1,000 unique sent");
    expect(document.body.textContent).not.toContain("9,999");
    expect(
      document.querySelectorAll(
        '.dashboard-benchmark-track[aria-hidden="true"]',
      ),
    ).toHaveLength(4);
    expect(document.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(benchmarkDataRows()).toEqual([
      [
        "Open rate",
        "40.00%",
        "20.00%",
        "Ahead: 20.00 pp better",
        "Higher is better",
        "Industry cohort report",
      ],
      [
        "Click rate",
        "5.00%",
        "8.00%",
        "Opportunity: 3.00 pp from benchmark",
        "Higher is better",
        "Industry cohort report",
      ],
      [
        "Bounce rate",
        "2.00%",
        "5.00%",
        "Ahead: 3.00 pp better",
        "Lower is better",
        "Deliverability panel",
      ],
      [
        "Unsubscribe rate",
        "—",
        "0.20%",
        "Awaiting your data: Workspace rate unavailable",
        "Lower is better",
        "Industry cohort report",
      ],
    ]);
    expect(document.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  });

  it("attributes workspace rates to the selected reporting window", async () => {
    render(<BenchmarksCard stats={stats} range="7d" />);
    await flush();

    expect(document.body.textContent).toContain("selected 7-day window");
    expect(document.body.textContent).not.toContain("trailing 30 days");

    act(() => root?.render(<BenchmarksCard stats={stats} range="90d" />));
    expect(document.body.textContent).toContain("selected 90-day window");
    expect(document.body.textContent).not.toContain("selected 7-day window");
  });

  it("makes goal administration and empty-state ownership explicit for viewers", async () => {
    mocks.canAdmin = false;
    mocks.progress.mockResolvedValue({
      data: { progress: [], as_of: "2026-07-18T08:15:00.000Z" },
    });
    render(<GoalsCard />);
    await flush();

    expect(document.body.textContent).toContain("Read only");
    expect(document.body.textContent).toContain(
      "Workspace admins manage goals",
    );
    expect(document.body.textContent).toContain(
      "A workspace admin can create goals",
    );
    expect(document.body.textContent).not.toContain("New goal");
    expect(document.body.textContent).not.toContain("Set your first goal");
  });

  it("keeps destructive goal deletion single-flight and refreshes acknowledged data", async () => {
    const pending = deferred<{ data: undefined }>();
    mocks.progress
      .mockResolvedValueOnce({
        data: { progress: [progress], as_of: progress.as_of },
      })
      .mockResolvedValueOnce({
        data: { progress: [], as_of: "2026-07-18T08:16:00.000Z" },
      });
    mocks.remove.mockReturnValueOnce(pending.promise);
    render(<GoalsCard />);
    await flush();

    act(() => button(`Delete goal ${goal.name}`).click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "pacing history will be removed",
    );
    act(() => {
      button("Delete goal").click();
      button("Delete goal").click();
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(goal.id);

    await act(async () => {
      pending.resolve({ data: undefined });
      await pending.promise;
    });
    await flush();

    expect(mocks.progress).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("No goals yet");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Goal deleted.");
  });

  it("retains the goal and confirmation context when deletion is rejected", async () => {
    const sensitiveFailure = "postgres://admin:secret@internal-db";
    mocks.remove.mockResolvedValueOnce({
      error: { code: "SECRET_INTERNAL_CODE", message: sensitiveFailure },
    });
    render(<GoalsCard />);
    await flush();

    act(() => button(`Delete goal ${goal.name}`).click());
    act(() => button("Delete goal").click());
    await flush();

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(goal.name);
    expect(mocks.progress).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Goal couldn't be deleted. Check your access and connection, then try again.",
    );
    expect(document.body.textContent).not.toContain(sensitiveFailure);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      sensitiveFailure,
    );
  });

  it("keeps acknowledged goals visible while a safe refresh fails", async () => {
    const sensitiveFailure = "redis://token@private-cache/refresh";
    const refresh = deferred<{ error: { message: string } }>();
    mocks.progress
      .mockResolvedValueOnce({
        data: { progress: [progress], as_of: progress.as_of },
      })
      .mockReturnValueOnce(refresh.promise);
    render(<GoalsCard />);
    await flush();

    act(() => button(`Delete goal ${goal.name}`).click());
    act(() => button("Delete goal").click());
    await flush();

    expect(mocks.progress).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Refreshing latest progress");
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Loading goal progress"]'),
    ).toBeNull();

    await act(async () => {
      refresh.resolve({ error: { message: sensitiveFailure } });
      await refresh.promise;
    });
    await flush();

    expect(document.body.textContent).toContain(
      "Latest progress couldn't be refreshed",
    );
    expect(document.body.textContent).toContain(
      "Showing the last confirmed goal data",
    );
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(sensitiveFailure);
  });

  it("contains goal loading failures and retries from the card", async () => {
    const sensitiveFailure = "api-key=pw_live_do_not_disclose";
    mocks.progress
      .mockResolvedValueOnce({ error: { message: sensitiveFailure } })
      .mockResolvedValueOnce({
        data: { progress: [progress], as_of: progress.as_of },
      });
    render(<GoalsCard />);
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load goals. Check your connection and try again.",
    );
    expect(document.body.textContent).not.toContain(sensitiveFailure);
    act(() => button("Retry").click());
    await flush();

    expect(mocks.progress).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it("contains benchmark failures and retries into the complete comparison", async () => {
    const sensitiveFailure = "https://internal.example/?token=secret";
    mocks.benchmarks
      .mockResolvedValueOnce({ error: { message: sensitiveFailure } })
      .mockResolvedValueOnce(benchmarkResponse);
    render(<BenchmarksCard stats={stats} range="30d" />);
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load industry benchmarks. Check your connection and try again.",
    );
    expect(document.body.textContent).not.toContain(sensitiveFailure);
    act(() => button("Retry").click());
    await flush();

    expect(mocks.benchmarks).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Methodology");
    expect(
      document.querySelectorAll(
        '.dashboard-benchmark-track[aria-hidden="true"]',
      ),
    ).toHaveLength(4);
    expect(benchmarkDataRows()).toHaveLength(4);
  });

  it("rejects malformed benchmark rates instead of inventing percentages", async () => {
    mocks.benchmarks.mockResolvedValueOnce({
      data: {
        rows: [
          null,
          { metric: "opens", average: Number.POSITIVE_INFINITY, source: "A" },
          { metric: "opens", average: 0.3, source: "Duplicate" },
          { metric: "clicks", average: -0.1, source: { invalid: true } },
          { metric: "bounces", average: 42, source: "C" },
        ],
        note: "Malformed fixture",
      },
    });
    render(<BenchmarksCard stats={stats} range="30d" />);
    await flush();

    expect(
      Array.from(
        document.querySelectorAll(".dashboard-benchmark-comparison"),
      ).map((node) => node.textContent?.trim()),
    ).toEqual(["No reference", "No reference", "No reference"]);
    expect(document.body.textContent).not.toContain("4,200");
    expect(document.body.textContent).not.toContain("4200");
    expect(document.body.textContent).not.toContain("Infinity");
    expect(document.body.textContent).not.toContain("Duplicate");
    expect(document.body.textContent).toContain("Source not supplied");
    expect(document.body.textContent).toContain("Uniform scale 0–50.00%");
  });

  it("explains why comparisons are withheld without the unique-rate contract", async () => {
    render(
      <BenchmarksCard
        stats={{
          emails_sent_30d: 1_000,
          opens_total_30d: 420,
          clicks_total_30d: 60,
          bounces_total_30d: 40,
        }}
        range="30d"
      />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "Verified recipient rates unavailable",
    );
    expect(document.body.textContent).toContain(
      "Gross event totals and campaign count are never used as substitutes",
    );
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it("uses unique-sent fallback for partial delivery evidence and withholds impossible rates", async () => {
    render(
      <BenchmarksCard
        stats={{
          unique_opens_30d: 90,
          unique_clicks_30d: 20,
          unique_bounces_30d: 2,
          unique_delivered_30d: 10,
          unique_sent_30d: 100,
        }}
        range="30d"
      />,
    );
    await flush();

    expect(
      benchmarkDataRows()
        .slice(0, 3)
        .map((row) => row[1]),
    ).toEqual(["90.00%", "20.00%", "2.00%"]);

    act(() =>
      root?.render(
        <BenchmarksCard
          stats={{
            unique_opens_30d: 101,
            unique_clicks_30d: 101,
            unique_bounces_30d: 101,
            unique_delivered_30d: 50,
            unique_sent_30d: 100,
          }}
          range="30d"
        />,
      ),
    );
    expect(
      benchmarkDataRows()
        .slice(0, 3)
        .map((row) => row[1]),
    ).toEqual(["—", "—", "—"]);
    expect(document.body.textContent).not.toContain("101.00%");
  });

  it("announces benchmark loading and resolves an empty cohort honestly", async () => {
    const pending = deferred<typeof benchmarkResponse>();
    mocks.benchmarks.mockReturnValueOnce(pending.promise);
    render(<BenchmarksCard stats={stats} range="30d" />);

    expect(
      document
        .querySelector(".dashboard-benchmarks-card")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      document.querySelector('[aria-label="Loading industry benchmarks"]'),
    ).not.toBeNull();

    await act(async () => {
      pending.resolve({ data: { rows: [], note: "No cohort rows." } });
      await pending.promise;
    });
    await flush();

    expect(document.body.textContent).toContain(
      "No benchmark metrics available",
    );
    expect(
      document
        .querySelector(".dashboard-benchmarks-card")
        ?.hasAttribute("aria-busy"),
    ).toBe(false);
  });
});
