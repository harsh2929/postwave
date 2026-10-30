/**
 * The sink admin verbs at the transport boundary — the `{data,error}` envelope
 * seam, mocked (the audienceDestinations idiom).
 *
 * Contracts under test:
 *  - the disable PATCH carries ONLY `{enabled}` — config/credentials must
 *    never round-trip through a client that cannot read them;
 *  - the replay POST sends `{from_id, to_id}` in the server's field names;
 *  - a 409 cancel (job already finished) rejects with its status attached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAuditSinkReplayJob,
  deleteAuditSink,
  fetchAuditSinkReplayJobs,
  setAuditSinkEnabled,
  startAuditSinkReplay,
} from "./auditSinks";

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

describe("disable / delete", () => {
  it("PATCHes only {enabled}", async () => {
    rawRequest.mockResolvedValue({ data: { id: "s1" }, error: null });
    await setAuditSinkEnabled("s1", false);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/audit-sinks/s1",
      { enabled: false },
    );
  });

  it("DELETEs the sink id-encoded", async () => {
    rawRequest.mockResolvedValue({ data: { deleted: true }, error: null });
    await deleteAuditSink("a/b");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/audit-sinks/a%2Fb",
    );
  });

  it("a refused delete rejects with the permission status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(deleteAuditSink("s1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("range replay", () => {
  it("POSTs the range in the server's own field names and parses the job", async () => {
    rawRequest.mockResolvedValue({
      data: {
        id: "job-1",
        status: "pending",
        from_audit_id: 100,
        to_audit_id: 250,
      },
      error: null,
    });
    const job = await startAuditSinkReplay("s1", { fromId: 100, toId: 250 });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/audit-sinks/s1/replay",
      { from_id: 100, to_id: 250 },
    );
    expect(job?.id).toBe("job-1");
  });

  it("lists jobs off the {jobs} envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { jobs: [{ id: "j1", status: "completed" }], count: 1 },
      error: null,
    });
    const page = await fetchAuditSinkReplayJobs("s1");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audit-sinks/s1/replay-jobs",
    );
    expect(page.jobs).toHaveLength(1);
    expect(page.truncated).toBe(false);
  });

  it("cancel POSTs to the job's cancel route and surfaces a 409 as a rule", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 409, code: "cancel_failed", message: "already done" },
    });
    await expect(cancelAuditSinkReplayJob("s1", "j1")).rejects.toMatchObject({
      status: 409,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/audit-sinks/s1/replay-jobs/j1/cancel",
    );
  });
});
