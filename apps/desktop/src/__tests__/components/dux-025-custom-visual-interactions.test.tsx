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

const mocks = vi.hoisted(() => ({
  compareCampaigns: vi.fn(),
  overlapSegments: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getCampaignCompare: mocks.compareCampaigns },
  segmentInsightsApi: { overlap: mocks.overlapSegments },
}));

import { CampaignCompareCard } from "../../components/analytics/CampaignCompareCard";
import { PortalDashboard } from "../../components/privacy/PortalDashboard";
import { SegmentOverlapCard } from "../../components/segments/SegmentOverlapCard";
import { SendsProjection } from "../../components/settings/SendsProjection";
import { DemographicsCard } from "../../components/subscribers/DemographicsCard";

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
  vi.clearAllMocks();
  mocks.compareCampaigns.mockResolvedValue({
    data: [
      {
        campaign_id: "a",
        total_recipients: 1_000,
        open_rate: 0.5,
        click_rate: 0.2,
        bounce_rate: 0.01,
        complaint_rate: 0.001,
        unsub_rate: 0.002,
      },
      {
        campaign_id: "b",
        total_recipients: 900,
        open_rate: 0.4,
        click_rate: 0.15,
        bounce_rate: 0.02,
        complaint_rate: 0.002,
        unsub_rate: 0.003,
      },
    ],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function buttonContaining(label: string): HTMLButtonElement {
  const match = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((button) => button.textContent?.includes(label));
  if (!match) throw new Error(`Missing button containing: ${label}`);
  return match;
}

function selectValue(label: string, value: string): void {
  const select = container?.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!select) throw new Error(`Missing select: ${label}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DUX-025 custom visual interactions", () => {
  it("does not request a campaign comparison until two campaigns are selected", async () => {
    render(
      <CampaignCompareCard
        candidates={[
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
          { id: "c", name: "Gamma" },
        ]}
        initialIds={["a"]}
      />,
    );
    await flushEffects();

    expect(mocks.compareCampaigns).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Select at least two campaigns");

    act(() => buttonContaining("Beta").click());
    await flushEffects();
    expect(mocks.compareCampaigns).toHaveBeenCalledWith(["a", "b"]);
    expect(container?.querySelector("table.data-table")).not.toBeNull();
    expect(container?.textContent).toContain(
      "Moosewave campaign-comparison analytics API",
    );
  });

  it("ignores an obsolete segment-overlap response after the selection changes", async () => {
    const obsolete = deferred<{
      data: {
        a: string;
        b: string;
        a_count: number;
        b_count: number;
        intersection: number;
        jaccard: number;
      };
    }>();
    mocks.overlapSegments
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce({
        data: {
          a: "a",
          b: "c",
          a_count: 10,
          b_count: 8,
          intersection: 5,
          jaccard: 5 / 13,
        },
      });
    render(
      <SegmentOverlapCard
        segments={[
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
          { id: "c", name: "Gamma" },
        ]}
      />,
    );
    expect(buttonContaining("Compare").disabled).toBe(false);
    expect(buttonContaining("Compare").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(document.body.textContent).toContain(
      "Choose two segments to compare",
    );
    expect(buttonContaining("Compare").getAttribute("title")).toBeNull();
    selectValue("First segment", "a");
    selectValue("Second segment", "b");
    act(() => buttonContaining("Compare").click());
    expect(mocks.overlapSegments).toHaveBeenCalledWith("a", "b");

    selectValue("Second segment", "c");
    act(() => buttonContaining("Compare").click());
    await flushEffects();
    expect(mocks.overlapSegments).toHaveBeenLastCalledWith("a", "c");
    expect(container?.querySelector(".pw-chart-data p")?.textContent).toContain(
      "Gamma has 8",
    );

    await act(async () => {
      obsolete.resolve({
        data: {
          a: "a",
          b: "b",
          a_count: 10,
          b_count: 4,
          intersection: 2,
          jaccard: 1 / 6,
        },
      });
      await obsolete.promise;
    });
    expect(container?.querySelector(".pw-chart-data p")?.textContent).toContain(
      "Gamma has 8",
    );
  });

  it("retains exact sends overage while clamping only the progress geometry", () => {
    render(
      <SendsProjection
        projection={{
          current: 1_200,
          limit: 1_000,
          as_of: "2026-07-16T10:00:00Z",
          period_start: "2026-07-01T00:00:00Z",
          period_end: "2026-07-31T23:59:59Z",
          avg_per_day: 75,
          days_elapsed: 16,
          days_in_period: 31,
          projected_end_of_period: 2_325,
          projected_exceed_date: "2026-07-14T00:00:00Z",
          on_track_to_exceed: true,
        }}
      />,
    );

    const meter = container?.querySelector<HTMLElement>('[role="progressbar"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("100");
    expect(meter?.getAttribute("aria-valuetext")).toContain("120.0% used");
    expect(container?.textContent).toContain(
      "Moosewave billing plan-summary API",
    );
    expect(container?.textContent).toContain("2026-07-16T10:00:00Z");
    expect(container?.querySelector("table.data-table")?.textContent).toContain(
      "Utilization120percent",
    );
  });

  it("provides semantic privacy-summary and suppression tables", () => {
    render(
      <PortalDashboard
        summary={{
          regions: [],
          dsar_requests: [
            { request_type: "access", open: 2, overdue: 1, closed: 4 },
          ],
          gpc_signaled_count: 3,
          do_not_sell_count: 5,
          double_optin_pending: 7,
          suppression_breakdown: [{ reason: "complaint", count: 9 }],
          consent_proof_summary: [],
        }}
      />,
    );

    expect(container?.querySelectorAll("table.data-table")).toHaveLength(3);
    expect(container?.textContent).toContain(
      "Privacy-portal summary indicators",
    );
    expect(container?.textContent).toContain(
      "Moosewave privacy-portal summary API",
    );
    expect(container?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("pairs demographic confidence color with exact band and meter text", () => {
    render(
      <DemographicsCard
        label="Age group"
        trait={{
          value: "25–34",
          confidence: 0.82,
          computed_at: "2026-07-16T08:00:00Z",
        }}
      />,
    );

    expect(container?.textContent).toContain("High · 82%");
    expect(
      container
        ?.querySelector('[role="meter"]')
        ?.getAttribute("aria-valuetext"),
    ).toBe("High confidence · 82%");
  });
});
