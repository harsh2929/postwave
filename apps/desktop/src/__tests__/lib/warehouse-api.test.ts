import { describe, expect, it } from "vitest";

import { createWarehouseApis } from "../../lib/api/warehouse";
import type { ApiResult } from "../../lib/api/result";

type WarehouseRequester = Parameters<typeof createWarehouseApis>[0];
type WarehouseRequestOptions = Parameters<WarehouseRequester>[2];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: WarehouseRequestOptions;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: WarehouseRequester;
} {
  const calls: RequestCall[] = [];
  const request: WarehouseRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: WarehouseRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const WRITEBACK_OPERATIONS = [
  "providers",
  "listTargets",
  "createTarget",
  "runTarget",
  "pauseTarget",
  "disconnectTarget",
  "listRuns",
] as const;

const WAREHOUSE_OPERATIONS = [
  "catalog",
  "providers",
  "validate",
  "listConnections",
  "createConnection",
  "getConnection",
  "connectionHealth",
  "pauseConnection",
  "deleteConnection",
  "acknowledgeProviderCleanup",
  "listMappings",
  "putMapping",
  "runConnection",
  "runDue",
  "listRuns",
  "listConnectionRuns",
  "getRun",
  "listRunErrors",
  "validateStreaming",
  "listStreamingRuns",
  "shipStreaming",
  "listReverseETLMappings",
  "createReverseETLMapping",
  "deleteReverseETLMapping",
  "syncReverseETL",
] as const;

describe("createWarehouseApis", () => {
  it("retains the complete writeback and warehouse operation inventories", () => {
    const { request } = recordingRequester();
    const apis = createWarehouseApis(request);

    expect(Object.keys(apis.writebackApi)).toEqual(WRITEBACK_OPERATIONS);
    expect(Object.keys(apis.warehouseApi)).toEqual(WAREHOUSE_OPERATIONS);
  });

  it("preserves encoded writeback and warehouse mutation contracts", async () => {
    const { calls, request } = recordingRequester();
    const { writebackApi, warehouseApi } = createWarehouseApis(request);

    await writebackApi.runTarget("target/one");
    await writebackApi.listRuns("target/one", 12);
    await warehouseApi.acknowledgeProviderCleanup("connection/one", {
      expected_version: 7,
      completed_actions: ["revoked_key"],
      notes: "Completed by operator",
    });
    await warehouseApi.putMapping("connection/one", "orders/paid", {
      target_event_name: "order_paid",
    });
    await warehouseApi.connectionHealth("connection/one", true);

    expect(calls).toEqual([
      {
        path: "/api/v1/integration-writeback/targets/target%2Fone/run",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integration-writeback/targets/target%2Fone/runs?limit=12",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/provider-cleanup/acknowledge",
        init: {
          method: "POST",
          body: JSON.stringify({
            expected_version: 7,
            completed_actions: ["revoked_key"],
            notes: "Completed by operator",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/mappings/orders%2Fpaid",
        init: {
          method: "PUT",
          body: JSON.stringify({ target_event_name: "order_paid" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/health?provider_check=true",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("keeps every long-running data movement operation single-attempt and online-only", async () => {
    const { calls, request } = recordingRequester();
    const { warehouseApi } = createWarehouseApis(request);
    const policy = {
      timeoutMs: 60_000,
      maxAttempts: 1,
      requireOnline: true,
    };

    await warehouseApi.runConnection("connection/one", 7, {
      mode: "backfill",
    });
    await warehouseApi.runDue(8);
    await warehouseApi.shipStreaming("connection/one", 7);
    await warehouseApi.syncReverseETL("connection/one", {
      expected_connection_version: 7,
      rows: [{ email: "reader@example.test", plan: "pro" }],
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/runs",
        init: {
          method: "POST",
          body: JSON.stringify({
            mode: "backfill",
            expected_connection_version: 7,
          }),
        },
        opts: policy,
      },
      {
        path: "/api/v1/warehouse/runs/due?limit=8",
        init: { method: "POST", body: "{}" },
        opts: policy,
      },
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/streaming/ship",
        init: {
          method: "POST",
          body: JSON.stringify({ expected_connection_version: 7 }),
        },
        opts: policy,
      },
      {
        path: "/api/v1/warehouse/connections/connection%2Fone/reverse-etl-sync",
        init: {
          method: "POST",
          body: JSON.stringify({
            expected_connection_version: 7,
            rows: [{ email: "reader@example.test", plan: "pro" }],
          }),
        },
        opts: policy,
      },
    ]);
  });
});
