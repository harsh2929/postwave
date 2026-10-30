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
  canAdmin: false,
  listConnections: vi.fn(),
  listReverseETLMappings: vi.fn(),
  syncReverseETL: vi.fn(),
  deleteReverseETLMapping: vi.fn(),
  listTypes: vi.fn(),
  listRecords: vi.fn(),
  deleteType: vi.fn(),
  deleteRecord: vi.fn(),
  createType: vi.fn(),
  updateType: vi.fn(),
  upsertRecord: vi.fn(),
  transformOps: vi.fn(),
  transformPreview: vi.fn(),
  capabilityAvailable: vi.fn(),
  capabilityFromApiError: vi.fn(),
  mappingModalProps: null as null | {
    onClose: () => void;
    onSaved: () => void;
  },
}));

vi.mock("../../lib/api-client", () => ({
  warehouseApi: {
    listConnections: mocks.listConnections,
    listReverseETLMappings: mocks.listReverseETLMappings,
    syncReverseETL: mocks.syncReverseETL,
    deleteReverseETLMapping: mocks.deleteReverseETLMapping,
  },
  customObjectsApi: {
    listTypes: mocks.listTypes,
    listRecords: mocks.listRecords,
    deleteType: mocks.deleteType,
    deleteRecord: mocks.deleteRecord,
    createType: mocks.createType,
    updateType: mocks.updateType,
    upsertRecord: mocks.upsertRecord,
  },
  cdpTransformsApi: {
    ops: mocks.transformOps,
    preview: mocks.transformPreview,
  },
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.capabilityAvailable,
    fromApiError: mocks.capabilityFromApiError,
  }),
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  return {
    useDesktopRouteTab: <T extends string>(
      _section: string,
      _allowed: readonly T[],
      fallback: T,
    ) => React.useState<T>(fallback),
  };
});

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: {
    assets: "assets-hero.webp",
    migrations: "warehouse-hero.webp",
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../components/warehouse/ReverseETLMappingModal", () => ({
  ReverseETLMappingModal: (props: {
    onClose: () => void;
    onSaved: () => void;
  }) => {
    mocks.mappingModalProps = props;
    return null;
  },
}));

import { CdpTransformsSection } from "../../components/dataplatform/CdpTransformsSection";
import { CustomObjectsSection } from "../../components/dataplatform/CustomObjectsSection";
import { ReverseETLSection } from "../../components/dataplatform/ReverseETLSection";
import { DataPlatform } from "../../pages/DataPlatform";

const objectType = {
  id: "type-order",
  tenantId: "tenant-1",
  key: "order",
  label: "Order",
  primaryKey: "external_id",
  schema: { type: "object" },
  status: "active",
  version: 3,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const reverseMapping = {
  id: "mapping-1",
  source_table: "customers",
  source_column: "lifetime_value",
  target_field_key: "lifetime_value",
  profile_key_column: "email",
  profile_key_target: "email",
  cast_type: "number",
  status: "draft",
  version: 4,
  last_synced_at: null,
  last_row_count: 0,
};

const objectRecord = {
  id: "record-order-1",
  tenantId: "tenant-1",
  objectTypeId: "type-order",
  externalId: "order-1001",
  properties: { status: "completed", total: 42 },
  version: 2,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = false;
  vi.clearAllMocks();
  mocks.mappingModalProps = null;
  mocks.listConnections.mockResolvedValue({ data: { items: [] } });
  mocks.listReverseETLMappings.mockResolvedValue({ data: { items: [] } });
  mocks.deleteReverseETLMapping.mockResolvedValue({ data: undefined });
  mocks.listTypes.mockResolvedValue({ data: { items: [] } });
  mocks.listRecords.mockResolvedValue({ data: { items: [] } });
  mocks.deleteType.mockResolvedValue({ data: {} });
  mocks.deleteRecord.mockResolvedValue({ data: {} });
  mocks.createType.mockResolvedValue({ data: objectType });
  mocks.updateType.mockResolvedValue({ data: objectType });
  mocks.upsertRecord.mockResolvedValue({ data: objectRecord });
  mocks.transformOps.mockResolvedValue({
    data: { ops: ["trim", "lowercase"] },
  });
  mocks.transformPreview.mockResolvedValue({
    data: { properties: {}, results: [], success: 0, failed: 0 },
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

async function settle(): Promise<void> {
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

function buttonByAria(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Missing button labelled: ${label}`);
  return match;
}

function tab(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function setValue(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(
  label: string,
): T {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  const associated = owner?.htmlFor
    ? document.getElementById(owner.htmlFor)
    : null;
  const match =
    (associated as T | null) ?? owner?.querySelector<T>("input, textarea");
  if (!match) throw new Error(`Missing field: ${label}`);
  return match;
}

describe("Data platform 99.9th-percentile boundaries", () => {
  it("never mounts admin data planes for a view-only route session", async () => {
    render(<DataPlatform />);
    await settle();

    expect(document.body.textContent).toContain(
      "Warehouse requires administrator access",
    );
    expect(mocks.listConnections).not.toHaveBeenCalled();

    act(() => tab("Reverse ETL").click());
    await settle();
    expect(document.body.textContent).toContain(
      "Reverse ETL requires administrator access",
    );
    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(mocks.listReverseETLMappings).not.toHaveBeenCalled();

    act(() => tab("Custom objects").click());
    await settle();
    expect(mocks.listTypes).toHaveBeenCalledTimes(1);

    act(() => tab("CDP transforms").click());
    await settle();
    const preview = button("Preview requires admin");
    expect(preview.disabled).toBe(false);
    expect(preview.getAttribute("aria-disabled")).toBe("true");
    act(() => preview.click());
    expect(mocks.transformPreview).not.toHaveBeenCalled();
  });

  it("excludes streaming destinations from Reverse ETL and exposes no-op execution truth", async () => {
    mocks.listConnections.mockResolvedValue({
      data: {
        items: [
          {
            id: "streaming-1",
            name: "Event archive",
            provider: "streaming_export",
            direction: "export",
            cadence: "hourly",
            status: "active",
            object_selection: [],
          },
          {
            id: "snowflake-1",
            name: "Production warehouse",
            provider: "snowflake",
            direction: "export",
            cadence: "daily",
            status: "active",
            object_selection: ["subscribers"],
          },
        ],
      },
    });

    render(<ReverseETLSection canAdmin />);
    await settle();

    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("option"),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      "Production warehouse (snowflake)",
    ]);
    expect(mocks.listReverseETLMappings).toHaveBeenCalledWith("snowflake-1");
    const sync = button("Sync unavailable");
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    act(() => sync.click());
    expect(mocks.syncReverseETL).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "No warehouse rows are fetched",
    );
  });

  it("returns focus from Reverse ETL creation to its exact trigger or stable fallback", async () => {
    mocks.listConnections.mockResolvedValue({
      data: {
        items: [
          {
            id: "snowflake-1",
            name: "Production warehouse",
            provider: "snowflake",
            direction: "export",
            cadence: "daily",
            status: "active",
            object_selection: ["subscribers"],
          },
        ],
      },
    });
    mocks.listReverseETLMappings
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [reverseMapping] } });

    render(<ReverseETLSection canAdmin />);
    await settle();

    const emptyStateTrigger = button("Add first mapping");
    emptyStateTrigger.focus();
    act(() => emptyStateTrigger.click());
    expect(mocks.mappingModalProps).not.toBeNull();

    act(() => mocks.mappingModalProps?.onClose());
    await settle();
    expect(document.activeElement).toBe(emptyStateTrigger);

    emptyStateTrigger.focus();
    act(() => emptyStateTrigger.click());
    act(() => mocks.mappingModalProps?.onSaved());
    await settle();

    expect(document.activeElement).toBe(button("+ Add mapping"));
  });

  it("exposes Reverse ETL columns programmatically and restores delete focus deterministically", async () => {
    mocks.listConnections.mockResolvedValue({
      data: {
        items: [
          {
            id: "snowflake-1",
            name: "Production warehouse",
            provider: "snowflake",
            direction: "export",
            cadence: "daily",
            status: "active",
            object_selection: ["subscribers"],
          },
        ],
      },
    });
    mocks.listReverseETLMappings
      .mockResolvedValueOnce({ data: { items: [reverseMapping] } })
      .mockResolvedValue({ data: { items: [] } });

    render(<ReverseETLSection canAdmin />);
    await settle();

    const table = document.querySelector<HTMLElement>(
      '[role="table"][aria-label="Reverse ETL mapping contracts"]',
    );
    expect(table).not.toBeNull();
    expect(table?.getAttribute("aria-colcount")).toBe("6");
    expect(table?.querySelectorAll('[role="columnheader"]')).toHaveLength(6);
    expect(table?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(table?.querySelectorAll('[role="cell"]')).toHaveLength(6);

    const deleteTrigger = button("Delete");
    deleteTrigger.focus();
    act(() => deleteTrigger.click());
    await settle();
    const cancelDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    const cancel = Array.from(
      cancelDialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent?.trim() === "Cancel");
    if (!cancel) throw new Error("Missing delete cancellation control");
    act(() => cancel.click());
    await settle();
    expect(document.activeElement).toBe(deleteTrigger);

    act(() => deleteTrigger.click());
    await settle();
    const confirmDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    const confirm = Array.from(
      confirmDialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent?.trim() === "Delete");
    if (!confirm) throw new Error("Missing delete confirmation control");
    act(() => confirm.click());
    await settle();

    expect(mocks.deleteReverseETLMapping).toHaveBeenCalledWith(
      "snowflake-1",
      "mapping-1",
      4,
      "lifetime_value",
    );
    expect(document.activeElement).toBe(button("+ Add mapping"));
  });

  it("submits record filters explicitly instead of requesting per keystroke", async () => {
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });

    render(<CustomObjectsSection canAdmin={false} />);
    await settle();
    act(() => button("Records").click());
    await settle();
    expect(mocks.listRecords).toHaveBeenCalledTimes(1);

    setValue(field<HTMLInputElement>("Property key"), "status");
    setValue(field<HTMLInputElement>("Exact value"), "completed");
    await settle();
    expect(mocks.listRecords).toHaveBeenCalledTimes(1);

    act(() => button("Apply filter").click());
    await settle();
    expect(mocks.listRecords).toHaveBeenCalledTimes(2);
    expect(mocks.listRecords).toHaveBeenLastCalledWith("type-order", {
      propertyKey: "status",
      propertyValue: "completed",
      limit: 100,
    });
    expect(document.body.textContent).toContain(
      "Filtering runs only when submitted",
    );
  });

  it("exposes type and record directories as labelled tables with real column relationships", async () => {
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });
    mocks.listRecords.mockResolvedValue({ data: { items: [objectRecord] } });

    render(<CustomObjectsSection canAdmin />);
    await settle();

    const typeTable = document.querySelector<HTMLElement>(
      '[role="table"][aria-label="Custom object types"]',
    );
    expect(typeTable).not.toBeNull();
    expect(typeTable?.querySelectorAll('[role="columnheader"]')).toHaveLength(
      5,
    );
    expect(typeTable?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(typeTable?.querySelectorAll('[role="cell"]')).toHaveLength(5);
    expect(typeTable?.getAttribute("aria-rowcount")).toBe("2");

    act(() => button("Records").click());
    await settle();
    const recordTable = document.querySelector<HTMLElement>(
      '[role="table"][aria-label="Order record directory"]',
    );
    expect(recordTable).not.toBeNull();
    expect(recordTable?.querySelectorAll('[role="columnheader"]')).toHaveLength(
      4,
    );
    expect(recordTable?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(recordTable?.querySelectorAll('[role="cell"]')).toHaveLength(4);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("renders schema violations from bounded local copy without reflecting server canaries", async () => {
    const privateCanary = "private-card-4111111111111111@example.test";
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });
    mocks.upsertRecord.mockResolvedValue({
      error: {
        status: 422,
        message: "schema rejected",
        details: {
          fields: [
            {
              field: "total",
              code: "type_mismatch",
              message: privateCanary,
            },
            {
              field: `unsafe.${"x".repeat(120)}<script>`,
              code: `server_${"z".repeat(80)}`,
              message: privateCanary,
            },
            ...Array.from({ length: 20 }, (_, index) => ({
              field: `field_${index}`,
              code: "minimum",
              message: `${privateCanary}-${index}`,
            })),
          ],
        },
      },
    });

    render(<CustomObjectsSection canAdmin />);
    await settle();
    act(() => button("Records").click());
    await settle();
    act(() => button("+ New record").click());
    setValue(field<HTMLInputElement>("External id"), "order-1002");
    setValue(field<HTMLTextAreaElement>("Properties (JSON)"), '{"total":"x"}');
    act(() => button("Create record").click());
    await settle();

    expect(document.body.textContent).toContain(
      "Use the value type required by this field.",
    );
    expect(document.body.textContent).toContain(
      "This field did not satisfy the saved schema.",
    );
    expect(document.body.textContent).toContain("schema_violation");
    expect(document.body.textContent).not.toContain(privateCanary);
    expect(document.body.textContent).not.toContain("<script>");
    expect(document.body.textContent).not.toContain("server_");
    expect(document.querySelectorAll(".dp-violation-list > div")).toHaveLength(
      12,
    );
  });

  it("returns focus to stable create, edit, and upsert triggers after dismissal", async () => {
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });
    mocks.listRecords.mockResolvedValue({ data: { items: [objectRecord] } });

    render(<CustomObjectsSection canAdmin />);
    await settle();

    const createType = button("+ New type");
    createType.focus();
    act(() => createType.click());
    await settle();
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(createType);

    const editType = buttonByAria("Edit Order");
    editType.focus();
    act(() => editType.click());
    await settle();
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(editType);

    act(() => button("Records").click());
    await settle();
    const upsertRecord = button("+ New record");
    upsertRecord.focus();
    act(() => upsertRecord.click());
    await settle();
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(upsertRecord);

    const editRecord = buttonByAria("Edit record order-1001");
    editRecord.focus();
    act(() => editRecord.click());
    await settle();
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(editRecord);
  });

  it("binds record edits to the exact loaded version", async () => {
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });
    mocks.listRecords.mockResolvedValue({
      data: { items: [objectRecord], limit: 100, hasMore: true },
    });

    render(<CustomObjectsSection canAdmin />);
    await settle();
    act(() => button("Records").click());
    await settle();
    expect(document.body.textContent).toContain("More records exist");

    act(() => buttonByAria("Edit record order-1001").click());
    await settle();
    const externalID = field<HTMLInputElement>("External id");
    expect(externalID.disabled).toBe(true);
    setValue(
      field<HTMLTextAreaElement>("Properties (JSON)"),
      '{"status":"refunded","total":42}',
    );
    act(() => button("Save record").click());
    await settle();

    expect(mocks.upsertRecord).toHaveBeenCalledWith("type-order", {
      externalId: "order-1001",
      properties: { status: "refunded", total: 42 },
      expectedVersion: 2,
    });
  });

  it("returns focus to the stable type primary action after a deleted trigger disappears", async () => {
    mocks.listTypes
      .mockResolvedValueOnce({ data: { items: [objectType] } })
      .mockResolvedValue({ data: { items: [] } });

    render(<CustomObjectsSection canAdmin />);
    await settle();
    const stableAction = button("+ New type");
    const deleteTrigger = buttonByAria("Delete Order");
    deleteTrigger.focus();
    act(() => deleteTrigger.click());
    await settle();

    const confirmInput = document.querySelector<HTMLInputElement>(
      '[role="alertdialog"] input',
    );
    expect(confirmInput).not.toBeNull();
    setValue(confirmInput!, "order");
    act(() => button("Delete type").click());
    await settle();

    expect(mocks.deleteType).toHaveBeenCalledWith("type-order", {
      expectedVersion: 3,
      confirmationKey: "order",
    });
    expect(document.body.contains(deleteTrigger)).toBe(false);
    expect(document.activeElement).toBe(stableAction);
  });

  it("returns focus to record upsert after a deleted record trigger disappears", async () => {
    mocks.listTypes.mockResolvedValue({ data: { items: [objectType] } });
    mocks.listRecords
      .mockResolvedValueOnce({ data: { items: [objectRecord] } })
      .mockResolvedValue({ data: { items: [] } });

    render(<CustomObjectsSection canAdmin />);
    await settle();
    act(() => button("Records").click());
    await settle();

    const stableAction = button("+ New record");
    const deleteTrigger = buttonByAria("Delete record order-1001");
    deleteTrigger.focus();
    act(() => deleteTrigger.click());
    await settle();
    act(() => button("Delete record").click());
    await settle();

    expect(mocks.deleteRecord).toHaveBeenCalledWith("record-order-1", {
      expectedVersion: 2,
      confirmationExternalId: "order-1001",
    });
    expect(document.body.contains(deleteTrigger)).toBe(false);
    expect(document.activeElement).toBe(stableAction);
  });

  it("blocks viewer previews and rejects unregistered operations before transport", async () => {
    render(<CdpTransformsSection canAdmin={false} />);
    await settle();

    const viewerPreview = button("Preview requires admin");
    act(() => viewerPreview.click());
    expect(mocks.transformPreview).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Preview execution requires administrator access",
    );

    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    render(<CdpTransformsSection canAdmin />);
    await settle();
    setValue(
      field<HTMLTextAreaElement>("Operations (JSON array)"),
      '[{"type":"unregistered_op","field":"email"}]',
    );
    act(() => button("Run preview").click());
    await settle();

    expect(mocks.transformPreview).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Operation “unregistered_op” is not registered on this server.",
    );
  });

  it("renders chip-sized catalog placeholders instead of thin text lines", () => {
    mocks.transformOps.mockReturnValueOnce(new Promise(() => undefined));
    render(<CdpTransformsSection canAdmin />);

    const loading = document.querySelector<HTMLElement>(
      '.dp-chip-skeleton[role="status"]',
    );
    expect(loading?.getAttribute("aria-label")).toBe(
      "Loading registered operations",
    );
    const placeholders = Array.from(
      loading?.querySelectorAll<HTMLElement>(".skel") ?? [],
    );
    expect(placeholders).toHaveLength(3);
    expect(placeholders.map((placeholder) => placeholder.style.width)).toEqual([
      "96px",
      "122px",
      "82px",
    ]);
    expect(placeholders.map((placeholder) => placeholder.style.height)).toEqual(
      ["29px", "29px", "29px"],
    );
  });

  it("announces only the concise transform outcome and never its JSON evidence", async () => {
    mocks.transformPreview.mockResolvedValueOnce({
      data: {
        properties: { private_canary: "do-not-announce-this-value" },
        results: [
          {
            op: { type: "trim", field: "email" },
            changed: true,
            old_value: " before ",
            new_value: "before",
          },
        ],
        success: 1,
        failed: 0,
      },
    });
    render(<CdpTransformsSection canAdmin />);
    await settle();

    act(() => button("Run preview").click());
    await settle();

    const outcomePanel = document.querySelector<HTMLElement>(
      ".dp-transform-outcome",
    );
    const announcement = outcomePanel?.querySelector<HTMLElement>(
      '.dp-outcome-summary[role="status"][aria-live="polite"]',
    );
    expect(outcomePanel?.hasAttribute("aria-live")).toBe(false);
    expect(announcement?.getAttribute("aria-atomic")).toBe("true");
    expect(announcement?.textContent).toContain("1 op succeeded · 0 failed");
    expect(announcement?.textContent).not.toContain("private_canary");
    expect(announcement?.textContent).not.toContain(
      "do-not-announce-this-value",
    );
    expect(outcomePanel?.textContent).toContain("private_canary");
  });

  it("keeps local JSON formatting errors bounded and free of parser snippets", async () => {
    render(<CdpTransformsSection canAdmin />);
    await settle();
    setValue(
      field<HTMLTextAreaElement>("Input properties (JSON)"),
      '{"format-secret-canary": }',
    );
    const formatButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Format JSON");
    const formatProperties = formatButtons[0];
    if (!formatProperties) throw new Error("Missing properties formatter");

    act(() => formatProperties.click());

    const error = document.querySelector<HTMLElement>(".field-v2-error");
    expect(error?.textContent).toBe(
      "Cannot format invalid JSON. Check quotes, commas, and brackets, then try again.",
    );
    expect(error?.textContent).not.toContain("format-secret-canary");
  });

  it("rejects oversized editor input before append or format work", async () => {
    render(<CdpTransformsSection canAdmin />);
    await settle();
    const operations = field<HTMLTextAreaElement>("Operations (JSON array)");
    const oversizedOperations = `[${" ".repeat(128 * 1024)}]`;
    setValue(operations, oversizedOperations);

    act(() =>
      buttonByAria("Append a trim operation to the playground").click(),
    );

    expect(operations.value).toBe(oversizedOperations);
    expect(document.body.textContent).toContain(
      "Operations JSON must be 131,072 characters or fewer for local editing.",
    );

    const properties = field<HTMLTextAreaElement>("Input properties (JSON)");
    const oversizedProperties = `{${" ".repeat(256 * 1024)}}`;
    setValue(properties, oversizedProperties);
    const formatButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Format JSON");
    act(() => formatButtons[0]?.click());

    expect(properties.value).toBe(oversizedProperties);
    expect(document.body.textContent).toContain(
      "Properties JSON must be 262,144 characters or fewer for local editing.",
    );
  });

  it("rejects deeply nested editor input before append or format work", async () => {
    render(<CdpTransformsSection canAdmin />);
    await settle();
    const operations = field<HTMLTextAreaElement>("Operations (JSON array)");
    const deeplyNestedOperations = `${"[".repeat(33)}0${"]".repeat(33)}`;
    setValue(operations, deeplyNestedOperations);

    act(() =>
      buttonByAria("Append a trim operation to the playground").click(),
    );

    expect(operations.value).toBe(deeplyNestedOperations);
    expect(document.body.textContent).toContain(
      "Operations JSON must be nested 32 levels or fewer for local editing.",
    );

    const properties = field<HTMLTextAreaElement>("Input properties (JSON)");
    const deeplyNestedProperties = `${'{"x":'.repeat(33)}0${"}".repeat(33)}`;
    setValue(properties, deeplyNestedProperties);
    const formatButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Format JSON");
    act(() => formatButtons[0]?.click());

    expect(properties.value).toBe(deeplyNestedProperties);
    expect(document.body.textContent).toContain(
      "Properties JSON must be nested 32 levels or fewer for local editing.",
    );
    expect(mocks.transformPreview).not.toHaveBeenCalled();
  });
});
