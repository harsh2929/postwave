// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
}));

import {
  acknowledgeWarehouseProviderCleanup,
  disconnectWarehouseConnection,
  listStreamingRuns,
  listWarehouseConnections,
  listWarehouseRuns,
  pauseWarehouseConnection,
  putWarehouseMapping,
  type WarehouseAuthority,
  type WarehouseConnection,
} from "@/lib/warehouse-api";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MAPPING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const KEY = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = "2026-08-29T12:00:00Z";

const authority: WarehouseAuthority = {
  tenantId: TENANT,
  userId: USER,
  role: "admin",
};

function connection(
  patch: Partial<WarehouseConnection> = {},
): WarehouseConnection {
  return {
    id: CONNECTION,
    tenant_id: TENANT,
    name: "Production warehouse",
    provider: "snowflake",
    direction: "bidirectional",
    status: "active",
    credential_ref_present: true,
    config: { account: "org-account", database: "POSTWAVE" },
    object_selection: ["profiles", "events"],
    cadence: "daily",
    backfill_days: 30,
    issue_present: false,
    version: 3,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

function run(patch: Record<string, unknown> = {}) {
  return {
    id: RUN,
    tenant_id: TENANT,
    connection_id: CONNECTION,
    direction: "export",
    run_mode: "manual",
    status: "completed",
    object_selection: ["profiles"],
    rows_scanned: 10,
    rows_exported: 10,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 0,
    issue_present: false,
    started_at: NOW,
    completed_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("warehouse API security and concurrency contracts", () => {
  it("fails closed on top-level or nested credential echoes", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [connection({ config: { nested: { password: "raw-secret" } } })],
    });
    await expect(
      listWarehouseConnections({ tenantId: TENANT }),
    ).rejects.toThrow("credential material");

    mocks.get.mockResolvedValueOnce({
      items: [{ ...connection(), credentials_ref: "vault://private" }],
    });
    await expect(
      listWarehouseConnections({ tenantId: TENANT }),
    ).rejects.toThrow("sensitive warehouse field");
  });

  it("carries the exact version through a one-shot online pause", async () => {
    mocks.post.mockResolvedValueOnce(
      connection({ status: "paused", version: 4 }),
    );

    await pauseWarehouseConnection({
      authority,
      current: connection(),
      idempotencyKey: KEY,
    });

    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/warehouse/connections/${CONNECTION}/pause`,
      { expected_version: 3 },
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: KEY,
      }),
    );
  });

  it("requires an exact name and version receipt for disconnect", async () => {
    mocks.delete.mockResolvedValueOnce({
      ok: true,
      id: CONNECTION,
      previous_version: 3,
      version: 4,
      status: "disconnected",
    });
    const receipt = await disconnectWarehouseConnection({
      authority,
      current: connection(),
      idempotencyKey: KEY,
    });
    expect(receipt.version).toBe(4);
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/warehouse/connections/${CONNECTION}`,
      expect.objectContaining({
        body: {
          expected_version: 3,
          confirmation_name: "Production warehouse",
        },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("uses create-only mapping CAS and verifies the returned version", async () => {
    mocks.put.mockResolvedValueOnce({
      id: MAPPING,
      tenant_id: TENANT,
      connection_id: CONNECTION,
      source_object: "orders",
      target_event_name: "ordered",
      profile_key_column: "email",
      occurred_at_column: "occurred_at",
      property_map: {},
      validation_rules: {},
      status: "active",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    await putWarehouseMapping({
      authority,
      connection: connection(),
      sourceObject: "orders",
      mapping: {
        target_event_name: "ordered",
        profile_key_column: "email",
        occurred_at_column: "occurred_at",
        property_map: {},
        validation_rules: {},
        status: "active",
      },
      idempotencyKey: KEY,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/v1/warehouse/connections/${CONNECTION}/mappings/orders`,
      expect.objectContaining({ expected_version: 0 }),
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("rejects private run and streaming storage details", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [run({ output_uri: "https://signed.example/private" })],
    });
    await expect(listWarehouseRuns({ tenantId: TENANT })).rejects.toThrow(
      "private warehouse run detail",
    );

    mocks.get.mockResolvedValueOnce({
      items: [
        {
          id: RUN,
          connection_id: CONNECTION,
          status: "completed",
          format: "parquet",
          compression: "snappy",
          window_start: NOW,
          window_end: NOW,
          cursor_from: 0,
          cursor_to: 10,
          has_more: false,
          rows_shipped: 10,
          bytes_shipped: 100,
          issue_present: false,
          object_uri: "tenant/private/key",
          started_at: NOW,
          completed_at: NOW,
          created_at: NOW,
        },
      ],
      last_shipped_at: NOW,
    });
    await expect(
      listStreamingRuns({ tenantId: TENANT, connectionId: CONNECTION }),
    ).rejects.toThrow("private streaming storage");
  });

  it("verifies cleanup acknowledgements without accepting raw evidence", async () => {
    mocks.post.mockResolvedValueOnce({
      ok: true,
      id: CONNECTION,
      previous_version: 3,
      version: 4,
    });
    const receipt = await acknowledgeWarehouseProviderCleanup({
      authority,
      current: connection({ status: "disconnected" }),
      completedActions: ["provider_console_cleanup_reviewed_no_action_due"],
      notes: "Reviewed change ticket.",
      idempotencyKey: KEY,
    });
    expect(receipt).toEqual({
      ok: true,
      id: CONNECTION,
      previous_version: 3,
      version: 4,
    });
  });
});
