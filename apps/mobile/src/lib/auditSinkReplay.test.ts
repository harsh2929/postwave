/**
 * lib/auditSinkReplay — the range-replay mirror of auditsink/admin.go and
 * replay.go. Every refusal here corresponds to a 400 branch in Replay; the
 * cancellable predicate mirrors CancelReplayJob's WHERE clause.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_REPLAY_ROWS_PER_JOB,
  isReplayJobCancellable,
  parseSinkReplayJob,
  parseSinkReplayJobPage,
  replayJobLine,
  validateReplayRange,
} from "./auditSinkReplay";

describe("validateReplayRange", () => {
  it("accepts a sane range as numbers", () => {
    expect(validateReplayRange("100", "250")).toEqual({
      range: { fromId: 100, toId: 250 },
      errors: [],
    });
  });

  it("refuses non-numeric input instead of coercing to zero", () => {
    const { range, errors } = validateReplayRange("yesterday", "250");
    expect(range).toBeNull();
    expect(errors[0]).toContain("whole numbers");
  });

  it("refuses an inverted range in the server's own terms", () => {
    const { errors } = validateReplayRange("250", "100");
    expect(errors.some((e) => e.includes("from_id must not exceed to_id"))).toBe(
      true,
    );
  });

  it("mirrors the 100,000-row cap exactly (inclusive bounds)", () => {
    // Exactly at the cap: 0..99,999 is 100,000 rows — accepted.
    expect(
      validateReplayRange("0", String(MAX_REPLAY_ROWS_PER_JOB - 1)).errors,
    ).toEqual([]);
    // One over.
    expect(
      validateReplayRange("0", String(MAX_REPLAY_ROWS_PER_JOB)).errors.length,
    ).toBe(1);
  });

  it("refuses negatives", () => {
    expect(
      validateReplayRange("-5", "10").errors.some((e) =>
        e.includes("never negative"),
      ),
    ).toBe(true);
  });
});

describe("parseSinkReplayJobPage", () => {
  it("reads the {jobs} envelope, drops idless rows, and flags truncation", () => {
    const page = parseSinkReplayJobPage({
      jobs: [
        {
          id: "j1",
          from_audit_id: 10,
          to_audit_id: 20,
          status: "in_progress",
          rows_sent: 5,
          rows_failed: 1,
          created_at: "2026-08-30T10:00:00Z",
        },
        { status: "pending" },
      ],
      nextCursor: "abc",
    });
    expect(page.jobs.map((j) => j.id)).toEqual(["j1"]);
    expect(page.truncated).toBe(true);
  });

  it("a malformed body is an empty page, never a throw", () => {
    expect(parseSinkReplayJobPage(null)).toEqual({ jobs: [], truncated: false });
  });

  it("treats Go's zero time as absent", () => {
    const job = parseSinkReplayJob({
      id: "j",
      completed_at: "0001-01-01T00:00:00Z",
    });
    expect(job?.completedAt).toBeNull();
  });
});

describe("isReplayJobCancellable", () => {
  it("bites exactly pending and in_progress — the WHERE clause", () => {
    const base = parseSinkReplayJob({ id: "j", status: "pending" })!;
    expect(isReplayJobCancellable(base)).toBe(true);
    expect(
      isReplayJobCancellable({ ...base, status: "in_progress" }),
    ).toBe(true);
    for (const status of ["completed", "cancelled", "failed"]) {
      expect(isReplayJobCancellable({ ...base, status })).toBe(false);
    }
  });
});

describe("replayJobLine", () => {
  it("says the state as a word, with the range and the counts", () => {
    const job = parseSinkReplayJob({
      id: "j",
      from_audit_id: 1000,
      to_audit_id: 2000,
      status: "in_progress",
      rows_sent: 500,
      rows_failed: 3,
    })!;
    const line = replayJobLine(job);
    expect(line).toContain("Replaying");
    expect(line).toContain("1,000–2,000");
    expect(line).toContain("3 failed");
  });

  it("a failed job carries the server's own error", () => {
    const job = parseSinkReplayJob({
      id: "j",
      status: "failed",
      last_error: "sink gone",
    })!;
    expect(replayJobLine(job)).toContain("sink gone");
  });
});
