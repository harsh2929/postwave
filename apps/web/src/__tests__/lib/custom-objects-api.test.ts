// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

import { ApiError } from "@/lib/api";
import {
  createCustomObjectType,
  customObjectViolations,
  deleteCustomObjectRecord,
  deleteCustomObjectType,
  listCustomObjectRecords,
  listCustomObjectTypes,
  searchCustomObjectRecords,
  updateCustomObjectType,
  upsertCustomObjectRecord,
  type CustomObjectAdminAuthority,
  type CustomObjectRecord,
  type CustomObjectType,
} from "@/lib/custom-objects-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TYPE = "33333333-3333-4333-8333-333333333333";
const RECORD = "44444444-4444-4444-8444-444444444444";
const CREATED = "2026-08-29T09:00:00Z";
const UPDATED = "2026-08-29T10:00:00Z";

const authority: CustomObjectAdminAuthority = {
  tenantId: TENANT,
  userId: USER,
  role: "admin",
};

function objectType(
  override: Partial<CustomObjectType> = {},
): CustomObjectType {
  return {
    id: TYPE,
    tenantId: TENANT,
    key: "support_ticket",
    label: "Support ticket",
    primaryKey: "external_id",
    schema: {
      type: "object",
      properties: { priority: { type: "string" } },
    },
    status: "active",
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...override,
  };
}

function record(
  override: Partial<CustomObjectRecord> = {},
): CustomObjectRecord {
  return {
    id: RECORD,
    tenantId: TENANT,
    objectTypeId: TYPE,
    externalId: "ticket-42",
    properties: { priority: "high", subject: "Printer" },
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...override,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("custom-object read contracts", () => {
  it("accepts only exact, tenant-bound, unique type rows", async () => {
    mocks.get.mockResolvedValueOnce({ items: [objectType()] });
    await expect(listCustomObjectTypes({ tenantId: TENANT })).resolves.toEqual([
      expect.objectContaining({ id: TYPE, key: "support_ticket", version: 1 }),
    ]);

    for (const malformed of [
      { items: [{ ...objectType(), extra: true }] },
      { items: [objectType({ tenantId: USER })] },
      { items: [objectType(), objectType()] },
      { items: [objectType({ id: "object_type_1" })] },
      { items: [objectType({ version: 0 })] },
      { items: [objectType({ createdAt: "2026-02-31T09:00:00Z" })] },
    ]) {
      mocks.get.mockResolvedValueOnce(malformed);
      await expect(listCustomObjectTypes({ tenantId: TENANT })).rejects.toThrow(
        /invalid|another workspace|duplicate|version|canonical UUID|timestamp/iu,
      );
    }
  });

  it("requires exact record-page geometry and identity", async () => {
    mocks.get.mockResolvedValueOnce({
      items: [record()],
      limit: 25,
      hasMore: false,
    });
    await expect(
      listCustomObjectRecords({ tenantId: TENANT, typeId: TYPE, limit: 25 }),
    ).resolves.toMatchObject({
      limit: 25,
      hasMore: false,
      items: [{ id: RECORD }],
    });
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/custom-objects/types/${TYPE}/records?limit=25`,
      { signal: undefined },
    );

    for (const malformed of [
      { items: [record()], limit: 100, hasMore: false },
      { items: [record(), record()], limit: 25, hasMore: false },
      { items: [record({ objectTypeId: USER })], limit: 25, hasMore: false },
      { items: [record()], limit: 25, hasMore: "false" },
    ]) {
      mocks.get.mockResolvedValueOnce(malformed);
      await expect(
        listCustomObjectRecords({ tenantId: TENANT, typeId: TYPE, limit: 25 }),
      ).rejects.toThrow(/shape|duplicate|identity/iu);
    }
  });

  it("keeps exact filter values out of the URL and query cache contract", async () => {
    mocks.post.mockResolvedValueOnce({
      items: [record()],
      limit: 50,
      hasMore: false,
    });
    await searchCustomObjectRecords({
      tenantId: TENANT,
      typeId: TYPE,
      property: "customer_ref",
      value: "private@example.test",
      limit: 50,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/custom-objects/types/${TYPE}/records/search`,
      {
        property: "customer_ref",
        value: "private@example.test",
        limit: 50,
      },
      {
        signal: undefined,
        requireOnline: true,
        idempotencyKey: null,
      },
    );
    expect(mocks.post.mock.calls[0]?.[0]).not.toContain("private@example.test");
  });
});

describe("custom-object mutation receipts", () => {
  it("verifies create intent semantically when JSON key order changes", async () => {
    mocks.post.mockResolvedValueOnce(
      objectType({
        schema: {
          properties: { priority: { type: "string" } },
          type: "object",
        },
      }),
    );
    await expect(
      createCustomObjectType({
        authority,
        key: "support_ticket",
        label: "Support ticket",
        primaryKey: "external_id",
        schema: {
          type: "object",
          properties: { priority: { type: "string" } },
        },
        idempotencyKey: "custom-object:create:1",
      }),
    ).resolves.toMatchObject({ id: TYPE, version: 1 });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/custom-objects/types",
      expect.objectContaining({ key: "support_ticket" }),
      expect.objectContaining({
        requireOnline: true,
        idempotencyKey: "custom-object:create:1",
      }),
    );
  });

  it("binds type updates and deletes to the exact loaded version", async () => {
    const current = objectType({ version: 7 });
    mocks.put.mockResolvedValueOnce(
      objectType({ label: "Ticket", status: "deprecated", version: 8 }),
    );
    await updateCustomObjectType({
      authority,
      current,
      label: "Ticket",
      schema: current.schema,
      status: "deprecated",
      idempotencyKey: "custom-object:update:7",
    });
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/v1/custom-objects/types/${TYPE}`,
      {
        label: "Ticket",
        schema: expect.any(Object),
        status: "deprecated",
        expectedVersion: 7,
      },
      expect.objectContaining({ requireOnline: true }),
    );

    mocks.delete.mockResolvedValueOnce({
      deleted: true,
      id: TYPE,
      expectedVersion: 7,
    });
    await deleteCustomObjectType({
      authority,
      current,
      confirmationKey: "support_ticket",
      idempotencyKey: "custom-object:delete:7",
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/custom-objects/types/${TYPE}`,
      expect.objectContaining({
        body: {
          expectedVersion: 7,
          confirmationKey: "support_ticket",
        },
        requireOnline: true,
      }),
    );
  });

  it("uses create-only version zero and exact CAS for record writes/deletes", async () => {
    mocks.post.mockResolvedValueOnce(record());
    await upsertCustomObjectRecord({
      authority,
      typeId: TYPE,
      externalId: "ticket-42",
      properties: { subject: "Printer", priority: "high" },
      idempotencyKey: "record:create:1",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/custom-objects/types/${TYPE}/records`,
      expect.objectContaining({ expectedVersion: 0 }),
      expect.objectContaining({ requireOnline: true }),
    );

    const current = record({ version: 4 });
    mocks.post.mockResolvedValueOnce(
      record({ properties: { priority: "low" }, version: 5 }),
    );
    await upsertCustomObjectRecord({
      authority,
      typeId: TYPE,
      current,
      externalId: current.externalId,
      properties: { priority: "low" },
      idempotencyKey: "record:update:4",
    });
    expect(mocks.post.mock.calls[1]?.[1]).toMatchObject({ expectedVersion: 4 });

    mocks.delete.mockResolvedValueOnce({
      deleted: true,
      id: RECORD,
      expectedVersion: 4,
    });
    await deleteCustomObjectRecord({
      authority,
      current,
      confirmationExternalId: "ticket-42",
      idempotencyKey: "record:delete:4",
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/custom-objects/records/${RECORD}`,
      expect.objectContaining({
        body: {
          expectedVersion: 4,
          confirmationExternalId: "ticket-42",
        },
      }),
    );
  });

  it("fails closed on receipt drift and unsafe inputs before transport", async () => {
    mocks.post.mockResolvedValueOnce(objectType({ version: 2 }));
    await expect(
      createCustomObjectType({
        authority,
        key: "support_ticket",
        label: "Support ticket",
        primaryKey: "external_id",
        schema: {},
        idempotencyKey: "create:drift",
      }),
    ).rejects.toThrow(/receipt/iu);

    vi.clearAllMocks();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      createCustomObjectType({
        authority,
        key: "Not Safe",
        label: "Label",
        primaryKey: "external_id",
        schema: circular,
        idempotencyKey: "create:unsafe",
      }),
    ).rejects.toThrow(/type key/iu);
    await expect(
      listCustomObjectRecords({ tenantId: TENANT, typeId: TYPE, limit: 501 }),
    ).rejects.toThrow(/1 to 500/iu);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe("custom-object validation disclosure", () => {
  it("maps only bounded, safe field paths and messages", () => {
    const error = new ApiError("invalid", 422, {
      error: {
        code: "validation_failed",
        fields: [
          {
            field: "priority",
            code: "enum_violation",
            message: "must equal secret-internal-value",
          },
          {
            field: "<script>private@example.test</script>",
            code: "unknown_server_rule",
            message: "private@example.test",
          },
        ],
      },
    });
    const violations = customObjectViolations(error);
    expect(violations).toEqual([
      {
        field: "priority",
        code: "enum_violation",
        message: "Choose one of the values allowed by this field.",
      },
      {
        field: "Record",
        code: "schema_violation",
        message: "This field did not satisfy the saved schema.",
      },
    ]);
    expect(JSON.stringify(violations)).not.toContain("private@example.test");
    expect(JSON.stringify(violations)).not.toContain("secret-internal-value");
  });
});
