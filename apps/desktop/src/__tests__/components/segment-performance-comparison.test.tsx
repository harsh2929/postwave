// @vitest-environment happy-dom

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

import type { Segment } from "../../components/segments/segmentsClient";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  engagementSummary: vi.fn(),
  growth: vi.fn(),
}));

vi.mock("../../components/segments/segmentPnlClient", () => ({
  segmentPnlClient: {
    compare: mocks.compare,
    engagementSummary: mocks.engagementSummary,
  },
}));

vi.mock("../../lib/api-client", () => ({
  segmentInsightsApi: { growth: mocks.growth },
}));

import { SegmentPerformanceComparison } from "../../components/segments/SegmentPerformanceComparison";

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

const segments: Segment[] = [
  { id: "segment-1", name: "Engaged" },
  { id: "segment-2", name: "New readers" },
  { id: "segment-3", name: "At risk" },
  { id: "segment-4", name: "VIP" },
  { id: "segment-5", name: "Trial" },
  { id: "segment-6", name: "Dormant" },
];

function pnl(segmentId: string, revenueCents: number) {
  return {
    segment_id: segmentId,
    member_count: 100,
    revenue_cents: revenueCents,
    revenue_per_member_cents: revenueCents / 100,
    currency: "USD",
  };
}

function engagement(segmentId: string) {
  return {
    segment_id: segmentId,
    member_count: 100,
    sends: 80,
    open_rate: 0.5,
    click_rate: 0.125,
    unsub_rate: 0.01,
  };
}

function growth(segmentId: string) {
  return {
    segment_id: segmentId,
    days: 90,
    series: [
      { date: "2026-07-14", evaluated_at: "2026-07-14T00:00:00Z", count: 90 },
      { date: "2026-07-15", evaluated_at: "2026-07-15T00:00:00Z", count: 100 },
    ],
    delta: 10,
    delta_pct: 11.1,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function component(): ReactElement {
  return <SegmentPerformanceComparison segments={segments} onClose={vi.fn()} />;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function selectSegments(count: number): void {
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
  act(() => {
    for (const checkbox of checkboxes.slice(0, count)) checkbox.click();
  });
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

describe("SegmentPerformanceComparison", () => {
  it("compares the selected segments across all three data sources", async () => {
    mocks.compare.mockResolvedValueOnce({
      data: { items: [pnl("segment-1", 12500), pnl("segment-2", 5000)] },
    });
    mocks.engagementSummary
      .mockResolvedValueOnce({ data: engagement("segment-1") })
      .mockResolvedValueOnce({ data: engagement("segment-2") });
    mocks.growth
      .mockResolvedValueOnce({ data: growth("segment-1") })
      .mockResolvedValueOnce({ data: growth("segment-2") });
    render(component());
    selectSegments(2);

    act(() => button("Compare").click());

    await waitFor(() => {
      expect(mocks.compare).toHaveBeenCalledWith(["segment-1", "segment-2"], {
        days: 90,
      });
      expect(mocks.engagementSummary).toHaveBeenCalledTimes(2);
      expect(mocks.growth).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Growth (90d)");
      expect(document.body.textContent).toContain("50.0%");
      expect(document.body.textContent).toContain("+10 (+11.1%)");
    });
  });

  it("labels results with the request window even if the picker changes in flight", async () => {
    const comparison = deferred<{
      data: { items: ReturnType<typeof pnl>[] };
    }>();
    mocks.compare.mockReturnValueOnce(comparison.promise);
    mocks.engagementSummary
      .mockResolvedValueOnce({ data: engagement("segment-1") })
      .mockResolvedValueOnce({ data: engagement("segment-2") });
    mocks.growth
      .mockResolvedValueOnce({ data: growth("segment-1") })
      .mockResolvedValueOnce({ data: growth("segment-2") });
    render(component());
    selectSegments(2);
    act(() => button("Compare").click());
    act(() => button("30d").click());

    comparison.resolve({
      data: { items: [pnl("segment-1", 12500), pnl("segment-2", 5000)] },
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Growth (90d)");
    });
    expect(document.body.textContent).not.toContain("Growth (30d)");
  });

  it("enforces the five-segment cap and surfaces compare failures", async () => {
    render(component());
    selectSegments(5);
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes[5]?.disabled).toBe(true);
    expect(document.body.textContent).toContain("5/5 selected");

    mocks.compare.mockResolvedValueOnce({
      error: { message: "PnL unavailable" },
    });
    for (let index = 0; index < 5; index += 1) {
      mocks.engagementSummary.mockResolvedValueOnce({
        data: engagement(`segment-${index + 1}`),
      });
      mocks.growth.mockResolvedValueOnce({
        data: growth(`segment-${index + 1}`),
      });
    }
    act(() => button("Compare").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Compare failed: PnL unavailable",
      );
    });
  });
});
