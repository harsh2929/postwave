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
  getSubscriberFunnel: vi.fn(),
  listTags: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  analyticsExtrasApi: {
    getSubscriberFunnel: mocks.getSubscriberFunnel,
  },
  api: {
    listTags: mocks.listTags,
  },
}));

import { CohortFunnelCard } from "../../components/analytics/CohortFunnelCard";
import type { AnalyticsDashboardModel } from "../../pages/analytics/analytics-dashboard-types";
import { CohortRetentionPanel } from "../../pages/analytics/AnalyticsHealthPanels";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function cohortDashboard(
  overrides: Partial<AnalyticsDashboardModel["view"]>,
): AnalyticsDashboardModel {
  return {
    controller: {
      lastUpdated: Date.parse("2026-07-26T10:00:00Z"),
      range: "30d",
    },
    view: {
      cohortColumns: ["W1", "W2"],
      cohortHeatmapImmatureCells: 3,
      cohortHeatmapObservedCells: 3,
      cohortHeatmapRows: [
        { label: "2026-05", size: 20, values: [0.5, 0.25] },
        { label: "2026-06", size: 10, values: [0.4] },
        { label: "2026-07", size: 4, values: [] },
      ],
      ...overrides,
    },
  } as unknown as AnalyticsDashboardModel;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTags.mockResolvedValue({ data: { items: [] } });
  mocks.getSubscriberFunnel.mockResolvedValue({
    data: {
      bucket: "month",
      cohort_by: "created_at_month",
      steps: [
        {
          stage: "signup",
          label: "Signed Up",
          count: 10,
          conversion_rate: 100,
        },
        {
          stage: "first_purchase",
          label: "First Purchase",
          count: 4,
          conversion_rate: 40,
        },
        {
          stage: "repeat_purchase",
          label: "Repeat Purchase",
          count: 2,
          conversion_rate: 50,
        },
      ],
      cohorts: [],
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("analytics cohort truth disclosures", () => {
  it("labels subscriber-relative observed weeks and distinguishes immature blanks from zero", () => {
    render(<CohortRetentionPanel dashboard={cohortDashboard({})} />);

    expect(document.body.textContent).toContain("Cohort engagement");
    expect(document.body.textContent).toContain(
      "Observed open rate · subscriber-relative weeks",
    );
    expect(document.body.textContent).toContain("Observed weeks only.");
    expect(document.body.textContent).toContain(
      "3 trailing cells are still maturing",
    );
    expect(document.body.textContent).toContain(
      "W1 is each subscriber's first seven days after their own signup",
    );
  });

  it("explains an entirely immature cohort instead of rendering an empty-data zero state", () => {
    render(
      <CohortRetentionPanel
        dashboard={cohortDashboard({
          cohortColumns: [],
          cohortHeatmapImmatureCells: 0,
          cohortHeatmapObservedCells: 0,
          cohortHeatmapRows: [{ label: "2026-07", size: 4, values: [] }],
        })}
      />,
    );

    expect(document.body.textContent).toContain("Still maturing");
    expect(document.body.textContent).toContain(
      "no signup cohort has completed a full seven-day window yet",
    );
  });

  it("discloses the paid-after-signup lifetime-to-date funnel boundary", async () => {
    render(<CohortFunnelCard />);
    await flush();

    expect(document.body.textContent).toContain("Lifetime-to-date snapshot.");
    expect(document.body.textContent).toContain(
      "Paid orders count from each subscriber's signup onward",
    );
    expect(document.body.textContent).toContain(
      "Only currently paid orders dated on or after signup",
    );
    expect(document.body.textContent).toContain(
      "newer cohorts have had less time to convert",
    );
    expect(mocks.getSubscriberFunnel).toHaveBeenCalledWith({
      weeks: 12,
      audienceId: undefined,
    });
  });
});
