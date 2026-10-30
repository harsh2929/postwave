// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
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
  summary: vi.fn(),
  timeseries: vi.fn(),
  quality: vi.fn(),
}));

vi.mock("../../lib/api/growth-sources", () => ({
  growthSourcesApi: {
    summary: mocks.summary,
    timeseries: mocks.timeseries,
    quality: mocks.quality,
  },
}));

vi.mock("../../components/charts/Donut", () => ({
  Donut: ({ centerLabel }: { centerLabel: string }) => (
    <div aria-label="Growth-source donut">{centerLabel}</div>
  ),
}));

vi.mock("../../components/charts/MultiLineChart", () => ({
  MultiLineChart: () => (
    <div aria-label="Growth-source daily chart">Daily chart</div>
  ),
}));

import { GrowthSourcesCard } from "../../components/lists/GrowthSourcesCard";

function summary(source = "partner-referral-complete-source") {
  return {
    window_days: 30,
    since: "2026-06-16T00:00:00.000Z",
    sources: [
      { consent_source: source, source_platform: "partner", count: 10 },
    ],
    total_new_subs: 10,
  };
}

function timeseries(source = "partner-referral-complete-source") {
  return {
    window_days: 30,
    points: [{ date: "2026-07-15", consent_source: source, count: 10 }],
  };
}

function quality(source = "partner-referral-complete-source") {
  return {
    window_days: 30,
    sources: [
      {
        consent_source: source,
        total_subscribers: 10,
        engaged: 7,
        bounced: 2,
        complained: 1,
        engagement_rate: 0.7,
        bounce_rate: 0.2,
        complaint_rate: 0.1,
      },
    ],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary.mockResolvedValue({ data: summary() });
  mocks.timeseries.mockResolvedValue({ data: timeseries() });
  mocks.quality.mockResolvedValue({ data: quality() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderCard(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<GrowthSourcesCard />));
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
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

describe("GrowthSourcesCard interaction maturity", () => {
  it("pairs every rate with its count in a semantic table without titles", async () => {
    await renderCard();
    expect(document.querySelector("caption")?.textContent).toContain(
      "Workspace-wide subscriber quality",
    );
    expect(document.body.textContent).toContain(
      "partner-referral-complete-source",
    );
    expect(document.body.textContent).toContain("7 engaged");
    expect(document.body.textContent).toContain("2 bounced");
    expect(document.body.textContent).toContain("1 complained");
    expect(document.body.textContent).toContain("70%");
    expect(container?.querySelector("[title]")).toBeNull();
    expect(button("Refresh").disabled).toBe(false);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains a synchronous failure and single-flights safe retry", async () => {
    mocks.summary
      .mockImplementationOnce(() => {
        throw new Error("private growth warehouse and tenant detail");
      })
      .mockResolvedValueOnce({ data: summary() });
    await renderCard();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private growth warehouse");
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.summary).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("7 engaged");
  });

  it("retains the verified bundle when refresh fails and prevents duplicate requests", async () => {
    await renderCard();
    mocks.summary.mockResolvedValueOnce({
      error: {
        kind: "network",
        message: "private refreshed query detail",
      },
    });
    const refresh = button("Refresh");
    act(() => {
      refresh.click();
      refresh.click();
    });
    await flush();
    expect(mocks.summary).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("7 engaged");
    expect(document.body.textContent).toContain(
      "Showing last verified growth-source analytics",
    );
    expect(document.body.textContent).not.toContain("private refreshed query");
  });

  it("ignores an older window response after the operator switches windows", async () => {
    const oldSummary = deferred<{ data: ReturnType<typeof summary> }>();
    const oldTimeseries = deferred<{ data: ReturnType<typeof timeseries> }>();
    const oldQuality = deferred<{ data: ReturnType<typeof quality> }>();
    const newSummary = deferred<{ data: ReturnType<typeof summary> }>();
    const newTimeseries = deferred<{ data: ReturnType<typeof timeseries> }>();
    const newQuality = deferred<{ data: ReturnType<typeof quality> }>();
    mocks.summary.mockImplementation((days: number) =>
      days === 30 ? oldSummary.promise : newSummary.promise,
    );
    mocks.timeseries.mockImplementation((days: number) =>
      days === 30 ? oldTimeseries.promise : newTimeseries.promise,
    );
    mocks.quality.mockImplementation((days: number) =>
      days === 30 ? oldQuality.promise : newQuality.promise,
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<GrowthSourcesCard />));
    const ninety = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="90"]',
    );
    if (!ninety) throw new Error("Missing 90-day window choice");
    act(() => ninety.click());

    await act(async () => {
      newSummary.resolve({
        data: { ...summary("new-90-day-source"), window_days: 90 },
      });
      newTimeseries.resolve({
        data: { ...timeseries("new-90-day-source"), window_days: 90 },
      });
      newQuality.resolve({
        data: { ...quality("new-90-day-source"), window_days: 90 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("new-90-day-source");

    await act(async () => {
      oldSummary.resolve({ data: summary("old-30-day-source") });
      oldTimeseries.resolve({ data: timeseries("old-30-day-source") });
      oldQuality.resolve({ data: quality("old-30-day-source") });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("new-90-day-source");
    expect(document.body.textContent).not.toContain("old-30-day-source");
  });
});
