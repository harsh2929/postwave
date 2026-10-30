// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMocks,
}));

import { ApiError } from "@/lib/api";
import {
  AutomationConfigurationContractError,
  AutomationConfigurationInputError,
  createZeroCopyDraft,
  getTriggerDelayPreference,
  listZeroCopyDrafts,
  normalizeZeroCopyDraftInput,
  putTriggerDelayPreference,
  validateZeroCopyDraft,
} from "@/lib/automation-configuration-api";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000002";
const SUBSCRIBER_ID = "00000000-0000-4000-8000-000000000003";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000004";

const runtime = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Execution is release-held.",
  prerequisites: ["release_certification"],
};

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIGGER_ID,
    tenant_id: TENANT_ID,
    connection_id: CONNECTION_ID,
    name: "Warehouse draft",
    description: "Inert configuration",
    status: "draft",
    provider: "snowflake",
    query: "SELECT email, updated_at FROM audience",
    cursor_column: "updated_at",
    profile_key_column: "email",
    last_seen_cursor: "private-cursor",
    polling_interval_seconds: 300,
    max_rows_per_tick: 500,
    consecutive_failures: 0,
    rows_fired_total: 0,
    config: { database: "ANALYTICS" },
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-30T10:00:00Z",
    runtime,
    ...overrides,
  };
}

const draftInput = {
  connection_id: CONNECTION_ID,
  name: "Warehouse draft",
  description: "Inert configuration",
  status: "draft" as const,
  provider: "snowflake" as const,
  query: "SELECT email, updated_at FROM audience",
  cursor_column: "updated_at",
  profile_key_column: "email",
  polling_interval_seconds: 300,
  max_rows_per_tick: 500,
  config: { database: "ANALYTICS" },
};

function delay(overrides: Record<string, unknown> = {}) {
  return {
    subscriber_id: SUBSCRIBER_ID,
    event_name: "order.created",
    optimal_delay_seconds: 900,
    sample_count: 0,
    confidence: 0,
    reason: "Operator-approved delay",
    computed_at: "2026-08-30T09:00:00Z",
    updated_at: "2026-08-30T09:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("automation configuration contracts", () => {
  it("lists bounded, tenant-bound trigger pages with an abort signal", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({
      items: [trigger()],
      nextCursor: "opaque-next",
    });

    await expect(
      listZeroCopyDrafts({
        tenantId: TENANT_ID,
        status: "draft",
        cursor: "opaque-start",
        signal,
      }),
    ).resolves.toMatchObject({
      items: [{ id: TRIGGER_ID, name: "Warehouse draft" }],
      nextCursor: "opaque-next",
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/zero-copy-triggers",
      {
        query: { limit: 100, status: "draft", cursor: "opaque-start" },
        signal,
      },
    );
  });

  it("rejects tenant bleed, duplicate rows, unsafe config, and dead-end pages", async () => {
    apiMocks.get.mockResolvedValueOnce({
      items: [trigger({ tenant_id: "00000000-0000-4000-8000-000000000099" })],
    });
    await expect(
      listZeroCopyDrafts({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/another workspace/i);

    apiMocks.get.mockResolvedValueOnce({ items: [trigger(), trigger()] });
    await expect(
      listZeroCopyDrafts({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/duplicate/i);

    apiMocks.get.mockResolvedValueOnce({
      items: [trigger({ config: { constructor: "unsafe" } })],
    });
    await expect(
      listZeroCopyDrafts({ tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(AutomationConfigurationContractError);

    apiMocks.get.mockResolvedValueOnce({ items: [], nextCursor: "more" });
    await expect(
      listZeroCopyDrafts({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/cannot advance/i);
  });

  it("allows only inert draft/paused input and validates as an online read-only POST", async () => {
    expect(() =>
      normalizeZeroCopyDraftInput({
        ...draftInput,
        status: "active" as never,
      }),
    ).toThrow(AutomationConfigurationInputError);
    expect(apiMocks.post).not.toHaveBeenCalled();

    const signal = new AbortController().signal;
    apiMocks.post.mockResolvedValueOnce({
      valid: true,
      warnings: ["Draft validation does not poll the warehouse."],
      runtime,
    });
    await expect(validateZeroCopyDraft(draftInput, signal)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/zero-copy-triggers/validate",
      draftInput,
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: null,
        signal,
      }),
    );
  });

  it("uses explicit online-only idempotency and verifies create tenant identity", async () => {
    await expect(
      createZeroCopyDraft({
        tenantId: TENANT_ID,
        value: draftInput,
        idempotencyKey: "unsafe\noperation",
      }),
    ).rejects.toBeInstanceOf(AutomationConfigurationInputError);
    expect(apiMocks.post).not.toHaveBeenCalled();

    apiMocks.post.mockResolvedValueOnce(trigger());
    await expect(
      createZeroCopyDraft({
        tenantId: TENANT_ID,
        value: draftInput,
        idempotencyKey: "draft-create-operation",
      }),
    ).resolves.toMatchObject({ id: TRIGGER_ID, status: "draft" });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/zero-copy-triggers",
      draftInput,
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "draft-create-operation",
      }),
    );
  });

  it("treats 404 delay lookup as verified absence and withholds learned timing", async () => {
    apiMocks.get.mockRejectedValueOnce(
      new ApiError("Preference not found", 404),
    );
    await expect(
      getTriggerDelayPreference({
        subscriberId: SUBSCRIBER_ID,
        eventName: "Order.Created",
      }),
    ).resolves.toBeNull();

    apiMocks.get.mockResolvedValueOnce(
      delay({ sample_count: 42, confidence: 0.8 }),
    );
    await expect(
      getTriggerDelayPreference({
        subscriberId: SUBSCRIBER_ID,
        eventName: "Order.Created",
      }),
    ).resolves.toEqual({
      kind: "learned-held",
      subscriberId: SUBSCRIBER_ID,
      eventName: "order.created",
      updatedAt: "2026-08-30T09:00:00Z",
    });
  });

  it("accepts only an exact manual timing receipt", async () => {
    apiMocks.put.mockResolvedValueOnce(delay());
    await expect(
      putTriggerDelayPreference({
        subscriberId: SUBSCRIBER_ID,
        eventName: "order.created",
        optimalDelaySeconds: 900,
        reason: "Operator-approved delay",
        idempotencyKey: "manual-delay-operation",
      }),
    ).resolves.toMatchObject({ kind: "manual", optimalDelaySeconds: 900 });

    apiMocks.put.mockResolvedValueOnce(delay({ optimal_delay_seconds: 901 }));
    await expect(
      putTriggerDelayPreference({
        subscriberId: SUBSCRIBER_ID,
        eventName: "order.created",
        optimalDelaySeconds: 900,
        reason: "Operator-approved delay",
        idempotencyKey: "manual-delay-operation-2",
      }),
    ).rejects.toThrow(/did not match/i);
  });
});
