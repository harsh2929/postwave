// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error {},
}));

import {
  composeSchedule,
  createScheduledReport,
  deleteScheduledReport,
  normalizeScheduledReportCreateInput,
  parseRecipientDraft,
  parseScheduledReportsEnvelope,
  ScheduledReportContractError,
  ScheduledReportInputError,
  sendScheduledReportNow,
  updateScheduledReport,
} from "@/lib/scheduled-reports-api";

const TENANT_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51aa";
const REPORT_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51bb";
const RUN_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51cc";
const CREATED_AT = "2026-08-29T00:00:00Z";

const REPORT = {
  id: REPORT_ID,
  name: "Weekly operations",
  enabled: true,
  template: "deliverability",
  schedule: "weekly:mon@09:00",
  timezone: "Asia/Kolkata",
  recipients: ["ops@example.com"],
  latest_run_id: RUN_ID,
  latest_run_status: "partial",
  latest_run_created_at: "2026-08-29T00:01:00Z",
  latest_run_accepted_count: 1,
  latest_run_failed_count: 0,
  latest_run_unknown_count: 0,
  latest_run_recipient_count: 1,
  last_run_at: "2026-08-29T00:02:00Z",
  next_due_at: "2026-09-01T03:30:00Z",
  created_at: CREATED_AT,
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
});

describe("scheduled report browser contract", () => {
  it("normalizes bounded inputs, schedules, and case-insensitive recipients", () => {
    expect(
      parseRecipientDraft(
        "Owner@Example.com, owner@example.com; ops@example.com",
      ),
    ).toEqual(["Owner@Example.com", "ops@example.com"]);
    expect(
      composeSchedule({
        kind: "monthly",
        weekday: "mon",
        dayOfMonth: 28,
        time: "23:59",
      }),
    ).toBe("monthly:28@23:59");
    expect(
      normalizeScheduledReportCreateInput({
        name: "  Weekly operations  ",
        template: "deliverability",
        schedule: " weekly:mon@09:00 ",
        timezone: " Asia/Kolkata ",
        recipients: ["Owner@Example.com", "owner@example.com"],
      }),
    ).toEqual({
      name: "Weekly operations",
      template: "deliverability",
      schedule: "weekly:mon@09:00",
      timezone: "Asia/Kolkata",
      recipients: ["Owner@Example.com"],
    });
    expect(() =>
      composeSchedule({
        kind: "monthly",
        weekday: "mon",
        dayOfMonth: 29,
        time: "09:00",
      }),
    ).toThrow(ScheduledReportInputError);
  });

  it("accepts consistent latest-run evidence and rejects duplicate or impossible rows", () => {
    const parsed = parseScheduledReportsEnvelope(
      { reports: [REPORT] },
      TENANT_ID,
    );
    expect(parsed.tenantId).toBe(TENANT_ID);
    expect(parsed.reports[0]).toMatchObject({
      id: REPORT_ID,
      latestRunStatus: "partial",
      latestRunAcceptedCount: 1,
      recipients: ["ops@example.com"],
    });

    expect(() =>
      parseScheduledReportsEnvelope({ reports: [REPORT, REPORT] }, TENANT_ID),
    ).toThrow(ScheduledReportContractError);
    expect(() =>
      parseScheduledReportsEnvelope(
        {
          reports: [
            {
              ...REPORT,
              latest_run_accepted_count: 2,
              latest_run_recipient_count: 1,
            },
          ],
        },
        TENANT_ID,
      ),
    ).toThrow(ScheduledReportContractError);
    expect(() =>
      parseScheduledReportsEnvelope({ reports: [] }, "not-a-workspace"),
    ).toThrow(ScheduledReportInputError);
  });

  it("uses online single-attempt CRUD and parses explicit receipts", async () => {
    const controller = new AbortController();
    apiMocks.post.mockResolvedValueOnce({
      id: REPORT_ID,
      next_due_at: "2026-09-01T03:30:00Z",
      timezone: "Asia/Kolkata",
    });
    apiMocks.patch.mockResolvedValue({ updated: true });
    apiMocks.delete.mockResolvedValue({ deleted: true });

    await expect(
      createScheduledReport(
        {
          name: "Weekly operations",
          template: "deliverability",
          schedule: "weekly:mon@09:00",
          timezone: "Asia/Kolkata",
          recipients: ["ops@example.com"],
        },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ id: REPORT_ID, timezone: "Asia/Kolkata" });
    expect(apiMocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/scheduled-reports",
      expect.objectContaining({ recipients: ["ops@example.com"] }),
      {
        signal: controller.signal,
        requireOnline: true,
        maxAttempts: 1,
      },
    );

    await updateScheduledReport(
      REPORT_ID,
      {
        name: "Weekly operations",
        enabled: false,
        schedule: "weekly:mon@09:00",
        timezone: "Asia/Kolkata",
        recipients: ["ops@example.com"],
      },
      { signal: controller.signal },
    );
    await deleteScheduledReport(REPORT_ID, { signal: controller.signal });
    expect(apiMocks.patch).toHaveBeenCalledWith(
      `/api/v1/scheduled-reports/${REPORT_ID}`,
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(apiMocks.delete).toHaveBeenCalledWith(
      `/api/v1/scheduled-reports/${REPORT_ID}`,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("binds send-now to one stable idempotency key and exact durable receipt", async () => {
    apiMocks.post.mockResolvedValue({
      queued: true,
      run_id: RUN_ID,
      scheduled_report_id: REPORT_ID,
      run_kind: "manual",
      status: "queued",
      occurrence_at: "2026-08-29T00:03:00Z",
      created_at: "2026-08-29T00:03:00Z",
    });
    await expect(
      sendScheduledReportNow(REPORT_ID, "018f47f2-request-key"),
    ).resolves.toMatchObject({
      queued: true,
      runId: RUN_ID,
      scheduledReportId: REPORT_ID,
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      `/api/v1/scheduled-reports/${REPORT_ID}/send-now`,
      undefined,
      expect.objectContaining({
        idempotencyKey: "018f47f2-request-key",
        requireOnline: true,
        maxAttempts: 1,
      }),
    );

    apiMocks.post.mockResolvedValue({
      queued: true,
      run_id: RUN_ID,
      scheduled_report_id: TENANT_ID,
      run_kind: "manual",
      status: "queued",
      occurrence_at: "2026-08-29T00:03:00Z",
      created_at: "2026-08-29T00:03:00Z",
    });
    await expect(
      sendScheduledReportNow(REPORT_ID, "018f47f2-request-key"),
    ).rejects.toBeInstanceOf(ScheduledReportContractError);
  });
});
