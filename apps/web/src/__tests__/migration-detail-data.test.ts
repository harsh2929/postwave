import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadMigrationDetailData,
  loadMigrationPilotControls,
  smsReadinessCutoverEvidence,
} from "@/app/(dashboard)/app/migrations/[jobId]/migration-detail-data";
import { ApiError } from "@/lib/api";
import type { MigrationJob, VerificationReport } from "@/lib/types";

const api = vi.hoisted(() => ({
  getAuditLog: vi.fn(),
  getJob: vi.fn(),
  getPilotAcceptance: vi.fn(),
  getShadowMonitor: vi.fn(),
  getSourceEvents: vi.fn(),
  getVerification: vi.fn(),
  listAutomationRebuilds: vi.fn(),
}));

vi.mock("@/lib/migration-api", () => api);

const job: MigrationJob = {
  id: "mig_activecampaign",
  tenant_id: "tenant_1",
  source: "activecampaign",
  status: "importing",
  progress: {
    subscribers_total: 100,
    subscribers_done: 25,
    segments_total: 2,
    segments_done: 1,
    automations_total: 0,
    automations_done: 0,
    archive_total: 0,
    archive_done: 0,
    paid_subs_total: 0,
    paid_subs_done: 0,
  },
  cursor: {},
  started_at: "2026-07-07T01:00:00.000Z",
  completed_at: null,
  rollback_until: null,
  verification_report: null,
  error: null,
};

const report: VerificationReport = {
  subscribers_imported: 100,
  suppression_list_size: 0,
  custom_fields_mapped: [],
  custom_fields_unmapped: [],
  segments_translated: 2,
  segments_with_warnings: [],
  automations_translated: 0,
  automations_unsupported: [],
  paid_subs_imported: 0,
  archive_imported: 0,
  data_loss_estimate_pct: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getJob.mockResolvedValue(job);
  api.getVerification.mockResolvedValue(report);
  api.getAuditLog.mockResolvedValue([]);
  api.getPilotAcceptance.mockResolvedValue({
    status: "warning",
    blockers: 0,
    warnings: 1,
    items: [],
  });
  api.listAutomationRebuilds.mockResolvedValue({ items: [] });
  api.getShadowMonitor.mockResolvedValue({
    monitor: {
      tenant_id: "tenant_1",
      job_id: job.id,
      source: "activecampaign",
      enabled: false,
      interval_seconds: 3600,
    },
    history: [],
  });
  api.getSourceEvents.mockResolvedValue({
    monitor: {
      tenant_id: "tenant_1",
      job_id: job.id,
      source: "activecampaign",
      enabled: false,
      interval_seconds: 300,
      events_seen: 0,
      events_applied: 0,
    },
    events: [],
  });
});

describe("loadMigrationDetailData", () => {
  it("keeps the detail page loadable while verification and audit sidecars are not ready", async () => {
    api.getVerification.mockRejectedValue(
      new Error("verification report not yet available"),
    );
    api.getAuditLog.mockRejectedValue(new Error("audit unavailable"));

    await expect(loadMigrationDetailData(job.id)).resolves.toEqual({
      job,
      report: null,
      audit: [],
      errors: {
        report: "verification report not yet available",
        audit: "audit unavailable",
      },
    });
  });

  it("treats a not-yet-created verification report as expected for an active job", async () => {
    api.getVerification.mockRejectedValue(
      new ApiError("verification report not found", 404),
    );

    await expect(loadMigrationDetailData(job.id)).resolves.toEqual({
      job,
      report: null,
      audit: [],
    });
  });

  it("still fails when the migration job itself cannot be loaded", async () => {
    api.getJob.mockRejectedValue(new Error("job not found"));

    await expect(loadMigrationDetailData(job.id)).rejects.toThrow(
      "job not found",
    );
  });

  it("surfaces verification failures after a migration reaches a terminal state", async () => {
    api.getJob.mockResolvedValue({
      ...job,
      status: "completed",
      completed_at: "2026-07-07T01:30:00.000Z",
    } satisfies MigrationJob);
    api.getVerification.mockRejectedValue(
      new ApiError("verification unavailable", 500),
    );

    await expect(loadMigrationDetailData(job.id)).rejects.toThrow(
      "verification unavailable",
    );
  });
});

describe("loadMigrationPilotControls", () => {
  it("treats missing monitor records as not-started instead of sidecar failures", async () => {
    api.getShadowMonitor.mockRejectedValue(
      new ApiError("shadow monitor not found", 404),
    );
    api.getSourceEvents.mockRejectedValue(
      new ApiError("source-event monitor not found", 404),
    );

    const result = await loadMigrationPilotControls(job.id);

    expect(result).toMatchObject({
      rebuilds: [],
      shadow: null,
      sourceEvents: null,
    });
    expect(result.errors).toBeUndefined();
  });

  it("returns partial pilot-control data with sidecar error messages", async () => {
    api.getPilotAcceptance.mockRejectedValue(
      new ApiError("acceptance unavailable", 503),
    );
    api.getShadowMonitor.mockRejectedValue(new Error("shadow unavailable"));
    api.getSourceEvents.mockRejectedValue(
      new Error("source-event replay unavailable"),
    );

    await expect(loadMigrationPilotControls(job.id)).resolves.toEqual({
      rebuilds: [],
      errors: {
        acceptance: "acceptance unavailable",
        shadow: "shadow unavailable",
        sourceEvents: "source-event replay unavailable",
      },
    });
  });
});

describe("smsReadinessCutoverEvidence", () => {
  it("turns a passing live readiness response into durable non-secret evidence", () => {
    const result = smsReadinessCutoverEvidence({
      can_pilot: true,
      counts: { opted_in_subscriptions: 12, approved_senders: 1 },
      items: [
        { key: "recipient_consent", label: "Consent", status: "pass" },
        { key: "approved_sender", label: "Sender", status: "pass" },
      ],
    });

    expect(result.ready).toBe(true);
    expect(result.evidence).toEqual([
      "sms_pilot_readiness_can_pilot=true",
      "approved_senders=1",
      "opted_in_subscriptions=12",
      "approved_sender=pass",
      "recipient_consent=pass",
    ]);
  });

  it("refuses to create passing evidence while the live readiness endpoint has blockers", () => {
    const result = smsReadinessCutoverEvidence({
      can_pilot: false,
      counts: { approved_senders: 0 },
      items: [
        {
          key: "approved_sender",
          label: "Sender",
          status: "blocker",
        },
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("approved_sender");
    expect(result.evidence[0]).toBe("sms_pilot_readiness_can_pilot=false");
  });
});
