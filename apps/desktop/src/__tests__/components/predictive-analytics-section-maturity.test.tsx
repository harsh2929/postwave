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
  canAdmin: false,
  profiles: vi.fn(),
  rfmSegments: vi.fn(),
  catalog: vi.fn(),
  recompute: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  predictiveApi: {
    profiles: mocks.profiles,
    rfmSegments: mocks.rfmSegments,
    catalog: mocks.catalog,
    recompute: mocks.recompute,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../components/common/Provenance", () => ({
  ComputedFrom: ({ n, m }: { n: number; m: number }) => (
    <span>
      Computed from {n} of {m}
    </span>
  ),
  ConfidenceNote: () => <span>Low-confidence estimate</span>,
  EstimateBadge: () => <span>Estimate</span>,
  SampleSize: ({ n, noun }: { n: number; noun: string }) => (
    <span>
      {n} {noun}
    </span>
  ),
}));

vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { PredictiveAnalyticsSection } from "../../components/analytics/PredictiveAnalyticsSection";

const prediction = {
  email: "a-complete-predictive-profile-address@example.test",
  historic_clv_cents: 10_000,
  predicted_clv_cents: 12_345,
  total_clv_cents: 22_345,
  churn_risk: 0.2,
  predicted_order_count: 4,
  expected_next_order_at: "2026-08-01T00:00:00.000Z",
  predicted_gender: "unknown",
  confidence: 0.8,
  data_sufficiency: "high",
};

const rfmRow = {
  email: prediction.email,
  frequency: 8,
  monetary_cents: 12_000,
  recency_score: 5,
  frequency_score: 5,
  monetary_score: 4,
  rfm_score: "554",
  segment_key: "champions",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = false;
  for (const mock of [
    mocks.profiles,
    mocks.rfmSegments,
    mocks.catalog,
    mocks.recompute,
    mocks.toastError,
    mocks.toastSuccess,
  ]) {
    mock.mockReset();
  }
  mocks.profiles.mockResolvedValue({
    data: { items: [{ prediction, rfm: rfmRow }] },
  });
  mocks.rfmSegments.mockResolvedValue({ data: { items: [rfmRow] } });
  mocks.catalog.mockResolvedValue({
    data: {
      schema_version: "1",
      models: [],
      rfm_segments: [{ key: "champions", label: "Champions" }],
    },
  });
  mocks.recompute.mockResolvedValue({
    data: {
      run: {
        id: "run-1",
        status: "completed",
        scored_profiles: 1,
        insufficient_profiles: 0,
      },
      predictions: 1,
      rfm_scores: 1,
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

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PredictiveAnalyticsSection />));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("PredictiveAnalyticsSection maturity", () => {
  it("keeps viewer actions visible and exposes full predictive context", async () => {
    render();
    await flush();

    const recompute = button("Recompute");
    expect(recompute.disabled).toBe(false);
    expect(recompute.getAttribute("aria-disabled")).toBe("true");
    act(() => recompute.click());
    expect(mocks.recompute).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Admin access is required to recompute predictive scores.",
    );
    expect(document.body.textContent).toContain("a•••@example.test");
    expect(document.body.textContent).not.toContain(prediction.email);
    expect(document.body.textContent).toContain("(high)");
    expect(document.body.textContent).toContain("segment key: champions");
    expect(document.querySelector("caption")?.textContent).toContain(
      "Top predictive subscriber profiles",
    );
    const profilesTableRegion = container?.querySelector(
      '[role="region"][aria-label="Top predictive profiles table"]',
    );
    expect(profilesTableRegion?.getAttribute("tabindex")).toBe("0");
    expect(container?.querySelector("[title]")).toBeNull();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains synchronous load failures and single-flights retry", async () => {
    mocks.profiles
      .mockImplementationOnce(() => {
        throw new Error("private predictive database detail");
      })
      .mockResolvedValueOnce({
        data: { items: [{ prediction, rfm: rfmRow }] },
      });
    render();
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain(
      "private predictive database detail",
    );
    const retry = button("Retry predictive data");
    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.profiles).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("a•••@example.test");
    expect(document.body.textContent).not.toContain(prediction.email);
  });

  it("single-flights recompute and refreshes verified data after acknowledgement", async () => {
    mocks.canAdmin = true;
    let resolveRecompute!: (value: unknown) => void;
    mocks.recompute.mockReturnValue(
      new Promise((resolve) => {
        resolveRecompute = resolve;
      }),
    );
    render();
    await flush();
    const recompute = button("Recompute");
    await act(async () => {
      recompute.click();
      recompute.click();
      await Promise.resolve();
    });
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    expect(button("Recomputing…").disabled).toBe(false);
    expect(button("Recomputing…").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolveRecompute({
        data: {
          run: {
            id: "run-2",
            status: "completed",
            scored_profiles: 2,
            insufficient_profiles: 0,
          },
          predictions: 2,
          rfm_scores: 2,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.profiles).toHaveBeenCalledTimes(2);
  });
});
