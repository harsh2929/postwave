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
  providers: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    warehouseApi: {
      ...actual.warehouseApi,
      providers: mocks.providers,
      validate: mocks.validate,
    },
  };
});

import type { WarehouseCatalogResponse } from "../../lib/api-client";

import { StreamingExportForm } from "../../components/dataplatform/StreamingExportForm";
import { ConnectionCreateModal } from "../../components/dataplatform/WarehouseSection";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.providers.mockResolvedValue({ data: { items: [] } });
  mocks.validate.mockResolvedValue({
    data: { valid: true, errors: [], warnings: [] },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function control<
  T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
>(label: string): T {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  const associated = owner?.htmlFor
    ? document.getElementById(owner.htmlFor)
    : null;
  const found =
    (associated as T | null) ??
    owner?.querySelector<T>("input, select, textarea");
  if (!found) throw new Error(`Expected control: ${label}`);
  return found;
}

function setValue(
  target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const catalog: WarehouseCatalogResponse = {
  providers: [
    { key: "snowflake", label: "Snowflake", runtime_status: "available" },
    { key: "bigquery", label: "BigQuery", runtime_status: "available" },
  ],
  objects: [
    { key: "subscribers", label: "Subscribers", runtime_status: "available" },
  ],
  import_targets: [],
  directions: ["export"],
  cadences: ["manual"],
  schema_version: "1",
  workers: [],
};

describe("data-platform provider replacement", () => {
  it("classifies successful warehouse validation arrays before rendering", async () => {
    const canary = "successful-validation-secret-canary";
    mocks.validate.mockResolvedValueOnce({
      data: {
        valid: false,
        errors: [`raw credential config is not accepted: ${canary}.password`],
        warnings: [`provider ${canary} remains planned and not executable`],
      },
    });
    render(
      <ConnectionCreateModal
        catalog={catalog}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    setValue(control<HTMLInputElement>("Name"), "Safe validation review");
    const object = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!object) throw new Error("Expected warehouse object checkbox");
    act(() => object.click());
    act(() => button("Validate").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Remove raw credential material and provide only an approved credentials reference.",
    );
    expect(document.body.textContent).toContain(
      "This provider runtime is not attached for live execution yet.",
    );
    expect(document.body.textContent).not.toContain(canary);
  });

  it("confirms and clears warehouse provider-scoped config", async () => {
    render(
      <ConnectionCreateModal
        catalog={catalog}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const provider = control<HTMLSelectElement>("Provider");
    setValue(control<HTMLInputElement>("Credentials reference"), "vault://sf");
    setValue(
      control<HTMLTextAreaElement>("Provider config"),
      '{"account":"acme"}',
    );
    setValue(provider, "bigquery");

    expect(document.body.textContent).toContain(
      "Replace provider-specific connection settings?",
    );
    expect(provider.value).toBe("snowflake");
    expect(control<HTMLInputElement>("Credentials reference").value).toBe(
      "vault://sf",
    );
    act(() => button("Replace provider").click());
    await flush();
    expect(provider.value).toBe("bigquery");
    expect(control<HTMLInputElement>("Credentials reference").value).toBe("");
    expect(control<HTMLTextAreaElement>("Provider config").value).toBe("");
  });

  it("keeps streaming exports on tenant-bound workspace storage", async () => {
    render(<StreamingExportForm onClose={vi.fn()} onSaved={vi.fn()} />);
    const prefix = control<HTMLInputElement>("Workspace-storage prefix");
    setValue(prefix, "tenant-a/events");

    expect(prefix.value).toBe("tenant-a/events");
    expect(document.body.textContent).toContain(
      "tenant-bound Moosewave workspace storage",
    );
    expect(document.body.textContent).not.toContain("Destination type");
    expect(document.body.textContent).not.toContain("Bucket / destination");
    expect(document.body.textContent).not.toContain("Credentials reference");
  });
});
