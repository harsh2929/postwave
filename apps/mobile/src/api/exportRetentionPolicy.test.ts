/** Transport seam for the export retention policy. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getExportRetentionPolicy,
  patchExportRetentionPolicy,
} from "./exportRetentionPolicy";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("getExportRetentionPolicy", () => {
  it("GETs the policy route and normalizes the row", async () => {
    rawRequest.mockResolvedValue({
      data: { retention_days: 30, max_per_tenant: 20, current_storage_bytes: 10 },
      error: null,
    });
    const res = await getExportRetentionPolicy();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/exports/retention-policy",
    );
    expect(res.data).toEqual({
      retentionDays: 30,
      maxPerTenant: 20,
      currentStorageBytes: 10,
      updatedAt: "",
    });
  });

  it("passes the error envelope through", async () => {
    const error = { status: 403, message: "forbidden" };
    rawRequest.mockResolvedValue({ data: null, error });
    expect(await getExportRetentionPolicy()).toEqual({ data: null, error });
  });
});

describe("patchExportRetentionPolicy", () => {
  it("PATCHes only the fields it was given", async () => {
    rawRequest.mockResolvedValue({
      data: { retention_days: 45, max_per_tenant: 20, current_storage_bytes: 0 },
      error: null,
    });
    const res = await patchExportRetentionPolicy({ retention_days: 45 });
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/exports/retention-policy",
      { retention_days: 45 },
    );
    expect(res.data?.retentionDays).toBe(45);
  });

  it("keeps a capacity conflict readable for the row", async () => {
    const error = {
      status: 409,
      code: "export_capacity_conflict",
      message: "cannot lower max_per_tenant to 1 while 3 export jobs are queued, running, or ready",
    };
    rawRequest.mockResolvedValue({ data: null, error });
    expect(await patchExportRetentionPolicy({ max_per_tenant: 1 })).toEqual({
      data: null,
      error,
    });
  });
});
