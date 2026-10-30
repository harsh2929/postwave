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

import type {
  StreamingExportRun,
  WarehouseConnection,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  getConnection: vi.fn(),
  listStreamingRuns: vi.fn(),
  shipStreaming: vi.fn(),
  validateStreaming: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  warehouseApi: {
    createConnection: mocks.createConnection,
    getConnection: mocks.getConnection,
    listStreamingRuns: mocks.listStreamingRuns,
    shipStreaming: mocks.shipStreaming,
    validateStreaming: mocks.validateStreaming,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { StreamingExportForm } from "../../components/dataplatform/StreamingExportForm";
import { StreamingExportStatus } from "../../components/dataplatform/StreamingExportStatus";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const connection: WarehouseConnection = {
  id: "streaming-connection-1",
  name: "Subscriber event lake",
  provider: "streaming_export",
  direction: "export",
  status: "active",
  credential_ref_present: true,
  config: {
    format: "parquet",
    compression: "snappy",
    batch_size: 1_000,
    prefix: "private-prefix-secret-canary",
  },
  object_selection: ["subscriber_events"],
  cadence: "hourly",
  backfill_days: 1,
  issue_present: false,
  version: 7,
};

const loadedRuns: StreamingExportRun[] = [
  {
    id: "run-completed-1",
    connection_id: connection.id!,
    status: "completed",
    format: "parquet",
    compression: "snappy",
    window_start: "2026-08-10T00:00:00.000Z",
    window_end: "2026-08-10T01:00:00.000Z",
    cursor_from: 0,
    cursor_to: 120,
    has_more: false,
    rows_shipped: 120,
    bytes_shipped: 1_024,
    issue_present: false,
    started_at: "2026-08-10T01:00:01.000Z",
    completed_at: "2026-08-10T01:00:04.000Z",
    created_at: "2026-08-10T01:00:01.000Z",
  },
  {
    id: "run-failed-1",
    connection_id: connection.id!,
    status: "failed",
    format: "parquet",
    compression: "snappy",
    window_start: "2026-08-10T01:00:00.000Z",
    window_end: "2026-08-10T02:00:00.000Z",
    cursor_from: 120,
    cursor_to: 150,
    has_more: true,
    rows_shipped: 30,
    bytes_shipped: 2_048,
    issue_present: true,
    started_at: "2026-08-10T02:00:01.000Z",
    completed_at: "2026-08-10T02:00:04.000Z",
    created_at: "2026-08-10T02:00:01.000Z",
  },
  {
    id: "run-completed-2",
    connection_id: connection.id!,
    status: "completed",
    format: "parquet",
    compression: "snappy",
    window_start: "2026-08-10T02:00:00.000Z",
    window_end: "2026-08-10T03:00:00.000Z",
    cursor_from: 150,
    cursor_to: 200,
    has_more: false,
    rows_shipped: 50,
    bytes_shipped: 3_072,
    issue_present: false,
    started_at: "2026-08-10T03:00:01.000Z",
    completed_at: "2026-08-10T03:00:04.000Z",
    created_at: "2026-08-10T03:00:01.000Z",
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createConnection.mockResolvedValue({ data: connection });
  mocks.getConnection.mockResolvedValue({ data: connection });
  mocks.listStreamingRuns.mockResolvedValue({
    data: {
      items: loadedRuns,
      last_shipped_at: "2026-08-10T03:00:00.000Z",
    },
  });
  mocks.shipStreaming.mockResolvedValue({ data: loadedRuns[0] });
  mocks.validateStreaming.mockResolvedValue({
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

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function control<T extends HTMLInputElement | HTMLSelectElement>(
  label: string,
): T {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  const associated = owner?.htmlFor
    ? document.getElementById(owner.htmlFor)
    : null;
  const found =
    (associated as T | null) ?? owner?.querySelector<T>("input, select");
  if (!found) throw new Error(`Expected control: ${label}`);
  return found;
}

function setValue(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function labelledStatText(label: string): string {
  const labelNode = Array.from(document.querySelectorAll("div")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!labelNode?.parentElement) throw new Error(`Expected stat: ${label}`);
  return labelNode.parentElement.textContent ?? "";
}

describe("Data Platform streaming safety", () => {
  it("creates only after a successful server validation and keeps submit single-flight", async () => {
    const onSaved = vi.fn();
    render(<StreamingExportForm onClose={vi.fn()} onSaved={onSaved} />);
    setValue(control<HTMLInputElement>("Name"), "Subscriber event lake");
    expect(bodyText()).toContain("tenant-bound workspace storage");

    const creationControl = button("Create streaming export");
    expect(creationControl.getAttribute("aria-disabled")).toBeNull();
    const form = document.querySelector("form");
    if (!form) throw new Error("Expected streaming export form");

    act(() => {
      creationControl.click();
      creationControl.click();
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(mocks.validateStreaming).toHaveBeenCalledTimes(1);
    expect(mocks.createConnection).toHaveBeenCalledTimes(1);
    expect(mocks.shipStreaming).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit validation review single-flight until the user saves", async () => {
    const validation = deferred<{
      data: { valid: boolean; errors: string[]; warnings: string[] };
    }>();
    mocks.validateStreaming.mockReturnValueOnce(validation.promise);
    render(<StreamingExportForm onClose={vi.fn()} onSaved={vi.fn()} />);
    setValue(control<HTMLInputElement>("Name"), "Evidence-only destination");

    act(() => {
      button("Validate").click();
      button("Validate").click();
    });
    expect(mocks.validateStreaming).toHaveBeenCalledTimes(1);
    expect(bodyText()).toContain("Validating against the server");

    validation.resolve({
      data: { valid: true, errors: [], warnings: [] },
    });
    await settle();

    expect(bodyText()).toContain("Server validation passed");
    expect(bodyText()).toContain("Create streaming export");
    expect(mocks.createConnection).not.toHaveBeenCalled();
    expect(mocks.shipStreaming).not.toHaveBeenCalled();
  });

  it("classifies successful streaming validation arrays before rendering", async () => {
    const canary = "successful-streaming-validation-secret-canary";
    mocks.validateStreaming.mockResolvedValueOnce({
      data: {
        valid: false,
        errors: [`raw credential config is not accepted: ${canary}.password`],
        warnings: [`provider ${canary} remains planned and not executable`],
      },
    });
    render(<StreamingExportForm onClose={vi.fn()} onSaved={vi.fn()} />);
    setValue(control<HTMLInputElement>("Name"), "Safe streaming review");

    act(() => button("Validate").click());
    await settle();

    expect(bodyText()).toContain(
      "Remove raw credential material and provide only an approved credentials reference.",
    );
    expect(bodyText()).toContain(
      "This provider runtime is not attached for live execution yet.",
    );
    expect(bodyText()).not.toContain(canary);
  });

  it("shows bounded, redacted cursor evidence and ships with a freshly verified exact version", async () => {
    render(<StreamingExportStatus connection={connection} canAdmin={true} />);
    await settle();

    const text = bodyText();
    expect(text).toContain("overflow-safe, versioned cursor");
    expect(text).toContain("Rows in loaded runs");
    expect(text).toContain("latest 3 runs");
    expect(text).toContain("Failures in loaded runs");
    expect(text).not.toContain("none in this bounded response");
    expect(labelledStatText("Rows in loaded runs")).toContain("200");
    expect(labelledStatText("Rows in loaded runs")).toContain(
      "6.0 KB · latest 3 runs",
    );
    expect(labelledStatText("Failures in loaded runs")).toContain(
      "1needs attention",
    );
    expect(text).toContain(
      "Issue evidence recorded; private details are hidden",
    );
    expect(text).toContain("0–120 · caught up");
    expect(text).toContain("150–200 · caught up");
    expect(text).not.toContain("credentials-secret-canary");
    expect(text).not.toContain("private-prefix-secret-canary");
    expect(text).not.toContain("cursor-secret-canary");
    expect(text).not.toContain("raw-provider-secret-canary");
    expect(text).not.toContain("raw-cursor-canary");
    expect(text).not.toContain("signed-uri-secret-canary");
    expect(text).not.toContain("failed-object-secret-canary");
    expect(text).not.toContain("latest-object-uri-canary");
    expect(text).not.toContain("connection-error-secret-canary");

    const runTable = document.querySelector<HTMLElement>(
      '[role="table"][aria-label="Streaming export run evidence"]',
    );
    expect(runTable?.getAttribute("aria-colcount")).toBe("6");
    expect(runTable?.querySelectorAll('[role="columnheader"]')).toHaveLength(6);
    expect(runTable?.querySelectorAll('[role="row"]')).toHaveLength(4);
    expect(runTable?.querySelectorAll('[role="cell"]')).toHaveLength(18);

    const shipment = button("Ship next window");
    const replay = button("Ship next due");
    expect(shipment.getAttribute("aria-disabled")).toBeNull();
    expect(replay.getAttribute("aria-disabled")).toBeNull();
    act(() => {
      shipment.click();
      shipment.click();
      replay.click();
      replay.click();
    });
    await settle();
    expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    expect(mocks.shipStreaming).toHaveBeenCalledTimes(1);
    expect(mocks.shipStreaming).toHaveBeenCalledWith(connection.id, 7);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("retains verified evidence through a single-flight refresh failure and retry recovery", async () => {
    const initial = deferred<{
      data: { items: StreamingExportRun[]; last_shipped_at: string | null };
    }>();
    mocks.listStreamingRuns.mockReset();
    mocks.listStreamingRuns.mockReturnValueOnce(initial.promise);
    render(<StreamingExportStatus connection={connection} canAdmin={true} />);

    expect(bodyText()).toContain("Loading streaming status");
    expect(mocks.listStreamingRuns).toHaveBeenCalledTimes(1);
    initial.resolve({
      data: {
        items: loadedRuns,
        last_shipped_at: "2026-08-10T03:00:00.000Z",
      },
    });
    await settle();
    expect(bodyText()).toContain("latest 3 runs");

    const refresh = deferred<{
      error: {
        status: number;
        message: string;
        code: string;
        requestId: string;
      };
    }>();
    mocks.listStreamingRuns.mockReturnValueOnce(refresh.promise);
    act(() => {
      button("Refresh").click();
      button("Refresh").click();
    });

    expect(mocks.listStreamingRuns).toHaveBeenCalledTimes(2);
    expect(bodyText()).toContain("Refreshing shipment evidence");
    expect(bodyText()).toContain("latest 3 runs");

    refresh.resolve({
      error: {
        status: 503,
        message:
          "provider response contained refresh-api-secret-canary and s3://raw-refresh-uri-canary",
        code: "STREAM_EVIDENCE_UNAVAILABLE",
        requestId: "request-safe-123",
      },
    });
    await settle();

    expect(bodyText()).toContain("The service could not complete the request");
    expect(bodyText()).toContain(
      "Reference: STREAM_EVIDENCE_UNAVAILABLE · request-safe-123",
    );
    expect(bodyText()).toContain("latest 3 runs");
    expect(bodyText()).not.toContain("refresh-api-secret-canary");
    expect(bodyText()).not.toContain("raw-refresh-uri-canary");

    const recoveredRuns = [{ ...loadedRuns[0], rows_shipped: 7 }];
    const retry = deferred<{
      data: { items: StreamingExportRun[]; last_shipped_at: string | null };
    }>();
    mocks.listStreamingRuns.mockReturnValueOnce(retry.promise);
    act(() => {
      button("Retry status").click();
      button("Retry status").click();
    });
    expect(mocks.listStreamingRuns).toHaveBeenCalledTimes(3);
    expect(bodyText()).toContain("Refreshing shipment evidence");
    expect(bodyText()).toContain("latest 3 runs");

    retry.resolve({
      data: {
        items: recoveredRuns,
        last_shipped_at: "2026-08-10T01:00:00.000Z",
      },
    });
    await settle();

    expect(bodyText()).toContain("latest 1 run");
    expect(bodyText()).not.toContain("latest 3 runs");
    expect(bodyText()).not.toContain(
      "The service could not complete the request",
    );
    expect(mocks.shipStreaming).not.toHaveBeenCalled();
  });
});
