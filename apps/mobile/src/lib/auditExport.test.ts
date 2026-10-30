import { describe, expect, it } from "vitest";

import {
  activeAuditExport,
  auditExportDetail,
  auditExportHeadline,
  auditExportKind,
  auditExportPollMs,
  auditExportProgressPct,
  auditExportScope,
  auditExportSpoken,
  auditExportTone,
  AUDIT_EXPORT_STALL_MS,
  isAuditExportActive,
  normalizeAuditExportJobs,
  type AuditExportJob,
} from "./auditExport";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function job(over: Partial<AuditExportJob> = {}): AuditExportJob {
  return {
    id: "job-1",
    status: "pending",
    createdAt: new Date(NOW - 30_000).toISOString(),
    exportedRows: 0,
    totalBytes: 0,
    ...over,
  };
}

describe("auditExportScope", () => {
  it("sends only the two facets the server actually has", () => {
    const scope = auditExportScope({
      actorType: "agent",
      since: "2026-07-19T12:00:00.000Z",
      windowDescription: "the last 7 days",
      query: "delete",
      destructiveOnly: true,
    });
    // The search text and the destructive toggle have NO server facet, so they
    // must never leak into the request body as if they did.
    expect(scope.body).toEqual({
      actorType: "agent",
      since: "2026-07-19T12:00:00.000Z",
    });
  });

  it("names the client-only narrowing that will NOT reach the file", () => {
    const scope = auditExportScope({
      windowDescription: "the last 24 hours",
      query: "  delete  ",
      destructiveOnly: true,
    });
    expect(scope.dropped).toContain('the search for "delete"');
    expect(scope.dropped).toContain("the Destructive-only toggle");
    expect(scope.dropped).toContain("will NOT narrow the file");
  });

  it("has nothing to disclose when the screen is not narrowed client-side", () => {
    const scope = auditExportScope({
      since: "2026-07-25T12:00:00.000Z",
      windowDescription: "the last 24 hours",
      query: "   ",
      destructiveOnly: false,
    });
    expect(scope.dropped).toBeNull();
    expect(scope.applied).toBe("Everything in the last 24 hours.");
  });

  it("states the actor facet in the applied sentence when one is pushed", () => {
    const scope = auditExportScope({
      actorType: "api_key",
      windowDescription: "all recorded history",
    });
    expect(scope.applied).toBe(
      "Everything in all recorded history, from api_key actors.",
    );
  });

  it("omits an absent window bound rather than sending an empty string", () => {
    const scope = auditExportScope({ windowDescription: "all recorded history" });
    expect(scope.body).toEqual({});
  });
});

describe("auditExportKind", () => {
  it("maps the server's own status vocabulary", () => {
    expect(auditExportKind(job({ status: "completed" }), NOW)).toBe("done");
    expect(auditExportKind(job({ status: "failed" }), NOW)).toBe("failed");
    // The worker writes 'in_progress', NOT 'running'.
    expect(auditExportKind(job({ status: "in_progress" }), NOW)).toBe("running");
    expect(auditExportKind(job({ status: "pending" }), NOW)).toBe("queued");
  });

  it("reports a long-pending job as stalled, not as forever-queued", () => {
    const old = job({
      status: "pending",
      createdAt: new Date(NOW - AUDIT_EXPORT_STALL_MS - 1).toISOString(),
    });
    expect(auditExportKind(old, NOW)).toBe("stalled");
    expect(auditExportDetail(old, NOW)).toContain(
      "No export worker has picked this job up",
    );
  });

  it("holds a job just inside the stall boundary at queued", () => {
    const fresh = job({
      status: "pending",
      createdAt: new Date(NOW - AUDIT_EXPORT_STALL_MS + 1_000).toISOString(),
    });
    expect(auditExportKind(fresh, NOW)).toBe("queued");
  });

  it("treats an unparseable createdAt as queued rather than instantly stalled", () => {
    expect(auditExportKind(job({ createdAt: "not-a-date" }), NOW)).toBe("queued");
  });
});

describe("polling", () => {
  it("does not poll an empty or finished history", () => {
    expect(auditExportPollMs([], NOW)).toBe(false);
    expect(auditExportPollMs(undefined, NOW)).toBe(false);
    expect(
      auditExportPollMs([job({ status: "completed" }), job({ status: "failed" })], NOW),
    ).toBe(false);
  });

  it("polls while something can still change on its own", () => {
    expect(auditExportPollMs([job({ status: "in_progress" })], NOW)).toBe(5_000);
    expect(auditExportPollMs([job({ status: "pending" })], NOW)).toBe(5_000);
  });

  it("stops polling a stalled job — nothing is going to move it", () => {
    const stalled = job({
      createdAt: new Date(NOW - AUDIT_EXPORT_STALL_MS - 1).toISOString(),
    });
    expect(isAuditExportActive(stalled, NOW)).toBe(false);
    expect(auditExportPollMs([stalled], NOW)).toBe(false);
  });
});

describe("progress", () => {
  it("is null when the server could not estimate the row count", () => {
    expect(auditExportProgressPct(job({ estimatedRows: null }))).toBeNull();
    expect(auditExportProgressPct(job({ estimatedRows: 0 }))).toBeNull();
  });

  it("clamps to 0..100 when the worker overshoots the estimate", () => {
    expect(
      auditExportProgressPct(job({ estimatedRows: 100, exportedRows: 250 })),
    ).toBe(100);
    expect(
      auditExportProgressPct(job({ estimatedRows: 200, exportedRows: 50 })),
    ).toBe(25);
  });
});

describe("copy", () => {
  it("leads a finished job with the row count actually exported", () => {
    expect(
      auditExportHeadline(job({ status: "completed", exportedRows: 1 }), NOW),
    ).toBe("Ready · 1 row");
    expect(
      auditExportHeadline(job({ status: "completed", exportedRows: 4210 }), NOW),
    ).toBe("Ready · 4,210 rows");
  });

  it("surfaces the server's failure reason rather than a generic message", () => {
    const detail = auditExportDetail(
      job({ status: "failed", errorReason: "storage quota exceeded" }),
      NOW,
    );
    expect(detail).toContain("storage quota exceeded");
  });

  it("still says something useful when a failure carries no reason", () => {
    expect(auditExportDetail(job({ status: "failed" }), NOW)).toContain(
      "reported a failure",
    );
  });

  it("speaks both lines, because the pill colour is not spoken", () => {
    const row = job({ status: "in_progress", estimatedRows: 100, exportedRows: 40 });
    expect(auditExportSpoken(row, NOW)).toBe(
      `${auditExportHeadline(row, NOW)}. ${auditExportDetail(row, NOW)}`,
    );
  });

  it("gives every state a distinct tone", () => {
    expect(auditExportTone("done")).toBe("success");
    expect(auditExportTone("failed")).toBe("danger");
    expect(auditExportTone("stalled")).toBe("warning");
    expect(auditExportTone("running")).toBe("info");
    expect(auditExportTone("queued")).toBe("neutral");
  });
});

describe("normalizeAuditExportJobs", () => {
  it("reads the { jobs: [...] } envelope", () => {
    expect(normalizeAuditExportJobs({ jobs: [job()] })).toHaveLength(1);
  });

  it("tolerates a bare array", () => {
    expect(normalizeAuditExportJobs([job()])).toHaveLength(1);
  });

  it("degrades a drifted payload to empty rather than throwing", () => {
    expect(normalizeAuditExportJobs(null)).toEqual([]);
    expect(normalizeAuditExportJobs({ items: [job()] })).toEqual([]);
    expect(normalizeAuditExportJobs({ jobs: "nope" })).toEqual([]);
  });

  it("drops rows with no id — an un-keyable job cannot be rendered or polled", () => {
    expect(
      normalizeAuditExportJobs({ jobs: [{ status: "pending" }, job()] }),
    ).toHaveLength(1);
  });
});

describe("activeAuditExport", () => {
  it("finds the in-flight job so a duplicate is never queued", () => {
    const running = job({ id: "job-2", status: "in_progress" });
    expect(
      activeAuditExport([job({ status: "completed" }), running], NOW)?.id,
    ).toBe("job-2");
  });

  it("is null once everything has settled", () => {
    expect(activeAuditExport([job({ status: "completed" })], NOW)).toBeNull();
    expect(activeAuditExport(undefined, NOW)).toBeNull();
  });
});
