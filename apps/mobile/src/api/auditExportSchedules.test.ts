/**
 * The export-schedule endpoints at the transport boundary — the `{data,error}`
 * envelope seam, mocked (the audienceDestinations idiom).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_EXPORT_SCHEDULES_PATH,
  createAuditExportSchedule,
  deleteAuditExportSchedule,
  fetchAuditExportSchedules,
} from "./auditExportSchedules";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      data: unknown;
      error: { status: number; message: string; code?: string } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      throw Object.assign(new Error(result.error.message), {
        status: result.error.status,
        ...(result.error.code ? { code: result.error.code } : {}),
      });
    }
    return result;
  },
}));

beforeEach(() => rawRequest.mockReset());

describe("export schedule transport", () => {
  it("unwraps the {schedules} envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { schedules: [{ id: "s1", cadence: "weekly", recipients: [] }] },
      error: null,
    });
    const rows = await fetchAuditExportSchedules();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      AUDIT_EXPORT_SCHEDULES_PATH,
    );
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("POSTs the normalised body verbatim", async () => {
    rawRequest.mockResolvedValue({ data: { id: "s2" }, error: null });
    await createAuditExportSchedule({
      cadence: "monthly",
      recipients: ["a@b.co"],
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      AUDIT_EXPORT_SCHEDULES_PATH,
      { cadence: "monthly", recipients: ["a@b.co"] },
    );
  });

  it("DELETEs the schedule id-encoded and surfaces a refusal", async () => {
    rawRequest.mockResolvedValue({ data: { deleted: true }, error: null });
    await deleteAuditExportSchedule("a b");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      `${AUDIT_EXPORT_SCHEDULES_PATH}/a%20b`,
    );

    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(deleteAuditExportSchedule("s1")).rejects.toMatchObject({
      status: 403,
    });
  });
});
