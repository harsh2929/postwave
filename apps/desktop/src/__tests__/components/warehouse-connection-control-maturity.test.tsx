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
  connectionHealth: vi.fn(),
  getConnection: vi.fn(),
  listConnectionRuns: vi.fn(),
  pauseConnection: vi.fn(),
  deleteConnection: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  warehouseApi: {
    connectionHealth: mocks.connectionHealth,
    getConnection: mocks.getConnection,
    listConnectionRuns: mocks.listConnectionRuns,
    pauseConnection: mocks.pauseConnection,
    deleteConnection: mocks.deleteConnection,
  },
}));

import { WarehouseConnectionControl } from "../../components/dataplatform/WarehouseConnectionControl";
import type {
  WarehouseConnection,
  WarehouseSyncRun,
} from "../../lib/api-client";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const CONNECTION_ID = "warehouse-connection-1";
const CONNECTION_NAME = "Primary warehouse";
const RAW_CREDENTIAL = "RAW_CREDENTIAL_CANARY_vault://tenant/private";
const RAW_CURSOR = "RAW_CURSOR_CANARY_2026-08-10T00:00:00Z";
const RAW_INPUT_URI = "s3://private-bucket/RAW_INPUT_URI_CANARY.ndjson";
const RAW_OUTPUT_URI = "gs://private-bucket/RAW_OUTPUT_URI_CANARY.parquet";
const RAW_PROVIDER_ERROR =
  "authentication rejected RAW_PROVIDER_ERROR_CANARY bearer-private-token";
const RAW_CONNECTION_ERROR =
  "credential RAW_CONNECTION_ERROR_CANARY failed to decrypt";
const RAW_RUN_ERROR =
  "schema table rejected RAW_RUN_ERROR_CANARY subscriber@example.test";

const CONNECTION: WarehouseConnection = {
  id: CONNECTION_ID,
  name: CONNECTION_NAME,
  provider: "snowflake",
  direction: "export",
  status: "active",
  credential_ref_present: true,
  config: {
    credentials_ref: `${RAW_CREDENTIAL}-config`,
    private_endpoint: "https://RAW_PRIVATE_ENDPOINT_CANARY.example.test",
  },
  object_selection: ["subscribers", "events"],
  cadence: "daily",
  backfill_days: 30,
  issue_present: true,
  version: 5,
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-09T12:00:00.000Z",
};

const HEALTH = {
  status: "active",
  health: "healthy",
  last_run_status: "completed",
  last_run_at: "2026-08-10T06:00:00.000Z",
  provider_runtime_status: "available",
  provider_driver_attachment: "worker_attached",
  missing_required_settings: [],
  warning_count: 1,
  issue_present: true,
  warnings: ["RAW_HEALTH_WARNING_CANARY"],
  error: "network timeout RAW_HEALTH_ERROR_CANARY private-provider-host",
  provider_health: {
    state: "provider_checked",
    live_state: "healthy",
    execution_mode: "bounded_sql",
    executable: true,
    statements_executed: 2,
    missing_required_settings: [],
    warning_count: 1,
    issue_present: true,
    warnings: ["RAW_PROVIDER_WARNING_CANARY"],
    error: RAW_PROVIDER_ERROR,
    credentials_ref: RAW_CREDENTIAL,
    cursor: RAW_CURSOR,
    output_uri: RAW_OUTPUT_URI,
  },
};

const RECENT_RUN: WarehouseSyncRun = {
  id: "run-verified-1234567890",
  connection_id: CONNECTION_ID,
  direction: "export",
  run_mode: "scheduled",
  status: "completed",
  object_selection: ["subscribers"],
  rows_scanned: 12,
  rows_exported: 7,
  rows_imported: 2,
  rows_failed: 1,
  schema_errors: 2,
  retry_count: 0,
  issue_present: true,
  started_at: "2026-08-10T06:00:00.000Z",
  completed_at: "2026-08-10T06:01:00.000Z",
  created_at: "2026-08-10T06:00:00.000Z",
  updated_at: "2026-08-10T06:01:00.000Z",
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
  mocks.connectionHealth.mockResolvedValue({ data: HEALTH });
  mocks.getConnection.mockResolvedValue({ data: CONNECTION });
  mocks.listConnectionRuns.mockResolvedValue({
    data: { items: [RECENT_RUN] },
  });
  mocks.pauseConnection.mockResolvedValue({
    data: { ...CONNECTION, status: "paused" },
  });
  mocks.deleteConnection.mockResolvedValue({
    data: {
      ok: true,
      id: CONNECTION_ID,
      previous_version: 5,
      version: 6,
      status: "disconnected",
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

function renderControl({
  canAdmin = true,
  connection = CONNECTION,
  onConnectionChanged = vi.fn(),
  onDisconnected = vi.fn(),
}: {
  canAdmin?: boolean;
  connection?: WarehouseConnection;
  onConnectionChanged?: (connection: WarehouseConnection) => void;
  onDisconnected?: () => void;
} = {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <WarehouseConnectionControl
        connection={connection}
        canAdmin={canAdmin}
        onConnectionChanged={onConnectionChanged}
        onDisconnected={onDisconnected}
      />,
    ),
  );
}

async function settle(rounds = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settle(2);
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function typeConfirmation(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    '[role="alertdialog"] input',
  );
  if (!input) throw new Error("Missing typed-confirmation input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForInitialEvidence(): Promise<void> {
  await waitFor(() => {
    expect(mocks.connectionHealth).toHaveBeenCalledWith(CONNECTION_ID, false);
    expect(mocks.listConnectionRuns).toHaveBeenCalledWith(CONNECTION_ID);
    expect(text()).toContain("Provider Checked");
    expect(text()).toContain("Recent runs");
  });
}

describe("WarehouseConnectionControl maturity", () => {
  it("renders verified health and recent runs without leaking provider, credential, cursor, URI, or row details", async () => {
    renderControl();
    await waitForInitialEvidence();

    expect(text()).toContain("Healthy");
    expect(text()).toContain("Worker Attached");
    expect(text()).toContain("Present (value hidden)");
    expect(text()).toContain("2 bounded verification statements executed.");
    expect(text()).toContain("9 moved · 3 failed");
    expect(text()).toContain(
      "The provider reported an issue. Raw provider detail remains server-side.",
    );
    expect(text()).toContain(
      "This run recorded an issue. Raw provider detail remains server-side.",
    );

    for (const canary of [
      RAW_CREDENTIAL,
      RAW_CURSOR,
      RAW_INPUT_URI,
      RAW_OUTPUT_URI,
      RAW_PROVIDER_ERROR,
      RAW_CONNECTION_ERROR,
      RAW_RUN_ERROR,
      "RAW_PRIVATE_ENDPOINT_CANARY",
      "RAW_HEALTH_WARNING_CANARY",
      "RAW_HEALTH_ERROR_CANARY",
      "RAW_PROVIDER_WARNING_CANARY",
      "RAW_METRICS_CANARY",
      "subscriber@example.test",
      "bearer-private-token",
    ]) {
      expect(text()).not.toContain(canary);
    }

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("requests an explicit provider check exactly once while verification is in flight", async () => {
    const providerCheck = deferred<{ data: typeof HEALTH }>();
    mocks.connectionHealth.mockImplementation(
      (_connectionId: string, checkProvider: boolean) =>
        checkProvider
          ? providerCheck.promise
          : Promise.resolve({ data: HEALTH }),
    );
    renderControl();
    await waitForInitialEvidence();

    const verify = button("Verify provider");
    act(() => {
      verify.click();
      verify.click();
    });

    expect(
      mocks.connectionHealth.mock.calls.filter((call) => call[1] === true),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(button("Verifying provider…").getAttribute("aria-busy")).toBe(
        "true",
      );
    });

    providerCheck.resolve({ data: HEALTH });
    await waitFor(() => {
      expect(button("Verify provider")).not.toBeNull();
    });
    expect(
      mocks.connectionHealth.mock.calls.filter((call) => call[1] === true),
    ).toHaveLength(1);
  });

  it("rejects unknown server enum tokens instead of reflecting them", async () => {
    const canaries = {
      provider: "RAW_PROVIDER_TOKEN_CANARY",
      direction: "RAW_DIRECTION_TOKEN_CANARY",
      cadence: "RAW_CADENCE_TOKEN_CANARY",
      object: "RAW_OBJECT_TOKEN_CANARY",
      health: "RAW_HEALTH_TOKEN_CANARY",
      runtime: "RAW_RUNTIME_TOKEN_CANARY",
      driver: "RAW_DRIVER_TOKEN_CANARY",
      state: "RAW_STATE_TOKEN_CANARY",
      live: "RAW_LIVE_TOKEN_CANARY",
      mode: "RAW_MODE_TOKEN_CANARY",
      setting: "RAW_SETTING_TOKEN_CANARY",
      runStatus: "RAW_RUN_STATUS_CANARY",
      runMode: "RAW_RUN_MODE_CANARY",
    };
    mocks.connectionHealth.mockResolvedValue({
      data: {
        ...HEALTH,
        health: canaries.health,
        provider_runtime_status: canaries.runtime,
        provider_driver_attachment: canaries.driver,
        missing_required_settings: [canaries.setting],
        provider_health: {
          ...HEALTH.provider_health,
          state: canaries.state,
          live_state: canaries.live,
          execution_mode: canaries.mode,
          missing_required_settings: [canaries.setting],
        },
      },
    });
    mocks.listConnectionRuns.mockResolvedValue({
      data: {
        items: [
          {
            ...RECENT_RUN,
            status: canaries.runStatus,
            direction: canaries.direction,
            run_mode: canaries.runMode,
          },
        ],
      },
    });

    renderControl({
      connection: {
        ...CONNECTION,
        provider: canaries.provider,
        direction: canaries.direction,
        cadence: canaries.cadence,
        object_selection: [canaries.object],
      },
    });
    await waitFor(() => {
      expect(mocks.connectionHealth).toHaveBeenCalledWith(CONNECTION_ID, false);
      expect(mocks.listConnectionRuns).toHaveBeenCalledWith(CONNECTION_ID);
      expect(text()).toContain("Recent runs");
    });

    for (const canary of Object.values(canaries)) {
      expect(text()).not.toContain(canary);
    }
    expect(text()).toContain("Unverified");
    expect(text()).toContain("No verified objects");
  });

  it("refreshes connection health and recent runs together without a provider check", async () => {
    renderControl();
    await waitForInitialEvidence();
    const healthCalls = mocks.connectionHealth.mock.calls.length;
    const runCalls = mocks.listConnectionRuns.mock.calls.length;

    act(() => button("Refresh evidence").click());
    await waitFor(() => {
      expect(mocks.connectionHealth).toHaveBeenCalledTimes(healthCalls + 1);
      expect(mocks.listConnectionRuns).toHaveBeenCalledTimes(runCalls + 1);
    });

    expect(mocks.connectionHealth).toHaveBeenLastCalledWith(
      CONNECTION_ID,
      false,
    );
    expect(mocks.listConnectionRuns).toHaveBeenLastCalledWith(CONNECTION_ID);
  });

  it("keeps viewer lifecycle actions focusable but guarded with zero mutations", async () => {
    renderControl({ canAdmin: false });
    await waitForInitialEvidence();

    for (const action of [button("Pause"), button("Disconnect")]) {
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      act(() => action.click());
    }

    expect(text()).toContain(
      "Admin access is required to pause or disconnect this warehouse connection.",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.pauseConnection).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  it("pauses only after confirmation and reports the verified connection through the callback", async () => {
    const onConnectionChanged = vi.fn();
    const pausedConnection = { ...CONNECTION, status: "paused" };
    mocks.pauseConnection.mockResolvedValue({ data: pausedConnection });
    renderControl({ onConnectionChanged });
    await waitForInitialEvidence();

    act(() => button("Pause").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.pauseConnection).not.toHaveBeenCalled();
    act(() => button("Pause connection").click());

    await waitFor(() => {
      expect(mocks.getConnection).toHaveBeenCalledWith(CONNECTION_ID);
      expect(mocks.pauseConnection).toHaveBeenCalledWith(CONNECTION_ID, 5);
      expect(onConnectionChanged).toHaveBeenCalledWith(pausedConnection);
    });
    expect(onConnectionChanged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("publishes a successful pause before refresh and does not repeat it after unmount", async () => {
    const refresh = deferred<{ data: typeof HEALTH }>();
    const onConnectionChanged = vi.fn();
    const pausedConnection = { ...CONNECTION, status: "paused" };
    mocks.pauseConnection.mockResolvedValueOnce({ data: pausedConnection });
    renderControl({ onConnectionChanged });
    await waitForInitialEvidence();
    mocks.connectionHealth.mockReturnValueOnce(refresh.promise);

    act(() => button("Pause").click());
    act(() => button("Pause connection").click());
    await waitFor(() => {
      expect(onConnectionChanged).toHaveBeenCalledWith(pausedConnection);
      expect(mocks.connectionHealth).toHaveBeenCalledTimes(2);
    });
    expect(onConnectionChanged).toHaveBeenCalledTimes(1);

    const currentRoot = root;
    act(() => currentRoot?.unmount());
    root = null;
    refresh.resolve({ data: HEALTH });
    await settle();

    expect(onConnectionChanged).toHaveBeenCalledTimes(1);
  });

  it("requires the exact connection name before disconnecting and reports success once", async () => {
    const onDisconnected = vi.fn();
    renderControl({ onDisconnected });
    await waitForInitialEvidence();

    act(() => button("Disconnect").click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(button("Disconnect connection").disabled).toBe(true);
    typeConfirmation(CONNECTION_NAME);
    expect(button("Disconnect connection").disabled).toBe(false);
    act(() => button("Disconnect connection").click());

    await waitFor(() => {
      expect(mocks.getConnection).toHaveBeenCalledWith(CONNECTION_ID);
      expect(mocks.deleteConnection).toHaveBeenCalledWith(
        CONNECTION_ID,
        5,
        CONNECTION_NAME,
      );
      expect(onDisconnected).toHaveBeenCalledTimes(1);
    });
    expect(mocks.deleteConnection).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("classifies lifecycle API failures and exposes only a safe request reference", async () => {
    const rawFailure =
      "RAW_LIFECYCLE_ERROR_CANARY postgres://admin:secret@internal/private";
    mocks.pauseConnection.mockResolvedValue({
      error: {
        status: 503,
        code: "warehouse_provider_secret_failure",
        requestId: "req-safe-503",
        message: rawFailure,
      },
    });
    renderControl();
    await waitForInitialEvidence();

    act(() => button("Pause").click());
    act(() => button("Pause connection").click());
    await waitFor(() => {
      expect(text()).toContain(
        "Pause failed. The warehouse service could not complete the request.",
      );
    });

    expect(text()).toContain("Reference: req-safe-503.");
    expect(text()).not.toContain(rawFailure);
    expect(text()).not.toContain("postgres://");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
