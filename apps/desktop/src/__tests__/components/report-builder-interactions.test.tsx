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
  registry: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  run: vi.fn(),
  getRun: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reportingApi: {
    metricRegistry: mocks.registry,
    preview: mocks.preview,
    upsertDefinition: mocks.save,
    runDefinition: mocks.run,
    getRun: mocks.getRun,
  },
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => true }));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ReportBuilderSection } from "../../components/analytics/ReportBuilderSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.registry.mockResolvedValue({
    data: {
      schema_version: "1",
      items: [
        {
          key: "opens",
          label: "Unique opens",
          product_area: "engagement",
          source: "events",
          aggregation: "count",
          value_type: "number",
          dimensions: ["day"],
          runtime_status: "supported",
          help: "Counts unique recipients who opened a message.",
        },
        {
          key: "projected_ltv",
          label: "Projected LTV",
          product_area: "revenue",
          source: "predictive",
          aggregation: "sum",
          value_type: "currency",
          dimensions: ["day", "campaign"],
          runtime_status: "planned",
          help: "Requires a future predictive execution plan.",
        },
      ],
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ReportBuilderSection />));
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function exactButton(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing exact button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ReportBuilderSection interaction maturity", () => {
  it("keeps unavailable actions focusable, exposes metric help visibly, and single-flights preview", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.preview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    render();
    act(() => button("Report builder").click());
    await flush();

    const preview = button("Run preview");
    expect(preview.disabled).toBe(false);
    expect(preview.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Select at least one metric to run a preview.",
    );
    act(() => preview.click());
    expect(mocks.preview).not.toHaveBeenCalled();

    const metric = button("Unique opens");
    expect(metric.getAttribute("title")).toBeNull();
    expect(document.body.textContent).toContain(
      "Counts unique recipients who opened a message.",
    );
    act(() => metric.click());
    expect(preview.getAttribute("aria-disabled")).toBeNull();

    act(() => {
      preview.click();
      preview.click();
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(button("Running preview…").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolvePreview({
        data: {
          schema_version: "1",
          valid: true,
          rows: [{ opens: 7 }],
          metrics: [],
        },
      });
      await Promise.resolve();
    });
    expect(button("Download CSV").getAttribute("aria-disabled")).toBeNull();
    expect(
      container?.querySelectorAll(
        "button[title], input[title], select[title], textarea[title], a[title]",
      ),
    ).toHaveLength(0);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("blocks non-executable metrics and invalidates a saved revision after any draft edit", async () => {
    mocks.save.mockResolvedValue({
      data: { id: "definition-1", name: "Daily engagement" },
    });
    render();
    act(() => button("Report builder").click());
    await flush();

    const plannedMetric = button("Projected LTV");
    expect(plannedMetric.getAttribute("aria-disabled")).toBe("true");
    expect(plannedMetric.getAttribute("aria-pressed")).toBe("false");
    act(() => plannedMetric.click());
    expect(plannedMetric.getAttribute("aria-pressed")).toBe("false");
    expect(button("Run preview").getAttribute("aria-disabled")).toBe("true");

    act(() => button("Unique opens").click());
    const name = document.querySelector<HTMLInputElement>("#rb-name");
    expect(name).not.toBeNull();
    setInput(name!, "Daily engagement");

    act(() => button("Save report").click());
    await flush();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(exactButton("Run").getAttribute("aria-disabled")).toBeNull();

    setInput(name!, "Daily engagement revised");
    expect(exactButton("Run").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Draft changed after the last save.",
    );
    act(() => exactButton("Run").click());
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("lets a completed zero-row run own the result instead of reviving stale preview rows", async () => {
    mocks.preview.mockResolvedValue({
      data: {
        schema_version: "1",
        valid: true,
        rows: [{ opens: 999 }],
        metrics: [],
      },
    });
    mocks.save.mockResolvedValue({
      data: { id: "definition-1", name: "Daily engagement" },
    });
    mocks.run.mockResolvedValue({
      data: {
        id: "run-1",
        tenant_id: "tenant-1",
        definition_id: "definition-1",
        status: "completed",
        result: { rows: [] },
        rows_total: 0,
        created_at: "2026-07-24T00:00:00Z",
      },
    });

    render();
    act(() => button("Report builder").click());
    await flush();
    act(() => button("Unique opens").click());
    act(() => button("Run preview").click());
    await flush();
    expect(document.body.textContent).toContain("999");

    const name = document.querySelector<HTMLInputElement>("#rb-name");
    expect(name).not.toBeNull();
    setInput(name!, "Daily engagement");
    act(() => button("Save report").click());
    await flush();
    act(() => exactButton("Run").click());
    await flush();

    expect(document.body.textContent).toContain("completed with no rows");
    expect(document.body.textContent).not.toContain("999");
    expect(button("Download CSV").getAttribute("aria-disabled")).toBe("true");
  });
});
