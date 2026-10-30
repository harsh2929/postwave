import { describe, expect, it } from "vitest";

import { WireShapeError } from "./deliverabilityContracts";
import {
  nextVerificationResultsLimit,
  parseVerificationJobDetail,
  parseVerificationJobResults,
  VERIFICATION_RESULTS_MAX,
  VERIFICATION_RESULTS_PAGE_SIZE,
  verificationJobOutcomeLine,
  verificationJobProgressLine,
  verificationJobResultLine,
  verificationJobResultsEmptyLine,
  verificationJobResultsPageLine,
  verificationJobResultsTotal,
  verificationJobSpendLine,
  verificationJobStatusCounts,
  VERIFICATION_UNSENDABLE_STATUSES,
  type VerificationJobDetail,
} from "./verificationJobDetail";

const wire = (extra: Record<string, unknown> = {}) => {
  const { job: jobExtra, ...rest } = extra;
  return {
    job: {
      id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
      status: "running",
      source: "tag",
      execution_mode: "full",
      provider: "zerobounce",
      total: 5000,
      processed: 1200,
      cache_hits: 300,
      local_filtered: 500,
      vendor_verified: 400,
      duplicates: 12,
      ambiguous: 0,
      created_at: "2026-09-01T00:00:00Z",
      ...((jobExtra as Record<string, unknown> | undefined) ?? {}),
    },
    summary: { valid: 900, invalid: 250, catch_all: 50 },
    credits_spent: 400,
    credits_saved: 800,
    is_terminal: false,
    ...rest,
  };
};

const detail = (extra: Record<string, unknown> = {}): VerificationJobDetail =>
  parseVerificationJobDetail(wire(extra));

describe("parseVerificationJobDetail", () => {
  it("keeps the server's own spend numbers rather than deriving them", () => {
    const parsed = detail();
    expect(parsed.creditsSpent).toBe(400);
    expect(parsed.creditsSaved).toBe(800);
    expect(parsed.job.vendorVerified).toBe(400);
    expect(parsed.isTerminal).toBe(false);
  });

  it("rejects a payload with no job and a non-numeric count", () => {
    expect(() => parseVerificationJobDetail({ summary: {} })).toThrow(
      WireShapeError,
    );
    expect(() =>
      parseVerificationJobDetail(wire({ credits_spent: "lots" })),
    ).toThrow(WireShapeError);
    expect(() =>
      parseVerificationJobDetail(wire({ summary: { valid: "many" } })),
    ).toThrow(WireShapeError);
  });

  it("treats a missing is_terminal as 'still running', never as finished", () => {
    const parsed = parseVerificationJobDetail(wire({ is_terminal: undefined }));
    expect(parsed.isTerminal).toBe(false);
  });
});

describe("parseVerificationJobResults", () => {
  it("parses a results page and its per-address flags", () => {
    const rows = parseVerificationJobResults({
      results: [
        {
          email: "a@example.com",
          processed: true,
          status: "INVALID",
          sub_status: "mailbox_not_found",
          score: 3,
          provider: "zerobounce",
          billable: true,
          cached: false,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("invalid");
    expect(rows[0]?.billable).toBe(true);
    expect(rows[0]?.score).toBe(3);
  });

  it("rejects a non-array results field instead of rendering an empty page", () => {
    expect(() => parseVerificationJobResults({ results: "none" })).toThrow(
      WireShapeError,
    );
    expect(parseVerificationJobResults({}).length).toBe(0);
  });
});

describe("verificationJobProgressLine / SpendLine", () => {
  it("marks an unfinished run as partial and warns that spend continues", () => {
    expect(verificationJobProgressLine(detail())).toContain("so far");
    const spend = verificationJobSpendLine(detail());
    expect(spend).toContain("400 credits spent so far");
    expect(spend).toContain("Remaining work can still spend credits");
  });

  it("drops the hedging once the job is terminal", () => {
    const done = detail({ is_terminal: true });
    expect(verificationJobProgressLine(done)).not.toContain("so far");
    expect(verificationJobSpendLine(done)).not.toContain(
      "can still spend credits",
    );
  });

  it("names where the free answers came from", () => {
    const line = verificationJobProgressLine(detail());
    expect(line).toContain("400 sent to the vendor");
    expect(line).toContain("300 already cached");
    expect(line).toContain("500 settled by the free local tier");
  });
});

describe("verificationJobOutcomeLine", () => {
  it("renders the server's sanitised failure sentence verbatim", () => {
    const failed = detail({
      job: { status: "failed", error: "The verification run failed." },
      is_terminal: true,
    });
    expect(verificationJobOutcomeLine(failed)).toBe(
      "The verification run failed.",
    );
  });

  it("says a cancelled run's credits are not refunded", () => {
    const stopped = detail({ job: { status: "canceled" }, is_terminal: true });
    expect(verificationJobOutcomeLine(stopped)).toContain("not refunded");
  });

  it("names unconfirmed provider outcomes on a completed run", () => {
    const done = detail({
      job: { status: "completed", ambiguous: 3 },
      is_terminal: true,
    });
    expect(verificationJobOutcomeLine(done)).toContain("3 addresses");
    expect(verificationJobOutcomeLine(done)).toContain("could not be confirmed");
  });

  it("says a running job's counts are partial", () => {
    expect(verificationJobOutcomeLine(detail())).toContain(
      "only what has been processed so far",
    );
  });
});

describe("verificationJobStatusCounts", () => {
  it("puts the unsendable verdicts first and flags them", () => {
    const counts = verificationJobStatusCounts(detail());
    expect(counts[0]?.status).toBe("invalid");
    expect(counts[0]?.unsendable).toBe(true);
    expect(counts.map((row) => row.status)).toEqual([
      "invalid",
      "valid",
      "catch_all",
    ]);
  });

  it("does not count catch_all or unknown as failures", () => {
    expect(VERIFICATION_UNSENDABLE_STATUSES).not.toContain("catch_all");
    expect(VERIFICATION_UNSENDABLE_STATUSES).not.toContain("unknown");
  });

  it("drops zero-count statuses", () => {
    const counts = verificationJobStatusCounts(
      detail({ summary: { valid: 4, abuse: 0 } }),
    );
    expect(counts.map((row) => row.status)).toEqual(["valid"]);
  });
});

describe("verificationJobResultLine", () => {
  it("says an unprocessed address is not checked yet", () => {
    const [row] = parseVerificationJobResults({
      results: [{ email: "a@example.com", processed: false, status: "" }],
    });
    expect(verificationJobResultLine(row!)).toBe("not checked yet");
  });

  it("distinguishes a cached answer from a paid one", () => {
    const [cached] = parseVerificationJobResults({
      results: [
        { email: "a@b.com", processed: true, status: "valid", cached: true },
      ],
    });
    const [paid] = parseVerificationJobResults({
      results: [
        { email: "a@b.com", processed: true, status: "valid", billable: true },
      ],
    });
    expect(verificationJobResultLine(cached!)).toContain("from cache");
    expect(verificationJobResultLine(paid!)).toContain("vendor credit spent");
  });
});

describe("verificationJobResultsEmptyLine", () => {
  it("never reads as an all-clear while the run is unfinished", () => {
    const line = verificationJobResultsEmptyLine(detail(), true);
    expect(line).toContain("this run is not finished");
  });

  it("can call a finished run clean", () => {
    expect(
      verificationJobResultsEmptyLine(detail({ is_terminal: true }), true),
    ).toBe("No unsendable addresses were found in this run.");
  });

  it("says nothing has been processed when the page is unfiltered and empty", () => {
    expect(
      verificationJobResultsEmptyLine(detail({ job: { processed: 0 } }), false),
    ).toBe("No addresses have been processed yet.");
  });
});

describe("verificationJobResultsTotal", () => {
  it("counts only the unsendable verdicts for the failures scope", () => {
    // summary is valid 900 / invalid 250 / catch_all 50 — catch_all is
    // sendable, so the failure total is 250, not 300.
    expect(verificationJobResultsTotal(detail(), true)).toBe(250);
  });

  it("uses what the job has PROCESSED for the unfiltered scope", () => {
    expect(verificationJobResultsTotal(detail(), false)).toBe(1200);
  });
});

describe("verificationJobResultsPageLine", () => {
  it("says a capped failure page is capped, with the server's own total", () => {
    expect(
      verificationJobResultsPageLine({
        detail: detail(),
        shown: 50,
        failuresOnly: true,
      }),
    ).toBe("Showing 50 of 250 unsendable addresses.");
  });

  it("says NOTHING once the page holds the whole list", () => {
    expect(
      verificationJobResultsPageLine({
        detail: detail({ summary: { invalid: 2 } }),
        shown: 2,
        failuresOnly: true,
      }),
    ).toBe("");
    // An empty page has its own sentence; this one must not double up on it.
    expect(
      verificationJobResultsPageLine({
        detail: detail(),
        shown: 0,
        failuresOnly: true,
      }),
    ).toBe("");
  });

  it("admits where phone paging stops rather than implying more taps", () => {
    const line = verificationJobResultsPageLine({
      detail: detail({ summary: { invalid: 4000 } }),
      shown: VERIFICATION_RESULTS_MAX,
      failuresOnly: true,
    });
    expect(line).toContain("Showing 1,000 of 4,000 unsendable addresses");
    expect(line).toContain("as far as a phone pages");
  });
});

describe("nextVerificationResultsLimit", () => {
  it("grows one page at a time", () => {
    expect(nextVerificationResultsLimit(VERIFICATION_RESULTS_PAGE_SIZE)).toBe(
      100,
    );
  });

  it("never asks past the server's ceiling, which would SHRINK the page", () => {
    // JobResults resets a limit > 1000 back to 100, so overshooting would
    // return fewer rows than the request before it.
    expect(nextVerificationResultsLimit(980)).toBe(VERIFICATION_RESULTS_MAX);
    expect(nextVerificationResultsLimit(VERIFICATION_RESULTS_MAX)).toBe(
      VERIFICATION_RESULTS_MAX,
    );
  });
});
