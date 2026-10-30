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

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import {
  type FormField,
  FormFieldsEditor,
  firstFormFieldError,
  formFieldKeyError,
} from "../../components/forms/FormFieldsEditor";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocks.toastError.mockReset());

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function field(key: string, label: string, type = "text"): FormField {
  return { key, label, type, required: false };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function controlNamed(name: string): HTMLInputElement | HTMLSelectElement {
  const owner = Array.from(
    document.querySelectorAll<HTMLLabelElement>("label"),
  ).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === name,
  );
  if (!owner?.htmlFor) throw new Error(`Missing label: ${name}`);
  const control = document.getElementById(owner.htmlFor);
  if (
    !(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement
    )
  ) {
    throw new Error(`Missing control: ${name}`);
  }
  return control;
}

describe("FormFieldsEditor", () => {
  it("validates key syntax, the reserved email key, and duplicates", () => {
    const fields = [field("first_name", "First name"), field("plan", "Plan")];

    expect(formFieldKeyError(fields, "First-Name", 0)).toContain("lowercase");
    expect(formFieldKeyError(fields, "email", 0)).toBe("`email` is reserved.");
    expect(formFieldKeyError(fields, "plan", 0)).toBe("Duplicate of field 2.");
    expect(formFieldKeyError(fields, "first_name", 0)).toBeNull();
    expect(
      firstFormFieldError([field("dup", "One"), field("dup", "Two")]),
    ).toEqual({ index: 0, message: "Duplicate of field 2." });
  });

  it("adds a field and keeps its generated key aligned with label edits", () => {
    const onChange = vi.fn();
    render(<FormFieldsEditor initial={[]} onChange={onChange} />);

    act(() => button("+ Add field").click());
    expect(onChange).toHaveBeenLastCalledWith([field("field_1", "Field 1")]);

    const labelInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="First name"]',
    );
    if (!labelInput) throw new Error("Missing field label input");
    setInput(labelInput, "Company name");
    expect(onChange).toHaveBeenLastCalledWith([
      field("company_name", "Company name"),
    ]);
  });

  it("preserves an operator-customized key when the label changes", () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        initial={[field("first_name", "First name")]}
        onChange={onChange}
      />,
    );
    const keyInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="first_name"]',
    );
    const labelInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="First name"]',
    );
    if (!keyInput || !labelInput) throw new Error("Missing field inputs");

    setInput(keyInput, "crm_id");
    setInput(labelInput, "Customer name");
    expect(onChange).toHaveBeenLastCalledWith([
      field("crm_id", "Customer name"),
    ]);
  });

  it("gives every field editor control a stable, field-specific name", async () => {
    render(
      <FormFieldsEditor
        initial={[
          {
            ...field("plan", "Plan", "select"),
            options: ["Free", "Pro"],
          },
        ]}
        onChange={vi.fn()}
      />,
    );

    const label = controlNamed("Label for field 1");
    const key = controlNamed("Key for field 1");
    const type = controlNamed("Type for field 1");
    const options = controlNamed("Options (comma-separated) for field 1");

    for (const control of [label, key, type, options]) {
      expect(control.id).not.toBe("");
      expect(
        Array.from(control.labels ?? []).some(
          (owner) => owner.htmlFor === control.id,
        ),
      ).toBe(true);
    }

    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("attaches key validation feedback to the invalid key control", () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        initial={[field("First-Name", "First name")]}
        onChange={onChange}
      />,
    );

    const key = controlNamed("Key for field 1") as HTMLInputElement;
    expect(key.getAttribute("aria-invalid")).toBe("true");
    const errorId = key.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(key.getAttribute("aria-errormessage")).toBe(errorId);
    expect(document.getElementById(errorId ?? "")?.textContent).toContain(
      "lowercase",
    );

    setInput(key, "first_name");
    expect(key.getAttribute("aria-invalid")).toBeNull();
    expect(key.getAttribute("aria-describedby")).toBeNull();
    expect(key.getAttribute("aria-errormessage")).toBeNull();
    expect(document.getElementById(errorId ?? "")).toBeNull();
  });

  it("reorders fields and removes one only after confirmation", async () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        initial={[field("first", "First"), field("second", "Second")]}
        onChange={onChange}
      />,
    );

    const moveDown = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Move First down"]',
    );
    if (!moveDown) throw new Error("Missing move-down button");
    act(() => moveDown.click());
    expect(onChange).toHaveBeenLastCalledWith([
      field("second", "Second"),
      field("first", "First"),
    ]);

    act(() => button("Remove").click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ).find((candidate) => candidate.textContent?.trim() === "Remove");
    if (!confirm) throw new Error("Missing remove confirmation");
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith([field("first", "First")]);
  });

  it("keeps boundary and read-only move actions focusable, described, and inert", () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        initial={[field("first", "First"), field("second", "Second")]}
        onChange={onChange}
        disabled
      />,
    );

    const moveUp = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Move First up"]',
    );
    const moveDown = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Move First down"]',
    );
    if (!moveUp || !moveDown) throw new Error("Missing move controls");

    for (const action of [moveUp, moveDown]) {
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      expect(action.getAttribute("title")).toBeNull();
      const descriptionId = action.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      expect(
        document.getElementById(descriptionId ?? "")?.textContent,
      ).toContain("Field order is unavailable");
      action.focus();
      expect(document.activeElement).toBe(action);
      act(() => action.click());
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("enforces the twelve-field cap without mutating the draft", () => {
    const onChange = vi.fn();
    render(
      <FormFieldsEditor
        initial={Array.from({ length: 12 }, (_, index) =>
          field(`field_${index + 1}`, `Field ${index + 1}`),
        )}
        onChange={onChange}
      />,
    );

    act(() => button("+ Add field").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "12-field cap — consider splitting into multiple forms.",
    );
  });
});
