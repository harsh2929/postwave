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

const mocks = vi.hoisted(() => {
  const available = vi.fn();
  const fromApiError = vi.fn();
  return {
    catalog: vi.fn(),
    connections: vi.fn(),
    runs: vi.fn(),
    runErrors: vi.fn(),
    getConnection: vi.fn(),
    runConnection: vi.fn(),
    mappings: vi.fn(),
    connectionHealth: vi.fn(),
    connectionRuns: vi.fn(),
    available,
    fromApiError,
    reporter: {
      available,
      fromApiError,
      notConfigured: vi.fn(),
      planRequired: vi.fn(),
      partialNotConfigured: vi.fn(),
      partialPlanRequired: vi.fn(),
    },
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("../../lib/api-client", () => ({
  warehouseApi: {
    catalog: mocks.catalog,
    listConnections: mocks.connections,
    listRuns: mocks.runs,
    listRunErrors: mocks.runErrors,
    getConnection: mocks.getConnection,
    runConnection: mocks.runConnection,
    listMappings: mocks.mappings,
    connectionHealth: mocks.connectionHealth,
    listConnectionRuns: mocks.connectionRuns,
  },
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => mocks.reporter,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: vi.fn(),
  },
}));

vi.mock("../../components/dataplatform/StreamingExportForm", () => ({
  StreamingExportForm: () => null,
}));

vi.mock("../../components/dataplatform/StreamingExportStatus", () => ({
  StreamingExportStatus: () => null,
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { migrations: "warehouse-hero.webp" },
}));

import { WarehouseSection } from "../../components/dataplatform/WarehouseSection";

const catalog = {
  providers: [
    { key: "snowflake", label: "Snowflake", runtime_status: "available" },
    { key: "future-db", label: "Future DB", runtime_status: "planned" },
  ],
  objects: [
    { key: "subscribers", label: "Subscribers", runtime_status: "available" },
  ],
  import_targets: [],
  directions: ["export"],
  cadences: ["manual", "daily"],
  schema_version: "7",
};

const standardConnection = {
  id: "connection-standard-123456789",
  name: "Snowflake production with a complete readable connection name",
  provider: "snowflake",
  direction: "export",
  cadence: "daily",
  status: "active",
  credential_ref_present: true,
  object_selection: ["subscribers", "events", "commerce_orders"],
  backfill_days: 0,
  issue_present: true,
  version: 7,
};

const streamingConnection = {
  id: "connection-streaming-123456789",
  name: "Subscriber event archive",
  provider: "streaming_export",
  direction: "export",
  cadence: "5 minutes",
  status: "active",
  credential_ref_present: false,
  object_selection: [],
  backfill_days: 0,
  issue_present: false,
  version: 3,
  config: {
    format: "parquet",
    compression: "snappy",
    bucket: "s3://customer-owned-warehouse/archive/subscriber-events",
  },
};

const failedRun = {
  id: "run-complete-identifier-123456789",
  direction: "export",
  run_mode: "manual",
  status: "failed",
  rows_scanned: 10,
  rows_exported: 8,
  rows_imported: 0,
  rows_failed: 2,
  schema_errors: 1,
  object_selection: [],
  retry_count: 0,
  issue_present: true,
  started_at: "2026-07-16T04:00:00.000Z",
  error: "Two source rows did not satisfy the acknowledged schema.",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockResolvedValue({ data: catalog });
  mocks.connections.mockResolvedValue({
    data: { items: [standardConnection, streamingConnection] },
  });
  mocks.runs.mockResolvedValue({ data: { items: [failedRun] } });
  mocks.runErrors.mockResolvedValue({
    data: {
      items: [
        {
          row_number: 2,
          source_object: "orders",
          error_code: "schema_invalid",
          error_message:
            "subscriber@example.test rejected with bearer private-token",
          payload: { email: "subscriber@example.test" },
        },
        {
          row: 3,
          field: "email",
          code: "type_mismatch",
          message: "subscriber@example.test rejected with bearer private-token",
          payload: { email: "subscriber@example.test" },
        },
        {
          row: "4111111111111111",
          source_object: "source-owner@example.test",
          field: "Bearer field-private-token",
          code: "Bearer code-private-token",
          message: "Bearer message-private-token",
        },
      ],
    },
  });
  mocks.runConnection.mockResolvedValue({
    data: { ...failedRun, id: "inline-run" },
  });
  mocks.getConnection.mockResolvedValue({ data: standardConnection });
  mocks.mappings.mockResolvedValue({
    data: {
      items: [
        {
          source_object: "subscribers",
          target_event_name: "subscriber_synced",
          profile_key_column: "email",
          occurred_at_column: "updated_at",
          status: "active",
        },
      ],
    },
  });
  mocks.connectionHealth.mockResolvedValue({ data: {} });
  mocks.connectionRuns.mockResolvedValue({ data: { items: [] } });
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

async function flush(): Promise<void> {
  await act(async () => {
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

describe("WarehouseSection interaction maturity", () => {
  it("exposes source mappings as a responsive labelled table", async () => {
    render(<WarehouseSection canAdmin />);
    await flush();

    act(() => button("Manage").click());
    await flush();

    const table = document.querySelector<HTMLElement>(
      '[role="table"][aria-label^="Source mappings for"]',
    );
    expect(table).not.toBeNull();
    expect(table?.classList.contains("dp-data-list")).toBe(true);
    expect(table?.getAttribute("aria-colcount")).toBe("4");
    expect(table?.getAttribute("aria-rowcount")).toBe("4");
    expect(table?.querySelectorAll('[role="columnheader"]')).toHaveLength(4);
    expect(table?.querySelectorAll('[role="row"]')).toHaveLength(4);
    expect(table?.querySelectorAll('[role="cell"]')).toHaveLength(12);
    expect(
      new Set(
        Array.from(
          table?.querySelectorAll<HTMLElement>("[data-label]") ?? [],
        ).map((cell) => cell.dataset.label),
      ),
    ).toEqual(
      new Set([
        "Source object",
        "Target event",
        "Profile key / time",
        "Actions",
      ]),
    );
  });

  it("keeps viewer actions visible and inert while exposing complete status and values", async () => {
    render(<WarehouseSection canAdmin={false} />);
    await flush();

    for (const action of [
      button("+ New connection"),
      button("+ New streaming export"),
      button("Review run"),
    ]) {
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      act(() => action.click());
    }
    expect(mocks.runConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Admin access is required to create warehouse connections.",
    );
    expect(document.body.textContent).toContain(
      "Admin access is required to queue warehouse runs.",
    );
    expect(
      document.querySelector('[aria-label="Snowflake: available"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Future DB: planned"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(standardConnection.name);
    expect(document.body.textContent).toContain(
      "The connection reported an issue. Raw provider detail remains server-side.",
    );
    expect(document.body.textContent).toContain("commerce_orders");
    expect(document.body.textContent).not.toContain(
      streamingConnection.config.bucket,
    );
    expect(document.body.textContent).toContain(
      "Tenant-bound workspace storage",
    );
    expect(document.body.textContent).toContain(failedRun.id);
    expect(document.body.textContent).toContain(
      "The warehouse rejected one or more rows against its schema.",
    );
    expect(document.body.textContent).not.toContain(failedRun.error);
    expect(container?.querySelector('.list-row[role="button"]')).toBeNull();
    expect(container?.querySelector("[title]")).toBeNull();

    const runTable = container?.querySelector<HTMLElement>(
      '[role="table"][aria-label="Loaded warehouse sync runs"]',
    );
    expect(runTable?.getAttribute("aria-colcount")).toBe("7");
    expect(runTable?.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
    expect(runTable?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(runTable?.querySelectorAll('[role="cell"]')).toHaveLength(7);

    const streamingTable = container?.querySelector<HTMLElement>(
      '[role="table"][aria-label="Scheduled streaming exports"]',
    );
    expect(streamingTable?.getAttribute("aria-colcount")).toBe("6");
    expect(
      streamingTable?.querySelectorAll('[role="columnheader"]'),
    ).toHaveLength(6);
    expect(streamingTable?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(streamingTable?.querySelectorAll('[role="cell"]')).toHaveLength(6);

    expect(button("+ New streaming export").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(document.body.textContent).toContain(
      "Admin access is required to create a streaming export.",
    );

    act(() => button("Error evidence").click());
    await flush();
    expect(document.body.textContent).toContain("schema_invalid");
    expect(document.body.textContent).toContain("orders");
    expect(document.body.textContent).toContain("type_mismatch");
    expect(document.body.textContent).toContain("email");
    expect(document.body.textContent).toContain(
      "The warehouse did not confirm this run.",
    );
    expect(document.body.textContent).not.toContain("subscriber@example.test");
    expect(document.body.textContent).not.toContain("private-token");
    expect(document.body.textContent).not.toContain(
      "source-owner@example.test",
    );
    expect(document.body.textContent).not.toContain("4111111111111111");
    expect(document.body.textContent).not.toContain("payload");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("single-flights a run request and keeps busy controls focusable", async () => {
    let resolveRun!: (value: unknown) => void;
    mocks.runConnection.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    render(<WarehouseSection canAdmin />);
    await flush();

    act(() => button("Review run").click());
    expect(document.body.textContent).toContain(
      "This request executes inline before the HTTP 202 response returns.",
    );
    const run = button("Run now");
    act(() => {
      run.click();
      run.click();
    });
    await flush();
    expect(mocks.runConnection).toHaveBeenCalledTimes(1);
    expect(button("Running…").disabled).toBe(false);
    expect(button("Running…").getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).toContain(
      "other run controls are temporarily unavailable",
    );

    await act(async () => {
      resolveRun({
        data: { ...failedRun, id: "inline-run" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("contains synchronous overview failures and recovers through the visible retry", async () => {
    mocks.catalog.mockImplementationOnce(() => {
      throw new Error("private transport detail");
    });
    render(<WarehouseSection canAdmin />);
    await flush();

    expect(document.body.textContent).toContain(
      "Couldn't reach the warehouse catalog",
    );
    expect(document.body.textContent).not.toContain("private transport detail");
    expect(document.body.textContent).toContain(standardConnection.name);
    expect(button("+ New connection").getAttribute("aria-disabled")).toBe(
      "true",
    );

    act(() => button("Retry warehouse overview").click());
    await flush();
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[aria-label="Snowflake: available"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      "Couldn't reach the warehouse catalog",
    );
  });
});
