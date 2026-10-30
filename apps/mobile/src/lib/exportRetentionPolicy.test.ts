import { describe, expect, it } from "vitest";

import {
  exportRetentionDirty,
  exportRetentionDraft,
  exportRetentionPatch,
  exportRetentionSaveError,
  exportRetentionSummary,
  isExportRetentionPolicy,
  normalizeExportRetentionPolicy,
  parseExportRetentionField,
} from "@/lib/exportRetentionPolicy";

const POLICY = {
  retentionDays: 30,
  maxPerTenant: 20,
  currentStorageBytes: 2048,
  updatedAt: "2026-08-01T10:00:00Z",
};

describe("normalizeExportRetentionPolicy", () => {
  it("reads the handler's snake_case row", () => {
    expect(
      normalizeExportRetentionPolicy({
        retention_days: 30,
        max_per_tenant: 20,
        current_storage_bytes: 2048,
        updated_at: "2026-08-01T10:00:00Z",
      }),
    ).toEqual(POLICY);
  });

  it("returns null when either governing number is missing, and never a negative byte count", () => {
    expect(normalizeExportRetentionPolicy({ retention_days: 30 })).toBeNull();
    expect(normalizeExportRetentionPolicy(null)).toBeNull();
    expect(
      normalizeExportRetentionPolicy({
        retention_days: 7,
        max_per_tenant: 1,
        current_storage_bytes: -5,
      }),
    ).toEqual({
      retentionDays: 7,
      maxPerTenant: 1,
      currentStorageBytes: 0,
      updatedAt: "",
    });
  });
});

describe("isExportRetentionPolicy", () => {
  it("accepts a normalized policy and rejects every other shape", () => {
    expect(isExportRetentionPolicy(POLICY)).toBe(true);
    expect(isExportRetentionPolicy({ ...POLICY, updatedAt: "" })).toBe(true);
    expect(isExportRetentionPolicy(null)).toBe(false);
    expect(isExportRetentionPolicy([POLICY])).toBe(false);
    expect(isExportRetentionPolicy({ items: [] })).toBe(false);
    expect(isExportRetentionPolicy({ retention_days: 30, max_per_tenant: 20 })).toBe(false);
    expect(isExportRetentionPolicy({ ...POLICY, retentionDays: "30" })).toBe(false);
  });
});

describe("parseExportRetentionField", () => {
  it("enforces the handler's bounds and ignores non-digits", () => {
    expect(parseExportRetentionField("30", "retentionDays")).toBe(30);
    expect(parseExportRetentionField("6", "retentionDays")).toBeNull();
    expect(parseExportRetentionField("2556", "retentionDays")).toBeNull();
    expect(parseExportRetentionField("2555", "retentionDays")).toBe(2555);
    expect(parseExportRetentionField("0", "maxPerTenant")).toBeNull();
    expect(parseExportRetentionField("501", "maxPerTenant")).toBeNull();
    expect(parseExportRetentionField("5 0", "maxPerTenant")).toBe(50);
    expect(parseExportRetentionField("", "maxPerTenant")).toBeNull();
  });
});

describe("exportRetentionPatch / exportRetentionDirty", () => {
  it("sends only the fields that changed", () => {
    expect(
      exportRetentionPatch(POLICY, { retentionDays: "45", maxPerTenant: "20" }),
    ).toEqual({ ok: true, body: { retention_days: 45 } });
    expect(
      exportRetentionPatch(POLICY, { retentionDays: "30", maxPerTenant: "5" }),
    ).toEqual({ ok: true, body: { max_per_tenant: 5 } });
  });

  it("yields an empty body for an unchanged draft, which is not dirty", () => {
    const draft = exportRetentionDraft(POLICY);
    expect(exportRetentionPatch(POLICY, draft)).toEqual({ ok: true, body: {} });
    expect(exportRetentionDirty(POLICY, draft)).toBe(false);
    expect(
      exportRetentionDirty(POLICY, { retentionDays: "31", maxPerTenant: "20" }),
    ).toBe(true);
  });

  it("refuses an out-of-range draft with the bounds spelled out", () => {
    const result = exportRetentionPatch(POLICY, {
      retentionDays: "3",
      maxPerTenant: "20",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/7-2555 days/);
    // Unparseable counts as dirty so the Save button explains rather than
    // silently doing nothing.
    expect(
      exportRetentionDirty(POLICY, { retentionDays: "", maxPerTenant: "20" }),
    ).toBe(true);
  });
});

describe("exportRetentionSummary", () => {
  it("states the server's numbers and the stored size", () => {
    expect(exportRetentionSummary(POLICY)).toBe(
      "New bundles are kept 30 days after completion, up to 20 active exports. 2 KB stored now.",
    );
    expect(
      exportRetentionSummary({ ...POLICY, retentionDays: 1, maxPerTenant: 1 }),
    ).toMatch(/kept 1 day after completion, up to 1 active export\./);
  });
});

describe("exportRetentionSaveError", () => {
  it("repeats a capacity-conflict or out-of-range sentence verbatim", () => {
    const conflict =
      "cannot lower max_per_tenant to 2 while 4 export jobs are queued, running, or ready";
    expect(
      exportRetentionSaveError({
        status: 409,
        code: "export_capacity_conflict",
        message: conflict,
      }),
    ).toBe(conflict);
    expect(
      exportRetentionSaveError({
        status: 400,
        code: "out_of_range",
        message: "retention_days must be between 7 and 2555",
      }),
    ).toBe("retention_days must be between 7 and 2555");
  });

  it("names the role floor on a 403 and falls back when the server is silent", () => {
    expect(exportRetentionSaveError({ status: 403, message: "x" })).toMatch(
      /workspace admins/,
    );
    expect(exportRetentionSaveError({ status: 0, message: "" })).toBe(
      "Couldn't save the export retention policy.",
    );
  });
});
