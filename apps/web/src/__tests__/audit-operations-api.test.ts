// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  createAuditExportJob,
  createAuditSinkReplayJob,
  getAuditAuthority,
  getAuditInclusionProof,
  listAuditAlertRules,
  listAuditExportManifests,
  listAuditExportJobs,
  listAuditSinkDLQ,
  listAuditSinkReplayJobs,
  replayAuditSinkDLQEntry,
  replayAuditSinkDLQBulk,
  rotateAuditSinkSigningKey,
  setRecoverySinkEnabled,
  verifyAuditAlertChannel,
} from "@/lib/audit-operations-api";

const WRITE_OPTIONS = { requireOnline: true, maxAttempts: 1 };

afterEach(() => vi.clearAllMocks());

describe("audit-operations-api trust boundaries", () => {
  it("accepts a consistent authority receipt and rejects invented audit authority", async () => {
    mocks.get.mockResolvedValueOnce({
      scopes: ["audit:read", "audit:configure_sinks"],
      auditScopes: ["audit:read", "audit:configure_sinks"],
      isAdmin: true,
    });
    await expect(getAuditAuthority()).resolves.toEqual({
      scopes: ["audit:read", "audit:configure_sinks"],
      auditScopes: ["audit:read", "audit:configure_sinks"],
      isAdmin: true,
    });

    mocks.get.mockResolvedValueOnce({
      scopes: ["audit:read"],
      auditScopes: ["audit:read", "audit:execute_actions"],
      isAdmin: "true",
    });
    await expect(getAuditAuthority()).rejects.toThrow(
      /invalid audit-authority/i,
    );
  });

  it("drops alert credentials and provider errors from decoded rule inventory", async () => {
    mocks.get.mockResolvedValue({
      rules: [
        {
          id: "rule-1",
          name: "Deletes",
          enabled: true,
          action_glob: "subscriber.delete*",
          operator_kind: "glob",
          operator_config: {},
          channel_kind: "pagerduty",
          channel_config: { routing_key: "must-never-survive" },
          notify_slack: false,
          fired_count: 2,
          last_error: "provider echoed must-never-survive",
          created_at: "2026-08-29T10:00:00Z",
        },
      ],
    });

    const [rule] = await listAuditAlertRules();
    expect(rule).toMatchObject({
      id: "rule-1",
      channelKind: "pagerduty",
      hasDeliveryError: true,
    });
    expect(JSON.stringify(rule)).not.toContain("must-never-survive");
    expect(rule).not.toHaveProperty("channelConfig");
  });

  it("decodes DLQ inventory without retaining raw upstream error text", async () => {
    mocks.get.mockResolvedValue({
      count: 1,
      entries: [
        {
          id: 7,
          sink_id: "sink-1",
          from_audit_id: 10,
          to_audit_id: 12,
          last_error: "Authorization: Bearer leaked-token",
          attempt_count: 3,
          first_failed_at: "2026-08-29T10:00:00Z",
          last_attempt_at: "2026-08-29T10:01:00Z",
        },
      ],
    });
    const [entry] = await listAuditSinkDLQ();
    expect(entry).toMatchObject({
      id: 7,
      sinkId: "sink-1",
      fromAuditId: 10,
      toAuditId: 12,
      hasLastError: true,
    });
    expect(JSON.stringify(entry)).not.toContain("leaked-token");
  });

  it("makes sink state and rotation writes online-only and verifies exact receipts", async () => {
    mocks.patch.mockResolvedValue({ id: "sink/1", enabled: false });
    await setRecoverySinkEnabled("sink/1", false);
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/audit-sinks/sink%2F1",
      { enabled: false },
      WRITE_OPTIONS,
    );

    mocks.post.mockResolvedValue({
      kid: "key-2",
      alg: "HS256",
      sink_id: "sink/1",
    });
    await expect(rotateAuditSinkSigningKey("sink/1")).resolves.toEqual({
      kid: "key-2",
    });
    expect(mocks.post).toHaveBeenLastCalledWith(
      "/api/v1/audit-sinks/sink%2F1/rotate-key",
      {},
      WRITE_OPTIONS,
    );
  });

  it("verifies SOC credentials online without retaining or echoing them", async () => {
    mocks.post.mockResolvedValue({ ok: true });
    await verifyAuditAlertChannel("jira", {
      site_url: "https://example.atlassian.net/",
      project_key: "SEC",
      email: "analyst@example.test",
      api_token: "write-only-token",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit-alerts/jira/auth",
      {
        site_url: "https://example.atlassian.net",
        email: "analyst@example.test",
        api_token: "write-only-token",
      },
      WRITE_OPTIONS,
    );
    await expect(
      verifyAuditAlertChannel("jira", {
        site_url: "https://example.atlassian.net/path",
        email: "analyst@example.test",
        api_token: "write-only-token",
      }),
    ).rejects.toThrow(/without credentials, path, query, or fragment/i);
  });

  it("queues and lists bounded export jobs without worker errors or emails", async () => {
    mocks.post.mockResolvedValue({
      id: "job-1",
      status: "pending",
      estimatedRows: 20_000,
      exportedRows: 0,
      totalBytes: 0,
      emailOnComplete: false,
      createdAt: "2026-08-29T10:00:00Z",
    });
    await expect(
      createAuditExportJob({ action: "subscriber.*" }),
    ).resolves.toMatchObject({ id: "job-1", status: "pending" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit/export-async",
      { action: "subscriber.*", emailOnComplete: false },
      WRITE_OPTIONS,
    );

    mocks.get.mockResolvedValue({
      jobs: [
        {
          id: "job-2",
          status: "failed",
          exportedRows: 10,
          totalBytes: 1024,
          errorReason: "s3://secret-bucket/provider-token",
          emailOnComplete: true,
          emailAddress: "security@example.test",
          createdAt: "2026-08-29T10:00:00Z",
          completedAt: "2026-08-29T10:01:00Z",
        },
      ],
    });
    const [failed] = await listAuditExportJobs(20);
    expect(failed).toMatchObject({ id: "job-2", hasError: true });
    expect(JSON.stringify(failed)).not.toContain("secret-bucket");
    expect(JSON.stringify(failed)).not.toContain("security@example.test");
  });

  it("bounds replay jobs, binds list rows to tenant and sink, and rejects drift", async () => {
    mocks.post.mockResolvedValue({
      job_id: "job-1",
      status: "pending",
      created_at: "2026-08-29T10:00:00Z",
      from_id: 1,
      to_id: 100_000,
    });
    await expect(
      createAuditSinkReplayJob("sink-1", 1, 100_000),
    ).resolves.toMatchObject({ jobId: "job-1", status: "pending" });
    await expect(
      createAuditSinkReplayJob("sink-1", 1, 100_001),
    ).rejects.toThrow(/100,000/i);

    mocks.get.mockResolvedValue({
      count: 1,
      jobs: [
        {
          id: "job-1",
          tenant_id: "tenant-other",
          sink_id: "sink-1",
          from_audit_id: 1,
          to_audit_id: 2,
          status: "pending",
          rows_sent: 0,
          rows_failed: 0,
          created_at: "2026-08-29T10:00:00Z",
        },
      ],
    });
    await expect(listAuditSinkReplayJobs("tenant-1", "sink-1")).rejects.toThrow(
      /invalid replay-job list/i,
    );

    mocks.get.mockResolvedValue({
      count: 1,
      nextCursor: "cursor-1",
      jobs: [
        {
          id: "job-1",
          tenant_id: "tenant-1",
          sink_id: "sink-1",
          from_audit_id: 1,
          to_audit_id: 2,
          status: "completed",
          rows_sent: 2,
          rows_failed: 0,
          created_at: "2026-08-29T10:00:00Z",
        },
      ],
    });
    await expect(
      listAuditSinkReplayJobs("tenant-1", "sink-1", {
        cursor: "cursor-1",
      }),
    ).rejects.toThrow(/invalid replay-job list/i);
  });

  it("validates bulk replay aggregate and per-entry receipts", async () => {
    mocks.post.mockResolvedValue({
      replayed: 1,
      failed: 1,
      skipped: 0,
      entries: [
        { id: 1, status: "ok", rows: 4 },
        {
          id: 2,
          status: "failed",
          rows: 0,
          errorMsg: "provider detail withheld by decoder",
        },
      ],
    });
    const receipt = await replayAuditSinkDLQBulk([1, 2]);
    expect(receipt).toMatchObject({ replayed: 1, failed: 1, skipped: 0 });
    expect(receipt.entries[1]).toEqual({
      id: 2,
      status: "failed",
      rows: 0,
      hasError: true,
    });
    expect(JSON.stringify(receipt)).not.toContain("provider detail");
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit-sinks/dlq/replay-bulk",
      { ids: [1, 2] },
      WRITE_OPTIONS,
    );
  });

  it("keeps a validated DLQ item id in one encoded path segment", async () => {
    mocks.post.mockResolvedValue({ replayed: true, rows: 4, note: "" });

    await expect(replayAuditSinkDLQEntry(42)).resolves.toEqual({
      replayed: true,
      rows: 4,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit-sinks/dlq/42/replay",
      {},
      WRITE_OPTIONS,
    );

    mocks.post.mockClear();
    await expect(
      replayAuditSinkDLQEntry("42/replay-bulk" as unknown as number),
    ).rejects.toThrow(/positive DLQ entry id/i);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("binds inclusion proofs to the requested row and strictly decodes manifests", async () => {
    mocks.get.mockResolvedValueOnce({
      leaf_id: 42,
      leaf_hash: "deadbeef",
      audit_path: ["aabb"],
      tree_size: 50,
      root_hash: "cafebabe",
      root_signature: "0011",
      root_kid: "root-key",
      anchored_at: "2026-08-29T10:00:00Z",
    });
    await expect(getAuditInclusionProof(42)).resolves.toMatchObject({
      leafId: 42,
      treeSize: 50,
      auditPath: ["aabb"],
    });

    mocks.get.mockResolvedValueOnce({
      manifests: [
        {
          export_id: "export-1",
          filters_canonical: { action: "subscriber.delete" },
          from_audit_id: 10,
          to_audit_id: 20,
          row_count: 11,
          tree_size_at_export: 25,
          root_hash_hex: "cafebabe",
          signature_hex: "0011",
          signature_kid: "root-key",
          exported_by: "auditor@example.test",
          created_at: "2026-08-29T10:00:00Z",
        },
      ],
    });
    await expect(listAuditExportManifests(20)).resolves.toEqual([
      expect.objectContaining({
        exportId: "export-1",
        rowCount: 11,
        hasSignature: true,
      }),
    ]);
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/v1/audit/export/manifests?limit=20",
      {},
    );
  });
});
