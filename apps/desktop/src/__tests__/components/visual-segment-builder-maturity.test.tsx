// @vitest-environment happy-dom

import axe from "axe-core";
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
  registry: vi.fn(),
  previewCount: vi.fn(),
  listSegments: vi.fn(),
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: {
    registry: mocks.registry,
    previewCount: mocks.previewCount,
    list: mocks.listSegments,
  },
}));

import { VisualSegmentBuilder } from "../../components/segments/VisualSegmentBuilder";

const registry = {
  registry_version: "catalog-2026.07",
  boolean_ops: ["and", "or", "not"],
  predicates: [
    {
      key: "email",
      label: "Email address",
      category: "Profile",
      value_type: "string",
      comparators: ["equals", "contains"],
      source: "subscriber",
      activation: ["segment"],
      compiler_status: "supported",
      help: "Matches the subscriber's complete email address.",
    },
    {
      key: "consent_timestamp",
      label: "Consent date",
      category: "Consent",
      value_type: "date",
      comparators: ["before", "after", "between"],
      source: "subscriber",
      activation: ["segment"],
      compiler_status: "supported",
    },
    {
      key: "segment_id",
      label: "Saved segment membership",
      category: "Composable",
      value_type: "segment",
      comparators: ["in_segment", "not_in_segment"],
      source: "segment",
      activation: ["segment"],
      compiler_status: "supported",
    },
    {
      key: "planned_score",
      label: "Planned score",
      category: "Predictive",
      value_type: "number",
      comparators: ["gte"],
      source: "future",
      activation: ["segment"],
      compiler_status: "planned",
    },
  ],
  metrics: [],
  custom_objects: [],
  warnings: ["private internal catalog warning"],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.registry.mockResolvedValue({ data: registry });
  mocks.listSegments.mockResolvedValue({
    data: [
      { id: "segment-current", name: "Current segment" },
      { id: "segment-reference", name: "Verified reference segment" },
    ],
  });
  mocks.previewCount.mockResolvedValue({
    data: { count: 123, capped: false, computed_in_ms: 8 },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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

function fieldSelects(): HTMLSelectElement[] {
  return Array.from(
    document.querySelectorAll<HTMLSelectElement>(
      ".visual-segment-condition-fields > .visual-segment-control-label:first-child select",
    ),
  );
}

function comparatorSelects(): HTMLSelectElement[] {
  return Array.from(
    document.querySelectorAll<HTMLSelectElement>(
      ".visual-segment-condition-fields > .visual-segment-control-label:nth-child(2) select",
    ),
  );
}

function setSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("VisualSegmentBuilder interaction maturity", () => {
  it("shows explicit field guidance and only compiler-valid choices without titles", async () => {
    render(
      <VisualSegmentBuilder
        currentSegmentId="segment-current"
        onAstChange={vi.fn()}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain("catalog-2026.07");
    expect(document.body.textContent).toContain("3 filterable fields");
    expect(document.body.textContent).toContain("1 unavailable field omitted");
    expect(document.body.textContent).not.toContain(
      "private internal catalog warning",
    );
    expect(document.body.textContent).toContain(
      "reported 1 data availability warning",
    );
    expect(button("Undo").disabled).toBe(false);
    expect(button("Undo").getAttribute("aria-disabled")).toBe("true");
    expect(comparatorSelects()[0]?.disabled).toBe(false);
    expect(comparatorSelects()[0]?.getAttribute("aria-disabled")).toBe("true");

    const field = fieldSelects()[0];
    if (!field) throw new Error("Missing field picker");
    expect(
      Array.from(field.options).map((option) => option.textContent),
    ).not.toContain("Planned score");
    setSelect(field, "email");
    expect(document.body.textContent).toContain(
      "Matches the subscriber's complete email address.",
    );
    setSelect(field, "consent_timestamp");
    const comparisons = Array.from(comparatorSelects()[0]?.options ?? []).map(
      (option) => option.value,
    );
    expect(comparisons).toContain("before");
    expect(comparisons).toContain("after");
    expect(comparisons).not.toContain("between");
    expect(container?.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("retries a synchronous catalog failure once and never exposes raw detail", async () => {
    mocks.registry
      .mockImplementationOnce(() => {
        throw new Error("private predicate SQL and tenant detail");
      })
      .mockResolvedValueOnce({ data: registry });
    render(<VisualSegmentBuilder onAstChange={vi.fn()} />);
    await flush();

    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private predicate SQL");
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.registry).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Visual audience rules");
  });

  it("supports focusable reorder plus bounded undo, redo, and keyboard history", async () => {
    render(<VisualSegmentBuilder onAstChange={vi.fn()} />);
    await flush();
    const firstField = fieldSelects()[0];
    if (!firstField) throw new Error("Missing first field picker");
    setSelect(firstField, "email");
    act(() => button("Add condition").click());
    const secondField = fieldSelects()[1];
    if (!secondField) throw new Error("Missing second field picker");
    setSelect(secondField, "consent_timestamp");
    expect(document.body.textContent).toContain("2 conditions across 1 group");

    const activeMoveDown = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (candidate) =>
        candidate.textContent?.trim() === "Move down" &&
        candidate.getAttribute("aria-disabled") !== "true",
    );
    if (!activeMoveDown) throw new Error("Missing active move-down action");
    act(() => activeMoveDown.click());
    expect(fieldSelects().map((select) => select.value)).toEqual([
      "consent_timestamp",
      "email",
    ]);

    act(() => button("Undo").click());
    expect(fieldSelects().map((select) => select.value)).toEqual([
      "email",
      "consent_timestamp",
    ]);
    act(() => button("Redo").click());
    expect(fieldSelects().map((select) => select.value)).toEqual([
      "consent_timestamp",
      "email",
    ]);

    act(() => {
      fieldSelects()[0]?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(fieldSelects()[0]?.value).toBe("consent_timestamp");
    act(() => {
      button("Add condition").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(fieldSelects()[0]?.value).toBe("email");
  });

  it("keeps the builder usable when reference choices fail and safely recovers them", async () => {
    const onAstChange = vi.fn();
    mocks.listSegments
      .mockImplementationOnce(() => {
        throw new Error("private canonical-segment store detail");
      })
      .mockResolvedValueOnce({
        data: [
          { id: "segment-current", name: "Current segment" },
          { id: "segment-reference", name: "Verified reference segment" },
        ],
      });
    render(
      <VisualSegmentBuilder
        currentSegmentId="segment-current"
        onAstChange={onAstChange}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain("Visual audience rules");
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain(
      "private canonical-segment store",
    );
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.listSegments).toHaveBeenCalledTimes(2);

    const field = fieldSelects()[0];
    if (!field) throw new Error("Missing field picker");
    setSelect(field, "segment_id");
    const comparator = comparatorSelects()[0];
    if (!comparator) throw new Error("Missing comparison picker");
    setSelect(comparator, "in_segment");
    const reference = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Referenced segment"]',
    );
    if (!reference) throw new Error("Missing referenced-segment picker");
    expect(reference.disabled).toBe(false);
    expect(Array.from(reference.options).map((option) => option.value)).toEqual(
      ["", "segment-reference"],
    );
    expect(document.body.textContent).toContain(
      "1 verified segment available; the current segment is excluded.",
    );
    setSelect(reference, "segment-reference");
    await flush();
    expect(onAstChange).toHaveBeenLastCalledWith({
      op: "condition",
      field: "segment_id",
      comparator: "in_segment",
      value: "segment-reference",
    });
  });

  it("rejects a Directory saved-view envelope as a canonical segment catalog", async () => {
    const onAstChange = vi.fn();
    mocks.listSegments.mockResolvedValue({
      data: {
        items: [{ id: "saved-view-id", name: "Directory bookmark" }],
      },
    });
    render(<VisualSegmentBuilder onAstChange={onAstChange} />);
    await flush();

    expect(document.body.textContent).toContain(
      "Couldn’t verify referenced-segment choices",
    );
    const field = fieldSelects()[0];
    if (!field) throw new Error("Missing field picker");
    setSelect(field, "segment_id");
    const comparator = comparatorSelects()[0];
    if (!comparator) throw new Error("Missing comparison picker");
    setSelect(comparator, "in_segment");
    const reference = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Referenced segment"]',
    );
    if (!reference) throw new Error("Missing referenced-segment picker");
    expect(Array.from(reference.options).map((option) => option.value)).toEqual(
      [""],
    );
    expect(document.body.textContent).not.toContain("Directory bookmark");
    expect(onAstChange).toHaveBeenLastCalledWith(null);
  });

  it("contains preview failures, retries, and explains capped results visibly", async () => {
    vi.useFakeTimers();
    mocks.previewCount
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "offline",
          requestId: "preview-request-123",
          message: "private preview worker and tenant detail",
        },
      })
      .mockResolvedValueOnce({
        data: { count: 999, capped: true, computed_in_ms: 12.4 },
      });
    render(<VisualSegmentBuilder onAstChange={vi.fn()} />);
    await flush();
    const field = fieldSelects()[0];
    if (!field) throw new Error("Missing field picker");
    setSelect(field, "email");
    const comparator = comparatorSelects()[0];
    if (!comparator) throw new Error("Missing comparator picker");
    setSelect(comparator, "contains");
    const value = document.querySelector<HTMLInputElement>(
      'input[aria-label="Value"]',
    );
    if (!value) throw new Error("Missing value input");
    setInput(value, "@example.test");
    expect(document.body.textContent).toContain(
      "Waiting for rule changes to settle",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).toContain("preview-request-123");
    expect(document.body.textContent).not.toContain("private preview worker");

    const retry = button("Retry count");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.previewCount).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "At least 999 matching subscribers",
    );
    expect(document.body.textContent).toContain("Computed in 12 ms.");
    expect(document.body.textContent).toContain(
      "The 10-second evaluation budget was reached",
    );
  });
});
