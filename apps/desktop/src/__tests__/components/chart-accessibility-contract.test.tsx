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

import { BarChart } from "../../components/charts/BarChart";
import { CategoricalDistributionChart } from "../../components/charts/CategoricalDistributionChart";
import { Donut } from "../../components/charts/Donut";
import { EngagementSparkline } from "../../components/charts/EngagementSparkline";
import { Funnel } from "../../components/charts/Funnel";
import { Heatmap } from "../../components/charts/Heatmap";
import { LineChart } from "../../components/charts/LineChart";
import { MultiLineChart } from "../../components/charts/MultiLineChart";
import { Sparkline } from "../../components/charts/Sparkline";
import { chartRowsToCsv } from "../../components/charts/AccessibleChartData";

const mocks = vi.hoisted(() => ({
  saveFile: vi.fn(),
}));

vi.mock("../../lib/file-transfer", () => ({ saveFile: mocks.saveFile }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const TEST_CHART_SUPPORT = {
  provenance: { source: "Test fixture", asOf: null, scope: "Unit test" },
  exportFileName: "test-chart.csv",
  exportPrivacy: "personal" as const,
  valueLabel: "Events",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.saveFile.mockReset();
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "chart-export",
    collision: false,
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  class ResizeObserverStub {
    observe(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("shared chart accessibility contract", () => {
  it("gives every dense SVG chart a summary, native data table, and keyboard inspection", () => {
    render(
      <>
        <BarChart
          {...TEST_CHART_SUPPORT}
          title="Campaign results"
          categories={["Alpha", "Beta"]}
          series={[
            { label: "Opens", values: [20, 30] },
            { label: "Clicks", values: [5, 8] },
          ]}
        />
        <LineChart
          {...TEST_CHART_SUPPORT}
          title="Subscriber growth"
          data={[
            { date: "2026-07-01", count: 10 },
            { date: "2026-07-02", count: 14 },
          ]}
        />
        <MultiLineChart
          {...TEST_CHART_SUPPORT}
          title="Engagement velocity"
          series={[
            {
              label: "Opens",
              values: [
                { date: "2026-07-01", count: 10 },
                { date: "2026-07-02", count: 12 },
              ],
            },
            {
              label: "Clicks",
              values: [
                { date: "2026-07-01", count: 2 },
                { date: "2026-07-02", count: 4 },
              ],
            },
          ]}
        />
        <Donut
          {...TEST_CHART_SUPPORT}
          title="Bounce categories"
          slices={[
            { label: "Hard", value: 7 },
            { label: "Soft", value: 3 },
          ]}
        />
        <EngagementSparkline
          {...TEST_CHART_SUPPORT}
          points={[
            { date: "2026-07-01", opens: 4, clicks: 1 },
            { date: "2026-07-02", opens: 6, clicks: 2 },
          ]}
        />
      </>,
    );

    const disclosures = document.querySelectorAll("details.pw-chart-data");
    expect(disclosures).toHaveLength(5);
    expect(document.querySelectorAll("table.data-table")).toHaveLength(5);
    expect(document.body.textContent).toContain("Campaign results data");
    expect(document.body.textContent).toContain("Bounce categories data");

    const inspectable = Array.from(
      document.querySelectorAll<SVGElement>('svg[tabindex="0"]'),
    );
    expect(inspectable).toHaveLength(4);
    for (const chart of inspectable) {
      expect(chart.getAttribute("aria-label")).toMatch(/Arrow keys|Arrow key/i);
    }

    // Bars use hatch patterns and multi-series lines use dash patterns, so
    // series identity is not communicated by hue alone.
    expect(document.querySelectorAll("pattern").length).toBeGreaterThan(1);
    expect(document.querySelector("path[stroke-dasharray]")).not.toBeNull();
    expect(document.body.textContent).toContain("●");
    expect(document.body.textContent).toContain("◆");
  });

  it("exposes compact charts and funnels as useful text rather than decorative colour", () => {
    render(
      <>
        <Sparkline values={[2, 4, 3, 8]} />
        <Funnel
          {...TEST_CHART_SUPPORT}
          title="Message funnel"
          rows={[
            { label: "Sent", value: 100 },
            { label: "Opened", value: 50 },
          ]}
          showConversion
        />
      </>,
    );
    expect(document.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "minimum 2, maximum 8",
    );
    expect(
      document.querySelector('[role="list"]')?.getAttribute("aria-label"),
    ).toContain("2 stages");
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(document.body.textContent).toContain("50%");
  });

  it("exposes provenance and exports the exact table through the transfer service", async () => {
    render(
      <LineChart
        title="Subscriber growth"
        provenance={{
          source: "Moosewave API",
          asOf: null,
          scope: "Current view",
        }}
        exportFileName="subscriber-growth-data.csv"
        exportPrivacy="personal"
        valueLabel="Subscribers"
        data={[
          { date: "2026-07-01", count: 10 },
          { date: "2026-07-02", count: 14 },
        ]}
      />,
    );
    expect(document.body.textContent).toContain("Source");
    expect(document.body.textContent).toContain("Moosewave API");
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Export data CSV"),
    );
    await act(async () => {
      exportButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "subscriber-growth-data.csv",
        privacy: "personal",
        mimeType: "text/csv;charset=utf-8",
      }),
    );
    const call = mocks.saveFile.mock.calls[0]?.[0] as { data?: string };
    expect(call.data).toContain("Chart,Subscriber growth");
    expect(call.data).toContain("Date,Subscribers");
    expect(document.body.textContent).toContain("Chart data export started");
  });

  it("neutralizes spreadsheet formulas and includes provenance in CSV", () => {
    const csv = chartRowsToCsv({
      title: "=Risky values",
      rowHeaderLabel: "Label",
      columns: [{ key: "value", label: "+Value" }],
      rows: [
        {
          key: "one",
          label: "@Formula",
          values: { value: '=HYPERLINK("https://example.test")' },
        },
      ],
      provenance: {
        source: "-Moosewave API",
        asOf: "2026-07-16T00:00:00Z",
        scope: "=Current tenant · 30 days",
      },
    });
    expect(csv).toContain("Chart,'=Risky values");
    expect(csv).toContain("Source,'-Moosewave API");
    expect(csv).toContain("Scope,'=Current tenant · 30 days");
    expect(csv).toContain("Label,'+Value");
    expect(csv).toContain("'@Formula");
    expect(csv).toContain("Data as of,2026-07-16T00:00:00Z");
    expect(csv).toContain("'=");
  });

  it("makes compact sparklines keyboard-inspectable and non-color encoded", () => {
    render(
      <Sparkline
        values={[2, 4, 3, 8]}
        labels={["Mon", "Tue", "Wed", "Thu"]}
        trend="down"
        valueLabel="events"
      />,
    );
    const chart = document.querySelector<SVGElement>('svg[tabindex="0"]')!;
    expect(chart.getAttribute("aria-label")).toContain(
      "Left and Right Arrow keys",
    );
    expect(document.querySelector("table.data-table")).toBeNull();
    expect(chart.querySelector("path[stroke-dasharray]")).not.toBeNull();
    act(() => {
      chart.focus();
      chart.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain("Tue: 4");
  });

  it("keeps dense noninteractive sparklines numeric without adding a tab stop", () => {
    render(
      <Sparkline
        values={[2, 0, 8]}
        labels={["Mon", "Tue", "Wed"]}
        valueLabel="events"
        interactive={false}
        ariaLabel="Checkout event volume across three UTC days"
      />,
    );
    const chart = document.querySelector<SVGElement>("svg")!;
    expect(chart.getAttribute("tabindex")).toBeNull();
    expect(chart.getAttribute("aria-label")).toContain(
      "starts at 2, ends at 8, minimum 0, maximum 8",
    );
    expect(chart.querySelector("desc")?.textContent).toContain(
      "3 recorded points",
    );
    expect(chart.querySelector("desc")?.textContent).not.toContain(
      "inspectable",
    );
  });

  it("adds exact table and centralized CSV only when compact disclosure is requested", async () => {
    render(
      <Sparkline
        values={[2, 4, 3]}
        labels={["Mon", "Tue", "Wed"]}
        valueLabel="Events"
        dataDisclosure={{
          title: "Compact event trend",
          summary: "Three exact daily event values.",
          provenance: {
            source: "Moosewave event API",
            scope: "Current workspace · three days",
            asOf: null,
          },
          exportFileName: "compact-event-trend.csv",
          exportPrivacy: "confidential",
          rowHeaderLabel: "Day",
        }}
      />,
    );
    expect(document.querySelector("table.data-table")?.textContent).toContain(
      "Tue4",
    );
    expect(document.body.textContent).toContain("Moosewave event API");
    const exportButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Export Compact event trend data as CSV"]',
    );
    await act(async () => exportButton?.click());
    expect(mocks.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "compact-event-trend.csv",
        privacy: "confidential",
      }),
    );
  });

  it("preserves missing sparkline samples as disclosed gaps instead of fake zeroes", () => {
    render(
      <Sparkline
        values={[2, Number.NaN, 8]}
        labels={["Mon", "Tue", "Wed"]}
        valueLabel="events"
      />,
    );
    const chart = document.querySelector<SVGElement>('svg[tabindex="0"]')!;
    expect(chart.getAttribute("aria-label")).toContain("1 unavailable");
    const path = chart.querySelector("path")?.getAttribute("d") ?? "";
    expect(path).not.toContain("NaN");
    expect(path.match(/M/g)).toHaveLength(2);
    act(() => {
      chart.focus();
      chart.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain("Tue: No data");
  });
});

describe("shared dense-chart data integrity contract", () => {
  it("keeps negative values inside a signed domain with a visible zero baseline", () => {
    render(
      <LineChart
        {...TEST_CHART_SUPPORT}
        title="Net attributed revenue"
        valueLabel="Revenue"
        formatValue={(value) => `${value.toFixed(0)} USD`}
        data={[
          { date: "2026-07-01", count: -30 },
          { date: "2026-07-02", count: 10 },
          { date: "2026-07-03", count: -5 },
        ]}
      />,
    );

    const chart = document.querySelector<SVGElement>('svg[role="img"]');
    expect(chart).not.toBeNull();
    const points = [...chart!.querySelectorAll<SVGCircleElement>("circle")].map(
      (point) => Number(point.getAttribute("cy")),
    );
    expect(points).toHaveLength(3);
    expect(points.every((value) => value >= 0 && value <= 200)).toBe(true);
    expect(points[0]).toBeGreaterThan(points[1] ?? 0);
    expect(chart?.textContent).toContain("-30 USD");
    expect(chart?.textContent).toContain("0 USD");
    expect(chart?.textContent).toContain("10 USD");
    expect(
      chart?.querySelector(
        'line[stroke="var(--pw-fg-muted)"][stroke-width="1.5"]',
      ),
    ).not.toBeNull();
    expect(chart?.getAttribute("aria-label")).toContain("bottoms at -30 USD");
    expect(
      chart?.querySelector('path[fill="none"]')?.getAttribute("d"),
    ).not.toContain("NaN");
  });

  it("preserves invalid dense-chart values as disclosed gaps without NaN geometry", () => {
    render(
      <>
        <LineChart
          {...TEST_CHART_SUPPORT}
          title="Gapped line"
          data={[
            { date: "2026-07-01", count: 2 },
            { date: "2026-07-02", count: Number.NaN },
            { date: "2026-07-03", count: 8 },
          ]}
        />
        <BarChart
          {...TEST_CHART_SUPPORT}
          title="Gapped bars"
          categories={["Valid", "Missing"]}
          series={[{ label: "Events", values: [4, Number.NaN] }]}
        />
        <Donut
          {...TEST_CHART_SUPPORT}
          title="Gapped donut"
          slices={[
            { label: "Valid", value: 4 },
            { label: "Missing", value: Number.NaN },
          ]}
        />
        <CategoricalDistributionChart
          {...TEST_CHART_SUPPORT}
          title="Gapped distribution"
          segments={[
            {
              key: "valid",
              label: "Valid",
              value: 4,
              color: "var(--pw-accent)",
            },
            {
              key: "missing",
              label: "Missing",
              value: Number.NaN,
              color: "var(--pw-danger)",
            },
          ]}
        />
      </>,
    );
    expect(document.body.textContent).toContain("No data");
    expect(document.body.textContent).toContain("unavailable");
    for (const element of document.querySelectorAll(
      "[d], [cx], [cy], [height]",
    )) {
      for (const attribute of ["d", "cx", "cy", "height"]) {
        const value = element.getAttribute(attribute);
        if (value != null) expect(value).not.toContain("NaN");
      }
    }
    const line =
      document.querySelectorAll("svg path")[0]?.getAttribute("d") ?? "";
    expect(line.match(/M/g)).toHaveLength(2);
  });

  it("exports a semantic heatmap without duplicating its visible data table", async () => {
    render(
      <Heatmap
        metricLabel="Retention by cohort"
        valueLabel="Retention rate"
        rowHeaderLabel="Signup month"
        columns={["Week 0", "Week 1"]}
        rows={[{ label: "June", size: 25, values: [1, 0.5] }]}
        provenance={{
          source: "Moosewave retention API",
          asOf: null,
          scope: "Current workspace · selected cohorts",
        }}
        exportFileName="retention-by-cohort.csv"
        exportPrivacy="personal"
      />,
    );
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(document.querySelector('table[role="grid"]')).not.toBeNull();
    const firstCell = document.querySelector<HTMLElement>(
      '[data-heatmap-cell="0:0"]',
    );
    expect(firstCell?.getAttribute("aria-label")).toBe("June, Week 0: 100%");
    expect(firstCell?.getAttribute("title")).toBeNull();
    expect(document.body.textContent).toContain(
      "View data provenance and export",
    );
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Export data CSV"),
    );
    await act(async () => {
      exportButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = mocks.saveFile.mock.calls[0]?.[0] as { data?: string };
    expect(call.data).toContain(
      "Signup month,Cohort size,Week 0 · Retention rate,Week 1 · Retention rate",
    );
    expect(call.data).toContain("June,25,100%,50%");
  });

  it("joins multiline series by date, announces inspected values, and exports only visible series", async () => {
    render(
      <MultiLineChart
        {...TEST_CHART_SUPPORT}
        title="Disjoint activity"
        valueLabel="Events"
        series={[
          {
            label: "Opens",
            values: [
              { date: "2026-07-01", count: 4 },
              { date: "2026-07-03", count: 8 },
            ],
          },
          {
            label: "Clicks",
            values: [
              { date: "2026-07-02", count: 2 },
              { date: "2026-07-03", count: 3 },
            ],
          },
        ]}
      />,
    );

    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Jul 14No data",
      "Jul 2No data2",
      "Jul 383",
    ]);

    const chart = document.querySelector<SVGElement>('svg[tabindex="0"]')!;
    act(() => {
      chart.focus();
      chart.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain(
      "Jul 2. Opens: No data; Clicks: 2.",
    );

    const clicksToggle = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Clicks")!;
    act(() => clicksToggle.click());
    expect(document.querySelector("table")?.textContent).not.toContain(
      "Clicks",
    );

    const exportButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Export data CSV"))!;
    await act(async () => {
      exportButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = mocks.saveFile.mock.calls[0]?.[0] as { data?: string };
    expect(call.data).toContain("Date,Opens");
    expect(call.data).not.toContain("Date,Opens,Clicks");
    expect(call.data).toContain("\r\nJul 2,\r\n");
  });

  it("keeps empty funnels attributable and export-discoverable", () => {
    render(<Funnel {...TEST_CHART_SUPPORT} title="Empty funnel" rows={[]} />);
    expect(document.body.textContent).toContain(
      "No data available for Empty funnel",
    );
    expect(document.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "View data table for Empty funnel",
    );
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Export Empty funnel data as CSV",
    );
  });
});
