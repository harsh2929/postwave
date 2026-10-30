// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity row audience-44 — editing the audience-field (merge-field) schema.
//
// The schema is production data, so what is asserted is exactly what reaches
// the server: a PATCH carries only the changed field (never a stale type), a
// field holding subscriber values cannot have its type changed or be removed,
// removal goes through a confirm that names its consequence, and closing with
// unsaved edits asks before discarding them.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      ({}),
  ),
  patch: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      ({}),
  ),
  del: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.del,
  },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: vi.fn(),
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { MergeFieldsSchemaEditor } from "@/components/subscribers/MergeFieldsSchemaModal";
import type { MeResponse } from "@/lib/auth-api";
import { createMergeField } from "@/lib/developer-reference-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const EDITOR = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT,
  email: "ada@example.com",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
} as unknown as MeResponse;
const VIEWER = {
  ...EDITOR,
  role: "viewer",
  effective_role: "viewer",
} as unknown as MeResponse;

const KEY = ["developer-reference", TENANT, "editor", "merge-fields"] as const;

function row(overrides: Record<string, unknown>) {
  return {
    tenant_id: TENANT,
    key: "FNAME",
    label: "First name",
    type: "text",
    default_value: "",
    required: false,
    position: 0,
    value_count: 0,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    ...overrides,
  };
}

const FNAME = row({});
const BIRTHDAY = row({
  key: "BIRTHDAY",
  label: "Birthday",
  type: "date",
  position: 1,
  value_count: 12,
});

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(identity: MeResponse = EDITOR): Promise<void> {
  render(createElement(MergeFieldsSchemaEditor, { identity, queryKey: KEY }));
  await flush();
  act(() => button("Edit audience fields").click());
  await flush();
}

function modal(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="merge-fields-schema-modal"]',
  );
  if (!element) throw new Error("Schema modal is not open");
  return element;
}

function fieldRow(key: string): HTMLElement {
  const element = modal().querySelector<HTMLElement>(`[data-field-key="${key}"]`);
  if (!element) throw new Error(`Row not rendered: ${key}`);
  return element;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function labelled<T extends HTMLElement>(text: string, scope: ParentNode): T {
  const label = [...scope.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const element = label ? document.getElementById(label.htmlFor) : null;
  if (!element) throw new Error(`Control not found for label: ${text}`);
  return element as T;
}

function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function topDialog(): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const top = dialogs.at(-1);
  if (!top) throw new Error("No dialog open");
  return top;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(EDITOR);
  // A small stateful server, so the refetch after each write reads back what
  // the write did instead of the original fixture.
  let server: Record<string, unknown>[] = [FNAME, BIRTHDAY];
  const keyOf = (path: string) => decodeURIComponent(path.split("/").at(-1)!);
  mocks.get.mockImplementation(async () => ({ items: server }));
  mocks.patch.mockImplementation(async (path: string, body?: unknown) => {
    const saved = {
      ...server.find((item) => item.key === keyOf(path)),
      ...(body as object),
    };
    server = server.map((item) => (item.key === saved.key ? saved : item));
    return saved;
  });
  mocks.post.mockImplementation(async (_path: string, body?: unknown) => {
    const created = row({ ...(body as object), created_at: "2026-08-05T09:00:00Z" });
    server = [...server, created];
    return created;
  });
  mocks.del.mockImplementation(async (path: string) => {
    server = server.filter((item) => item.key !== keyOf(path));
    return { ok: true };
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("audience-field schema editor", () => {
  it("opens the schema with every field and its usage", async () => {
    await open();

    expect(mocks.get).toHaveBeenCalledWith("/api/v1/merge-fields/schema");
    expect(fieldRow("FNAME").textContent).toContain("0 subscriber values");
    expect(fieldRow("BIRTHDAY").textContent).toContain("12 subscriber values");
  });

  it("patches only the field that changed, after a fresh authority check", async () => {
    await open();

    act(() => type(labelled<HTMLInputElement>("Label", fieldRow("FNAME")), "Given name"));
    expect(modal().textContent).toContain("1 unsaved field");
    act(() => button("Save changes", fieldRow("FNAME")).click());
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/merge-fields/schema/FNAME",
      { label: "Given name" },
      { requireOnline: true },
    );
    expect(modal().textContent).toContain("All changes saved");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved FNAME");
  });

  it("locks type and removal on a field that holds subscriber values", async () => {
    await open();

    const birthday = fieldRow("BIRTHDAY");
    expect(labelled<HTMLSelectElement>("Type", birthday).disabled).toBe(true);
    expect(button("Remove", birthday).disabled).toBe(true);
    expect(birthday.textContent).toContain(
      "Type and deletion are locked while this field contains data.",
    );
    expect(labelled<HTMLSelectElement>("Type", fieldRow("FNAME")).disabled).toBe(false);
  });

  it("creates a field with an upper-cased key and a type-checked default", async () => {
    await open();

    const create = modal().querySelector("section")!;
    act(() => type(labelled<HTMLInputElement>("Key", create), "plan_tier"));
    act(() => type(labelled<HTMLInputElement>("Label", create), "Plan tier"));
    act(() => type(labelled<HTMLSelectElement>("Type", create), "number"));
    act(() => type(labelled<HTMLInputElement>("Default value", create), "3"));
    act(() => type(labelled<HTMLInputElement>("Display order", create), "1.5"));
    expect(create.textContent).toContain("Enter a whole number.");
    expect(button("Add field", create).disabled).toBe(true);

    act(() => type(labelled<HTMLInputElement>("Display order", create), "0"));
    act(() => button("Add field", create).click());
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/merge-fields/schema",
      {
        key: "PLAN_TIER",
        label: "Plan tier",
        type: "number",
        default_value: "3",
        required: false,
        position: 0,
      },
      { requireOnline: true },
    );
    expect(fieldRow("PLAN_TIER").textContent).toContain("Numeric values");
  });

  it("refuses a duplicate key before spending a request", async () => {
    await open();

    const create = modal().querySelector("section")!;
    act(() => type(labelled<HTMLInputElement>("Key", create), "fname"));
    act(() => type(labelled<HTMLInputElement>("Label", create), "Dup"));
    expect(create.textContent).toContain("That key already exists.");
    expect(button("Add field", create).disabled).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("removes a field only behind a confirm that names the template consequence", async () => {
    await open();

    act(() => button("Remove", fieldRow("FNAME")).click());
    await flush();
    const confirm = topDialog();
    expect(confirm.textContent).toContain("Remove FNAME?");
    expect(confirm.textContent).toContain(
      "Moosewave will recheck for stored subscriber values when you confirm.",
    );
    expect(confirm.textContent).toContain(
      "will render an empty value until they are updated.",
    );
    expect(mocks.del).not.toHaveBeenCalled();

    await act(async () => {
      button("Remove field", confirm).click();
    });
    await flush();

    expect(mocks.del).toHaveBeenCalledWith("/api/v1/merge-fields/schema/FNAME", {
      requireOnline: true,
    });
    expect(modal().querySelector('[data-field-key="FNAME"]')).toBeNull();
  });

  it("renders the server's refusal inside the confirm and keeps the field", async () => {
    mocks.del.mockRejectedValueOnce(
      new Error("field has stored subscriber values"),
    );
    await open();

    act(() => button("Remove", fieldRow("FNAME")).click());
    await flush();
    await act(async () => {
      button("Remove field", topDialog()).click();
    });
    await flush();

    expect(topDialog().textContent).toContain("field has stored subscriber values");
    expect(fieldRow("FNAME")).toBeTruthy();
  });

  it("asks before discarding unsaved edits on close", async () => {
    await open();

    act(() => type(labelled<HTMLInputElement>("Label", fieldRow("FNAME")), "Changed"));
    act(() => button("Done", modal()).click());
    await flush();
    expect(topDialog().textContent).toContain("Discard unsaved schema changes?");
    expect(topDialog().textContent).toContain(
      "Saved fields stay intact. Local row edits and the new-field draft will be discarded.",
    );

    await act(async () => {
      button("Keep editing", topDialog()).click();
    });
    await flush();
    expect(labelled<HTMLInputElement>("Label", fieldRow("FNAME")).value).toBe("Changed");

    act(() => button("Done", modal()).click());
    await flush();
    await act(async () => {
      button("Discard changes", topDialog()).click();
    });
    await flush();

    expect(
      document.querySelector('[data-testid="merge-fields-schema-modal"]'),
    ).toBeNull();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("disables editing when the schema read is ambiguous", async () => {
    mocks.get.mockResolvedValue({ items: [FNAME, row({ position: 3 })] });
    await open();

    expect(modal().textContent).toContain(
      "Editing is disabled to prevent a cross-workspace or duplicate-key update.",
    );
    const create = modal().querySelector("section")!;
    expect(labelled<HTMLInputElement>("Key", create).disabled).toBe(true);
  });

  it("withholds the editor from a viewer, with the reason", async () => {
    render(createElement(MergeFieldsSchemaEditor, { identity: VIEWER, queryKey: KEY }));
    await flush();

    expect(button("Edit audience fields").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Editing audience fields needs owner, admin, or editor access.",
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe("createMergeField", () => {
  it("stores merge tags upper-cased, whatever the caller passed", async () => {
    await createMergeField({
      key: " plan ",
      label: " Plan ",
      type: "text",
      default_value: "",
      required: true,
      position: 2,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/merge-fields/schema",
      {
        key: "PLAN",
        label: "Plan",
        type: "text",
        default_value: "",
        required: true,
        position: 2,
      },
      { requireOnline: true },
    );
  });
});
