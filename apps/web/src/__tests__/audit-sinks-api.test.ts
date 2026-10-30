// SPDX-License-Identifier: AGPL-3.0-only
//
// SETA-056: the audit-sinks + export-schedules client hits the right method/URL,
// encodes ids, and unwraps the {sinks}/{schedules} envelopes.

import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPatch, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: apiGet,
      post: apiPost,
      patch: apiPatch,
      delete: apiDelete,
    },
  };
});

import {
  createAuditSink,
  createExportSchedule,
  deleteAuditSink,
  deleteExportSchedule,
  listAuditSinks,
  listExportSchedules,
  patchAuditSink,
  testAuditSinkPreflight,
} from "@/lib/audit-sinks-api";

afterEach(() => vi.clearAllMocks());

const WRITE_OPTIONS = { requireOnline: true, maxAttempts: 1 };

describe("audit-sinks-api", () => {
  it("lists sinks and passes the {sinks} envelope through", async () => {
    apiGet.mockResolvedValue({
      sinks: [
        {
          id: "sk_1",
          kind: "s3",
          name: "Archive",
          enabled: true,
          config: {},
          output_format: "postwave_native",
          webhook_format: "postwave_v1",
          consecutive_failures: 0,
          auto_disable_after: 100,
          circuit_state: "closed",
          last_error: "Authorization: Bearer must-not-survive",
        },
      ],
    });
    const res = await listAuditSinks();
    expect(apiGet).toHaveBeenCalledWith("/api/v1/audit-sinks", {});
    expect(res.sinks).toHaveLength(1);
    expect(res.sinks[0]).toMatchObject({ has_last_error: true });
    expect(JSON.stringify(res.sinks[0])).not.toContain("must-not-survive");
  });

  it("creates a sink with the enum kind + config + string-map credentials", async () => {
    apiPost.mockResolvedValue({
      id: "sk_2",
      kind: "s3",
      name: "Prod",
      enabled: true,
      output_format: "postwave_native",
      webhook_format: "postwave_v1",
    });
    await createAuditSink({
      kind: "s3",
      name: "Prod",
      config: { bucket: "b", region: "us-east-1" },
      credentials: { aws_access_key_id: "k", aws_secret_access_key: "s" },
    });
    expect(apiPost).toHaveBeenCalledWith(
      "/api/v1/audit-sinks",
      {
        kind: "s3",
        name: "Prod",
        config: { bucket: "b", region: "us-east-1" },
        credentials: { aws_access_key_id: "k", aws_secret_access_key: "s" },
      },
      WRITE_OPTIONS,
    );
  });

  it("preflights a draft online and verifies the exact canary receipt", async () => {
    const input = { kind: "datadog" as const, name: "SIEM" };
    apiPost.mockResolvedValue({
      delivered: true,
      kind: "datadog",
      action: "audit_sink.test",
    });
    await expect(testAuditSinkPreflight(input)).resolves.toEqual({
      delivered: true,
      kind: "datadog",
      action: "audit_sink.test",
    });
    expect(apiPost).toHaveBeenCalledWith("/api/v1/audit-sinks/test", input, {
      ...WRITE_OPTIONS,
      idempotencyKey: null,
    });
  });

  it("patches a sink and URL-encodes the id", async () => {
    apiPatch.mockResolvedValue({ id: "id/1", enabled: false });
    await patchAuditSink("id/1", { enabled: false });
    expect(apiPatch).toHaveBeenCalledWith(
      "/api/v1/audit-sinks/id%2F1",
      { enabled: false },
      WRITE_OPTIONS,
    );
  });

  it("deletes a sink", async () => {
    apiDelete.mockResolvedValue({ deleted: true });
    await deleteAuditSink("sk_3");
    expect(apiDelete).toHaveBeenCalledWith(
      "/api/v1/audit-sinks/sk_3",
      WRITE_OPTIONS,
    );
  });

  it("lists schedules and passes the {schedules} envelope through", async () => {
    apiGet.mockResolvedValue({ schedules: [{ id: "sc_1" }] });
    const res = await listExportSchedules();
    expect(apiGet).toHaveBeenCalledWith("/api/v1/audit/export-schedules", {});
    expect(res.schedules).toHaveLength(1);
  });

  it("creates a schedule", async () => {
    apiPost.mockResolvedValue({
      id: "sc_2",
      cadence: "weekly",
      recipients: ["a@b.com"],
      enabled: true,
      created_at: "2026-08-29T10:00:00Z",
    });
    await createExportSchedule({
      cadence: "weekly",
      recipients: ["a@b.com"],
    });
    expect(apiPost).toHaveBeenCalledWith(
      "/api/v1/audit/export-schedules",
      { cadence: "weekly", recipients: ["a@b.com"] },
      WRITE_OPTIONS,
    );
  });

  it("deletes a schedule with an encoded id", async () => {
    apiDelete.mockResolvedValue({ deleted: true });
    await deleteExportSchedule("sc/9");
    expect(apiDelete).toHaveBeenCalledWith(
      "/api/v1/audit/export-schedules/sc%2F9",
      WRITE_OPTIONS,
    );
  });
});
