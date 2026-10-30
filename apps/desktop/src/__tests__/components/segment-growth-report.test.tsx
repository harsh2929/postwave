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

import type { SegmentGrowthReportResponse } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  growthReport: vi.fn(),
  growthReportCSV: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  segmentInsightsApi: {
    growthReport: mocks.growthReport,
    growthReportCSV: mocks.growthReportCSV,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { SegmentGrowthReport } from "../../components/segments/SegmentGrowthReport";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function report(
  overrides: Partial<SegmentGrowthReportResponse> = {},
): SegmentGrowthReportResponse {
  return {
    segment_id: "segment-1",
    days: 90,
    series: [
      {
        date: "2026-07-14",
        count: 100,
        adds: 10,
        drops: 2,
        delta: 0,
      },
      {
        date: "2026-07-15",
        count: 106,
        adds: 8,
        drops: 2,
        delta: 6,
        anomaly_kind: "size_cliff",
      },
    ],
    anomalies: [
      {
        date: "2026-07-15",
        anomaly_kind: "size_cliff",
        prior_count: 100,
        new_count: 106,
        leaver_count: 2,
        entrant_count: 8,
      },
    ],
    total_adds: 18,
    total_drops: 4,
    net_delta: 6,
    net_pct: 6,
    ...overrides,
  };
}

function component(
  segmentId = "segment-1",
  segmentName = "Engaged readers",
): ReactElement {
  return (
    <SegmentGrowthReport segmentId={segmentId} segmentName={segmentName} />
  );
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
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

describe("SegmentGrowthReport", () => {
  it("loads the default window, renders churn, and changes windows", async () => {
    mocks.growthReport
      .mockResolvedValueOnce({ data: report() })
      .mockResolvedValueOnce({ data: report({ days: 30 }) });
    render(component());

    await waitFor(() => {
      expect(mocks.growthReport).toHaveBeenCalledWith("segment-1", {
        days: 90,
      });
      expect(document.body.textContent).toContain("+18 added");
      expect(document.body.textContent).toContain("Anomaly events (1)");
      expect(document.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(document.querySelector("table caption")?.textContent).toContain(
        "Engaged readers membership count and daily churn data",
      );
      expect(document.body.textContent).toContain("Membership cliff");
    });

    act(() => button("30d").click());
    await waitFor(() => {
      expect(mocks.growthReport).toHaveBeenLastCalledWith("segment-1", {
        days: 30,
      });
      expect(button("Export CSV").getAttribute("aria-disabled")).toBeNull();
    });
  });

  it("distinguishes a missing segment from an invalid response", async () => {
    mocks.growthReport.mockResolvedValueOnce({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    const view = render(component());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This segment no longer exists on the server",
      );
    });

    mocks.growthReport.mockResolvedValueOnce({ data: { segment_id: "bad" } });
    view.rerender(component("segment-2", "Second"));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The growth report response was invalid",
      );
    });
  });

  it("downloads a validated CSV response and revokes its object URL", async () => {
    mocks.growthReport.mockResolvedValueOnce({ data: report() });
    mocks.growthReportCSV.mockResolvedValueOnce({
      data: { blob: new Blob(["date,count\n"]), filename: "growth.csv" },
    });
    const createObjectURL = vi.fn(() => "blob:growth-report");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(component());
    await waitFor(() =>
      expect(button("Export CSV").getAttribute("aria-disabled")).toBeNull(),
    );
    expect(button("Export CSV").disabled).toBe(false);
    expect(button("Export CSV").getAttribute("title")).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      button("Export CSV").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.growthReportCSV).toHaveBeenCalledWith("segment-1", {
      days: 90,
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="growth.csv"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:growth-report");
  });

  it("clears the prior segment while the replacement report loads", async () => {
    const replacement = deferred<{ data: SegmentGrowthReportResponse }>();
    mocks.growthReport
      .mockResolvedValueOnce({
        data: report({ note: "Private note for first segment" }),
      })
      .mockReturnValueOnce(replacement.promise);
    const view = render(component());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Private note for first segment",
      );
    });

    view.rerender(component("segment-2", "Second segment"));
    expect(document.body.textContent).not.toContain(
      "Private note for first segment",
    );

    replacement.resolve({
      data: report({
        segment_id: "segment-2",
        note: "Second segment report",
      }),
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Second segment report");
    });
  });
});
