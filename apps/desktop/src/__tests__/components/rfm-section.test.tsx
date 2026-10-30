// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
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
  PredictivePrediction,
  PredictiveProfileAnalytics,
  RFMScoreRow,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: false,
  catalog: vi.fn(),
  profile: vi.fn(),
  profiles: vi.fn(),
  recompute: vi.fn(),
  rfmSegments: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  predictiveApi: {
    catalog: mocks.catalog,
    profile: mocks.profile,
    profiles: mocks.profiles,
    recompute: mocks.recompute,
    rfmSegments: mocks.rfmSegments,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/SectionHeader", () => ({
  SectionHeader: ({
    actions,
    description,
    title,
  }: {
    actions?: ReactNode;
    description?: string;
    title: string;
  }) => (
    <header>
      <h2>{title}</h2>
      <p>{description}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../../components/charts/Heatmap", () => ({
  Heatmap: ({ rows }: { rows: unknown[] }) => (
    <div aria-label="RFM heatmap">{rows.length} rows</div>
  ),
}));

vi.mock("../../components/common/Provenance", () => ({
  ConfidenceNote: () => <span>Low-confidence estimate</span>,
  EstimateBadge: () => <span>Estimate</span>,
}));

import { RFMSection } from "../../components/segments/RFMSection";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rfmRow(overrides: Partial<RFMScoreRow> = {}): RFMScoreRow {
  return {
    email: "champion@example.com",
    frequency: 8,
    monetary_cents: 12_000,
    recency_score: 5,
    frequency_score: 5,
    monetary_score: 4,
    rfm_score: "554",
    segment_key: "champions",
    ...overrides,
  };
}

function prediction(
  email: string,
  predictedClvCents = 12_345,
): PredictivePrediction {
  return {
    email,
    historic_clv_cents: 10_000,
    predicted_clv_cents: predictedClvCents,
    total_clv_cents: 22_345,
    churn_risk: 0.2,
    predicted_order_count: 4,
    predicted_gender: "unknown",
    confidence: 0.8,
    data_sufficiency: "high",
  };
}

function profile(
  email: string,
  predictedClvCents = 12_345,
): PredictiveProfileAnalytics {
  return {
    prediction: prediction(email, predictedClvCents),
    rfm: rfmRow({ email }),
  };
}

function catalogResult(label = "Heuristic CLV") {
  return {
    data: {
      schema_version: "1",
      models: [
        {
          key: "heuristic_clv",
          label,
          runtime_status: "available",
          version: "heuristic-v1",
        },
      ],
      rfm_segments: [{ key: "champions", label: "Champions" }],
    },
  };
}

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
  vi.resetAllMocks();
  mocks.canAdmin = false;
  mocks.catalog.mockResolvedValue(catalogResult());
  mocks.rfmSegments.mockResolvedValue({ data: { items: [rfmRow()] } });
  mocks.profiles.mockResolvedValue({
    data: { items: [profile("listed@example.com")] },
  });
  mocks.profile.mockResolvedValue({ data: profile("lookup@example.com") });
  mocks.recompute.mockResolvedValue({
    data: {
      run: {
        id: "run/one",
        status: "completed",
        scored_profiles: 2,
        insufficient_profiles: 0,
      },
      predictions: 2,
      rfm_scores: 2,
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

function renderSection(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<RFMSection />));
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 7; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
}

function change(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    setNativeValue(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("RFMSection request and rendering boundaries", () => {
  it("loads the catalog, grid, and profiles with server-backed filters", async () => {
    renderSection();
    await flushEffects();

    expect(mocks.catalog).toHaveBeenCalledTimes(1);
    expect(mocks.rfmSegments).toHaveBeenCalledTimes(1);
    expect(mocks.profiles).toHaveBeenCalledWith({ limit: 50 });
    expect(container?.textContent).toContain("Heuristic CLV");
    expect(container?.textContent).toContain("listed@example.com");
    expect(
      container?.querySelector('[aria-label="RFM heatmap"]'),
    ).not.toBeNull();

    const segment =
      container?.querySelector<HTMLSelectElement>("#rfm-prof-segment");
    const limit =
      container?.querySelector<HTMLSelectElement>("#rfm-prof-limit");
    expect(segment).not.toBeNull();
    expect(limit).not.toBeNull();
    change(segment!, "champions");
    await flushEffects();
    expect(mocks.profiles).toHaveBeenLastCalledWith({
      segment: "champions",
      limit: 50,
    });
    change(limit!, "100");
    await flushEffects();
    expect(mocks.profiles).toHaveBeenLastCalledWith({
      segment: "champions",
      limit: 100,
    });
  });

  it("keeps a newer profile-filter response when an older request finishes last", async () => {
    const oldRequest = deferred<{
      data: { items: PredictiveProfileAnalytics[] };
    }>();
    mocks.profiles
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        data: { items: [profile("new@example.com")] },
      });
    renderSection();
    await flushEffects();

    const segment =
      container?.querySelector<HTMLSelectElement>("#rfm-prof-segment");
    change(segment!, "champions");
    await flushEffects();
    expect(container?.textContent).toContain("new@example.com");

    await act(async () => {
      oldRequest.resolve({
        data: { items: [profile("stale@example.com")] },
      });
      await oldRequest.promise;
    });
    expect(container?.textContent).toContain("new@example.com");
    expect(container?.textContent).not.toContain("stale@example.com");
  });

  it("normalizes and serializes lookup, then suppresses a stale edited-email result", async () => {
    const oldRequest = deferred<{ data: PredictiveProfileAnalytics }>();
    mocks.profile
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ data: profile("new@example.com", 2_222) });
    renderSection();
    await flushEffects();
    const input = container?.querySelector<HTMLInputElement>(
      'input[type="email"]',
    );
    const form = input?.closest("form");
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();
    change(input!, "  Mixed@Example.COM  ");
    act(() => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.profile).toHaveBeenCalledTimes(1);
    expect(mocks.profile).toHaveBeenCalledWith("mixed@example.com");

    change(input!, "new@example.com");
    act(() => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flushEffects();
    expect(mocks.profile).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("$22.22");

    await act(async () => {
      oldRequest.resolve({ data: profile("old@example.com", 1_111) });
      await oldRequest.promise;
    });
    expect(container?.textContent).toContain("$22.22");
    expect(container?.textContent).not.toContain("$11.11");
  });

  it("surfaces blank and not-found lookup states without fabricating a profile", async () => {
    mocks.profile.mockResolvedValue({
      error: { status: 404, code: "not_found", message: "missing" },
    });
    renderSection();
    await flushEffects();
    const input = container?.querySelector<HTMLInputElement>(
      'input[type="email"]',
    );
    const form = input?.closest("form");
    act(() => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(container?.textContent).toContain("Enter a subscriber email first.");
    expect(mocks.profile).not.toHaveBeenCalled();

    change(input!, "unknown@example.com");
    act(() => {
      form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flushEffects();
    expect(container?.textContent).toContain(
      "No predictive profile for that email",
    );
    expect(container?.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("fails recompute closed for non-admins", async () => {
    renderSection();
    await flushEffects();
    const recompute = button("Recompute");
    expect(recompute.disabled).toBe(false);
    expect(recompute.getAttribute("aria-disabled")).toBe("true");
    expect(recompute.getAttribute("aria-describedby")).toBe(
      "rfm-recompute-unavailable",
    );
    expect(recompute.getAttribute("title")).toBeNull();
    expect(document.body.textContent).toContain(
      "Admin role required to recompute predictive scores",
    );
    act(() => recompute.click());
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("serializes admin recompute, reports exact counts, and reloads with fresh data", async () => {
    const recomputeRequest = deferred<{
      data: {
        run: {
          id: string;
          status: string;
          scored_profiles: number;
          insufficient_profiles: number;
        };
        predictions: number;
        rfm_scores: number;
      };
    }>();
    mocks.canAdmin = true;
    mocks.recompute.mockReturnValue(recomputeRequest.promise);
    renderSection();
    await flushEffects();
    const recompute = button("Recompute");
    act(() => {
      recompute.click();
      recompute.click();
    });
    expect(mocks.recompute).toHaveBeenCalledTimes(1);

    await act(async () => {
      recomputeRequest.resolve({
        data: {
          run: {
            id: "run/two",
            status: "completed",
            scored_profiles: 2,
            insufficient_profiles: 0,
          },
          predictions: 2,
          rfm_scores: 2,
        },
      });
      await recomputeRequest.promise;
    });
    await flushEffects();
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Scored 2 profiles",
      detail: "2 predictions and 2 RFM scores stored.",
    });
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(mocks.rfmSegments).toHaveBeenCalledTimes(2);
  });

  it("suppresses recompute completion, toast, and reload after unmount", async () => {
    const request = deferred<{
      data: {
        run: {
          id: string;
          status: string;
          scored_profiles: number;
          insufficient_profiles: number;
        };
        predictions: number;
        rfm_scores: number;
      };
    }>();
    mocks.canAdmin = true;
    mocks.recompute.mockReturnValue(request.promise);
    renderSection();
    await flushEffects();
    act(() => button("Recompute").click());
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      request.resolve({
        data: {
          run: {
            id: "run/late",
            status: "completed",
            scored_profiles: 1,
            insufficient_profiles: 0,
          },
          predictions: 1,
          rfm_scores: 1,
        },
      });
      await request.promise;
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });
});

describe("RFMSection quality boundary", () => {
  it("uses the lifecycle controller and removes the legacy function ratchet", () => {
    const source = readFileSync(
      "src/components/segments/RFMSection.tsx",
      "utf8",
    );
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(source).toContain("useRFMSectionController");
    expect(source).toContain("RFMSectionView");
    expect(budgets).not.toContain('"src/components/segments/RFMSection.tsx"');
  });
});
