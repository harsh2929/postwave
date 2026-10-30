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

import type { MergeFieldSchema } from "../../lib/api/audience-segmentation";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  listMergeFieldSchema: mocks.list,
  createMergeFieldSchema: mocks.create,
  patchMergeFieldSchema: mocks.patch,
  deleteMergeFieldSchema: mocks.remove,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { MergeFieldsSchemaModal } from "../../components/subscribers/MergeFieldsSchemaModal";
import {
  MAX_POSITION,
  unicodeLength,
  validateMergeFieldDefault,
  validateMergeFieldPosition,
} from "../../components/subscribers/MergeFieldSchemaRow";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function schema(
  key: string,
  overrides: Partial<MergeFieldSchema> = {},
): MergeFieldSchema {
  return {
    tenant_id: "tenant-1",
    key,
    label: key === "FNAME" ? "First name" : "Company",
    type: "text",
    default_value: "",
    required: false,
    position: 0,
    value_count: 0,
    created_at: "2026-07-18T10:00:00Z",
    updated_at: "2026-07-18T10:00:00Z",
    ...overrides,
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [] } });
  mocks.create.mockResolvedValue({ data: schema("NEW_FIELD") });
  mocks.patch.mockResolvedValue({ data: schema("FNAME") });
  mocks.remove.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rerender(node: ReactElement): void {
  act(() => root?.render(node));
}

function setInput(id: string, value: string): void {
  const element = document.getElementById(id) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(id: string, value: string): void {
  const element = document.getElementById(id) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function row(key: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>("article")].find(
    (candidate) => candidate.querySelector("code")?.textContent === key,
  );
  if (!match) throw new Error(`Missing schema row: ${key}`);
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MergeFieldsSchemaModal", () => {
  it("validates typed defaults with real calendar and finite-number semantics", () => {
    expect(validateMergeFieldDefault("date", "2024-02-29")).toBeNull();
    expect(validateMergeFieldDefault("date", "2025-02-29")).toBe(
      "Enter a real calendar date.",
    );
    expect(validateMergeFieldDefault("number", "Infinity")).toBe(
      "Enter a valid number.",
    );
    expect(validateMergeFieldDefault("boolean", "yes")).toBe(
      "Choose true or false.",
    );
    expect(validateMergeFieldDefault("date", "0000-01-01")).toBe(
      "Enter a real calendar date.",
    );
    expect(unicodeLength("😀".repeat(200))).toBe(200);
    expect(validateMergeFieldPosition(MAX_POSITION + 1)).toContain("1,000,000");
  });

  it("reports real usage and locks only destructive controls for populated fields", async () => {
    mocks.list.mockResolvedValueOnce({
      data: {
        items: [
          schema("FNAME", { value_count: 42 }),
          schema("COMPANY", { value_count: 0 }),
        ],
      },
    });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    expect(document.body.textContent).toContain("Containing data");
    expect(document.body.textContent).toContain("42subscriber values");
    const used = row("FNAME");
    expect((used.querySelector("select") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(button("Remove", used).disabled).toBe(true);
    expect(
      (used.querySelector('input[id$="-label"]') as HTMLInputElement).disabled,
    ).toBe(false);

    const unused = row("COMPANY");
    expect((unused.querySelector("select") as HTMLSelectElement).disabled).toBe(
      false,
    );
    expect(button("Remove", unused).disabled).toBe(false);
  });

  it("fails closed on load errors and recovers through an explicit retry", async () => {
    mocks.list
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "Service unavailable" },
      })
      .mockResolvedValueOnce({ data: { items: [] } });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    expect(document.body.textContent).toContain("Schema unavailable");
    expect(document.body.textContent).not.toContain("No audience fields yet");
    expect(button("Add field").disabled).toBe(true);

    act(() => button("Retry").click());
    await flush();
    expect(document.body.textContent).toContain("No audience fields yet");
    expect(button("Add field").disabled).toBe(true);
  });

  it("treats an incomplete rolling-deploy response as unavailable, not empty", async () => {
    mocks.list.mockResolvedValueOnce({
      data: {
        items: [
          {
            key: "FNAME",
            label: "First name",
            type: "text",
            default_value: "",
            required: false,
            position: 1,
          },
        ],
      },
    });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    expect(document.body.textContent).toContain("Schema unavailable");
    expect(document.body.textContent).toContain("incomplete schema contract");
    expect(document.body.textContent).not.toContain("No audience fields yet");
    expect(button("Add field").disabled).toBe(true);
  });

  it("normalizes new keys and submits the complete typed schema contract", async () => {
    const created = schema("SCORE", {
      label: "Lead score",
      type: "number",
      default_value: "42.5",
      required: true,
      position: 3,
    });
    mocks.create.mockResolvedValueOnce({ data: created });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    setInput("mf-new-key", "score");
    setInput("mf-new-label", "Lead score");
    setSelect("mf-new-type", "number");
    setInput("mf-new-default", "42.5");
    setInput("mf-new-position", "3");
    act(() => document.getElementById("mf-new-required")?.click());
    expect(button("Add field").disabled).toBe(false);
    act(() => button("Add field").click());
    await flush();

    expect(mocks.create).toHaveBeenCalledWith({
      key: "SCORE",
      label: "Lead score",
      type: "number",
      default_value: "42.5",
      required: true,
      position: 3,
    });
    expect(row("SCORE")).toBeTruthy();
    expect(document.body.textContent).toContain("All changes saved");
  });

  it("guards dirty dismissal and single-flights per-row saves", async () => {
    const current = schema("FNAME");
    mocks.list.mockResolvedValueOnce({ data: { items: [current] } });
    const pending = deferred<{ data: MergeFieldSchema }>();
    mocks.patch.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(
      <MergeFieldsSchemaModal open onClose={onClose} onChanged={onChanged} />,
    );
    await flush();

    setInput("mf-FNAME-label", "Given name");
    act(() => button("Done").click());
    expect(document.body.textContent).toContain(
      "Discard unsaved schema changes?",
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Cancel").click());

    act(() => {
      button("Save changes", row("FNAME")).click();
      button("Save changes", row("FNAME")).click();
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("FNAME", {
      label: "Given name",
      type: "text",
      default_value: "",
      required: false,
      position: 0,
    });
    await act(async () => {
      pending.resolve({ data: { ...current, label: "Given name" } });
      await pending.promise;
    });
    await flush();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("All changes saved");
    act(() => button("Done").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps delete confirmation actionable after a recoverable server error", async () => {
    mocks.list.mockResolvedValueOnce({
      data: { items: [schema("COMPANY")] },
    });
    mocks.remove
      .mockResolvedValueOnce({
        error: { kind: "http", status: 409, message: "Field changed" },
      })
      .mockResolvedValueOnce({ data: { ok: true } });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    act(() => button("Remove", row("COMPANY")).click());
    expect(document.body.textContent).toContain("Remove COMPANY?");
    act(() => button("Remove field").click());
    await flush();
    expect(document.body.textContent).toContain("Field changed");
    expect(row("COMPANY")).toBeTruthy();

    act(() => button("Remove field").click());
    await flush();
    expect(document.body.textContent).not.toContain("Remove COMPANY?");
    expect(document.querySelector("article")).toBeNull();
  });

  it("does not remove a row when a malformed success omits confirmation", async () => {
    mocks.list.mockResolvedValueOnce({
      data: { items: [schema("COMPANY")] },
    });
    mocks.remove.mockResolvedValueOnce({ data: { ok: false } });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    act(() => button("Remove", row("COMPANY")).click());
    act(() => button("Remove field").click());
    await flush();

    expect(row("COMPANY")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "service did not confirm removal",
    );
  });

  it("preserves a current draft when an earlier open cycle settles late", async () => {
    const current = schema("FNAME");
    mocks.list.mockResolvedValue({ data: { items: [current] } });
    const pending = deferred<{ data: MergeFieldSchema }>();
    mocks.patch.mockReturnValueOnce(pending.promise);
    const props = { onClose: vi.fn() };
    render(<MergeFieldsSchemaModal open {...props} />);
    await flush();

    setInput("mf-FNAME-label", "Earlier edit");
    act(() => button("Save changes", row("FNAME")).click());
    rerender(<MergeFieldsSchemaModal open={false} {...props} />);
    rerender(<MergeFieldsSchemaModal open {...props} />);
    await flush();
    setInput("mf-FNAME-label", "Current unsaved draft");

    await act(async () => {
      pending.resolve({ data: { ...current, label: "Earlier edit" } });
      await pending.promise;
    });
    await flush();

    expect(
      (document.getElementById("mf-FNAME-label") as HTMLInputElement).value,
    ).toBe("Current unsaved draft");
    expect(document.body.textContent).toContain(
      "A field changed while this editor was open",
    );
    expect(button("Refresh fields").disabled).toBe(true);
  });

  it("restores focus after disappearing revert, clear, and delete controls", async () => {
    mocks.list.mockResolvedValueOnce({
      data: { items: [schema("FNAME"), schema("COMPANY")] },
    });
    render(<MergeFieldsSchemaModal open onClose={vi.fn()} />);
    await flush();

    setInput("mf-FNAME-label", "Given name");
    act(() => button("Revert", row("FNAME")).click());
    expect(document.activeElement?.id).toBe("mf-FNAME-label");

    setInput("mf-new-key", "TEMP");
    act(() => button("Clear draft").click());
    expect(document.activeElement?.id).toBe("mf-new-key");

    act(() => button("Remove", row("FNAME")).click());
    act(() => button("Remove field").click());
    await flush();
    expect(document.activeElement?.id).toBe("mf-COMPANY-label");
  });

  it("ignores a previous open cycle's late schema response", async () => {
    const stale = deferred<{
      error: { kind: string; status: number; message: string };
    }>();
    mocks.list
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ data: { items: [schema("CURRENT")] } });
    const props = { onClose: vi.fn() };
    render(<MergeFieldsSchemaModal open {...props} />);
    rerender(<MergeFieldsSchemaModal open={false} {...props} />);
    rerender(<MergeFieldsSchemaModal open {...props} />);
    await flush();

    await act(async () => {
      stale.resolve({
        error: {
          kind: "http",
          status: 500,
          message: "previous workspace secret",
        },
      });
      await stale.promise;
    });
    expect(document.body.textContent).toContain("CURRENT");
    expect(document.body.textContent).not.toContain(
      "previous workspace secret",
    );
  });
});
