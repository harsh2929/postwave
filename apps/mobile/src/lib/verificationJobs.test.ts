import { describe, expect, it } from "vitest";

import {
  parseVerificationJobs,
  type VerificationJob,
  verificationJobIsCancellable,
  verificationJobIsRunning,
  verificationJobSummary,
} from "./verificationJobs";
import { WireShapeError } from "./deliverabilityContracts";

const JOB_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";
const CREATED_AT = "2026-08-29T00:00:00Z";

const job = (extra: Partial<VerificationJob> = {}): VerificationJob => ({
  id: JOB_ID,
  status: "running",
  total: 5000,
  processed: 412,
  createdAt: CREATED_AT,
  ...extra,
});

describe("verificationJobIsRunning", () => {
  it("treats every terminal spelling as finished", () => {
    for (const status of [
      "complete",
      "completed",
      "failed",
      "cancelled",
      "canceled",
      "CANCELLED",
    ]) {
      expect(verificationJobIsRunning(status)).toBe(false);
    }
  });

  it("treats anything else, including empty, as still running", () => {
    // Failing toward "running" keeps the Cancel button available on a status the
    // server later adds; the opposite would silently remove the brake.
    expect(verificationJobIsRunning("running")).toBe(true);
    expect(verificationJobIsRunning("queued")).toBe(true);
    expect(verificationJobIsRunning("")).toBe(true);
  });
});

describe("verificationJobIsCancellable", () => {
  it("offers cancel while there is spend left to prevent", () => {
    expect(verificationJobIsCancellable(job())).toBe(true);
  });

  it("does NOT offer cancel once the work is done", () => {
    // The point of the button is the spend. A finished job has already cost what
    // it will cost, so Cancel implies a refund that is not coming.
    expect(verificationJobIsCancellable(job({ processed: 5000 }))).toBe(false);
    expect(verificationJobIsCancellable(job({ status: "completed" }))).toBe(
      false,
    );
  });
});

describe("verificationJobSummary", () => {
  it("counts what is still to be SPENT, not what is done", () => {
    // "412 of 5,000" is a progress bar; the remaining count is what decides
    // whether to hit Cancel.
    const summary = verificationJobSummary(job());
    expect(summary).toContain("4588 addresses still to verify");
    expect(summary).toContain("can still use provider credits");
  });

  it("uses the singular for one remaining", () => {
    expect(verificationJobSummary(job({ processed: 4999 }))).toContain(
      "1 address still",
    );
  });

  it("reports a finished job plainly", () => {
    expect(
      verificationJobSummary(job({ status: "completed", processed: 5000 })),
    ).toContain("completed");
  });

  it("does not claim remaining work when the counts have caught up", () => {
    expect(verificationJobSummary(job({ processed: 5000 }))).toContain(
      "5000 of 5000",
    );
  });
});

describe("parseVerificationJobs", () => {
  it("reads the typed jobs envelope without coercing its rows", () => {
    const [row] = parseVerificationJobs({
      jobs: [
        {
          id: JOB_ID,
          status: "running",
          total: 10,
          processed: 3,
          created_at: CREATED_AT,
        },
      ],
    });
    expect(row?.total).toBe(10);
    expect(row?.processed).toBe(3);
    expect(parseVerificationJobs({ jobs: [] })).toEqual([]);
  });

  it.each([null, [], {}, { items: [] }, { jobs: {} }])(
    "rejects malformed envelope %#",
    (payload) => {
      expect(() => parseVerificationJobs(payload)).toThrow(WireShapeError);
    },
  );

  it.each([
    {
      id: "not-a-uuid",
      status: "running",
      total: 5,
      processed: 0,
      created_at: CREATED_AT,
    },
    {
      id: JOB_ID,
      status: "queued",
      total: 5,
      processed: 0,
      created_at: CREATED_AT,
    },
    {
      id: JOB_ID,
      status: "running",
      total: -2,
      processed: 0,
      created_at: CREATED_AT,
    },
    {
      id: JOB_ID,
      status: "running",
      total: 5,
      processed: 6,
      created_at: CREATED_AT,
    },
    { id: JOB_ID, status: "running", total: 5, processed: 0, created_at: "" },
  ])("rejects malformed job row %#", (row) => {
    expect(() => parseVerificationJobs({ jobs: [row] })).toThrow(
      WireShapeError,
    );
  });
});
