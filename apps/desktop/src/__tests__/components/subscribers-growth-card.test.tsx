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
  get: vi.fn(),
  provenance: vi.fn(),
}));

vi.mock("../../lib/api/audience-growth", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/api/audience-growth")>();
  return {
    ...original,
    audienceGrowthApi: { get: mocks.get },
  };
});

vi.mock("../../components/charts/Sparkline", () => ({
  Sparkline: ({ ariaLabel }: { ariaLabel: string }) => (
    <div aria-label={ariaLabel}>sparkline</div>
  ),
}));

vi.mock("../../components/charts/AccessibleChartData", () => ({
  AccessibleChartData: (props: { provenance: { asOf: string | null } }) => {
    mocks.provenance(props.provenance);
    return <div>Accessible growth data</div>;
  },
}));

import { SubscribersGrowthCard } from "../../components/subscribers/SubscribersGrowthCard";

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
  mocks.get.mockReset();
  mocks.provenance.mockReset();
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
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
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

const response = {
  days: 90,
  series: [
    {
      date: "2026-01-01",
      evaluated_at: "2026-01-01T01:00:00.000Z",
      total: 100,
      added: 4,
      unsubbed: 1,
      lapsed: 0,
    },
    {
      date: "2026-01-02",
      evaluated_at: "2026-01-02T01:00:00.000Z",
      total: 103,
      added: 3,
      unsubbed: 0,
      lapsed: 0,
    },
  ],
  metric_contract_version: "verified-exact-ledger-v2" as const,
  unavailable_metrics: ["lapsed" as const],
  partial_metrics: ["unsubbed" as const],
  total_added: 7,
  total_unsubbed: 1,
  delta: 3,
  delta_pct: 3,
  note: "Verified withdrawals include supported exact-address transitions; legacy or unbound records are excluded. Lapsed is not available until an engagement-decay definition is configured.",
};

describe("SubscribersGrowthCard", () => {
  it("shows snapshot scope/freshness and retains verified data after refresh failure", async () => {
    mocks.get.mockResolvedValueOnce({ data: response }).mockResolvedValueOnce({
      error: { kind: "network", message: "Connection unavailable" },
    });

    render(<SubscribersGrowthCard />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Snapshot stale");
      expect(document.body.textContent).toContain(
        "Latest snapshot · 103 total",
      );
      expect(document.body.textContent).toContain("Lapsed unavailable");
      expect(document.body.textContent).toContain(
        "Verified withdrawals partial coverage",
      );
      expect(document.body.textContent).toContain("Verified ledger v2");
      expect(document.body.textContent).toContain("Metric scope and coverage");
    });
    expect(document.querySelector('[aria-label^="Lapsed per day"]')).toBeNull();
    expect(mocks.get).toHaveBeenLastCalledWith({
      days: 90,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.provenance).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: "2026-01-02T01:00:00.000Z" }),
    );

    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh audience growth"]',
    );
    await act(async () => refresh?.click());

    await waitFor(() => {
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Showing the last verified snapshot",
      );
    });
    expect(document.body.textContent).toContain("Latest snapshot · 103 total");
  });

  it("uses a compact honest cold-start state and keeps the full contract in a disclosure", async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        ...response,
        series: [],
        total_added: 0,
        total_unsubbed: 0,
        delta: 0,
        delta_pct: 0,
        note: "Contract: verified-exact-ledger-v2. Legacy heuristic snapshots are retained for audit but never returned.",
      },
    });

    render(<SubscribersGrowthCard />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("No verified snapshots yet.");
    });
    const disclosure = document.querySelector("details");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain("Metric scope and coverage");
    expect(disclosure?.textContent).toContain(
      "Legacy heuristic snapshots are retained for audit but never returned.",
    );
  });
});
