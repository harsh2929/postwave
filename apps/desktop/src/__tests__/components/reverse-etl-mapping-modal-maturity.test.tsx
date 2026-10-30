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
  createReverseETLMapping: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  warehouseApi: {
    createReverseETLMapping: mocks.createReverseETLMapping,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
  },
}));

import { ReverseETLMappingModal } from "../../components/warehouse/ReverseETLMappingModal";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createReverseETLMapping.mockResolvedValue({
    data: {
      id: "mapping-1",
      source_table: "customers",
      source_column: "ltv_cents",
      target_field_key: "customer_lifetime_value",
      profile_key_column: "email",
      profile_key_target: "email",
      cast_type: "number",
      status: "draft",
      last_row_count: 0,
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function modal(
  overrides: Partial<Parameters<typeof ReverseETLMappingModal>[0]> = {},
): ReactElement {
  return (
    <ReverseETLMappingModal
      connectionId="warehouse-connection-1"
      connectionName="Production Snowflake"
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...overrides}
    />
  );
}

function control<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
>(label: string): T {
  const labelElement = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const id = labelElement?.htmlFor;
  const found = id ? document.getElementById(id) : null;
  if (!found) throw new Error(`Missing control: ${label}`);
  return found as T;
}

function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const found = Array.from(
    scope.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function completeMappingDraft(): void {
  change(control("Source table"), "  customer_facts  ");
  change(control("Source column"), "  lifetime_value  ");
  change(control("Target custom-field key"), "  customer_ltv  ");
}

describe("ReverseETLMappingModal maturity", () => {
  it("presents a named, accessible contract-only dialog with safety-held statuses", async () => {
    render(modal());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("Expected reverse-ETL mapping dialog");
    const titleId = dialog.getAttribute("aria-labelledby");
    const descriptionId = dialog.getAttribute("aria-describedby");

    expect(document.getElementById(titleId ?? "")?.textContent).toBe(
      "Add reverse-ETL mapping",
    );
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      'via "Production Snowflake"',
    );
    expect(dialog.textContent).toContain("Mapping contract only");
    expect(dialog.textContent).toContain("Execution held");
    expect(dialog.textContent).toContain(
      "Creating a mapping does not move subscriber data.",
    );

    const status = control<HTMLSelectElement>("Status");
    expect(status.value).toBe("draft");
    expect(Array.from(status.options, (option) => option.value)).toEqual([
      "draft",
      "paused",
    ]);
    expect(Array.from(status.options, (option) => option.value)).not.toContain(
      "active",
    );
    expect(
      dialog.querySelectorAll(".dp-form-grid.dp-form-grid-2"),
    ).toHaveLength(1);
    expect(
      dialog.querySelectorAll(".dp-form-grid.dp-form-grid-3"),
    ).toHaveLength(1);

    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("submits one trimmed, non-executing mapping contract with a bounded status", async () => {
    const onSaved = vi.fn();
    render(modal({ onSaved }));
    completeMappingDraft();
    change(control("Profile-key column"), "   ");
    change(control("Field type"), "number");
    change(control("Status"), "paused");

    act(() => button("Save mapping").click());
    await flush();

    expect(mocks.createReverseETLMapping).toHaveBeenCalledTimes(1);
    expect(mocks.createReverseETLMapping).toHaveBeenCalledWith(
      "warehouse-connection-1",
      {
        source_table: "customer_facts",
        source_column: "lifetime_value",
        target_field_key: "customer_ltv",
        profile_key_column: "email",
        profile_key_target: "email",
        cast_type: "number",
        status: "paused",
        expected_version: 0,
      },
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Mapping for "customer_facts" saved',
    );
  });

  it("contains untrusted provider detail and renders only a classified failure", async () => {
    const rawFailure =
      "postgres://operator:super-secret@internal-db/mappings bearer private-token";
    mocks.createReverseETLMapping.mockResolvedValueOnce({
      error: {
        status: 422,
        kind: "http",
        code: "mapping_invalid",
        requestId: "request-safe-42",
        message: rawFailure,
      },
    });
    render(modal());
    completeMappingDraft();

    act(() => button("Save mapping").click());
    await flush();

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain(
      "The server rejected this input. Review the highlighted fields.",
    );
    expect(alert?.textContent).toContain(
      "Reference: mapping_invalid · request-safe-42.",
    );
    expect(document.body.textContent).not.toContain(rawFailure);
    expect(document.body.textContent).not.toContain("super-secret");
    expect(document.body.textContent).not.toContain("private-token");
  });

  it("closes a clean dialog directly and requires explicit discard for a dirty draft", async () => {
    const cleanClose = vi.fn();
    render(modal({ onClose: cleanClose }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(cleanClose).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    const dirtyClose = vi.fn();
    render(modal({ onClose: dirtyClose }));
    change(control("Source table"), "customer_facts");
    act(() => button("Cancel").click());

    const confirmation = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(confirmation?.textContent).toContain(
      "Discard reverse-ETL mapping draft?",
    );
    expect(dirtyClose).not.toHaveBeenCalled();

    act(() => button("Discard draft", confirmation ?? document).click());
    await flush();
    expect(dirtyClose).toHaveBeenCalledTimes(1);
    expect(mocks.createReverseETLMapping).not.toHaveBeenCalled();
  });
});
