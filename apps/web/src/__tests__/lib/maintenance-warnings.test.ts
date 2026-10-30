// SPDX-License-Identifier: AGPL-3.0-only
//
// Two failure modes an operations screen invites:
//   - treating a passing validation as "nothing to know", which erases a
//     consent warning the server did send;
//   - treating a zero count as proof a job ran.

import { describe, expect, it } from "vitest";

import {
  jobDidRun,
  validWithCaveats,
  type JobResult,
  type ValidationResult,
} from "@/lib/maintenance-api";

const result = (o: Partial<ValidationResult> = {}): ValidationResult => ({
  valid: true,
  errors: [],
  warnings: [],
  ...o,
});

describe("validation warnings", () => {
  it("flags a passing validation that still carries a warning", () => {
    // The live case: valid, and social answers will be captured without SMS
    // consent handoff.
    expect(
      validWithCaveats(
        result({
          valid: true,
          warnings: [
            "sms_list_id is missing; social answers will be captured without SMS consent handoff",
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a clean pass", () => {
    expect(validWithCaveats(result())).toBe(false);
  });

  it("does not use this signal for a failure", () => {
    // A failing validation is already surfaced by its errors; this predicate
    // exists only for the pass that looks clean and is not.
    expect(
      validWithCaveats(result({ valid: false, warnings: ["something"] })),
    ).toBe(false);
  });
});

describe("did the job run", () => {
  const job = (o: Partial<JobResult> = {}): JobResult => ({
    completed_at: "2026-08-22T08:11:35.219867Z",
    counts: { blocklisted: 0 },
    ...o,
  });

  it("is true for a sweep that ran and found nothing", () => {
    // Zero blocklisted with a completion time means swept, nothing to do.
    expect(jobDidRun(job())).toBe(true);
  });

  it("is false when no completion time came back", () => {
    // Identical zero counts, entirely different meaning.
    expect(jobDidRun(job({ completed_at: "" }))).toBe(false);
  });

  it("does not accept whitespace as a completion time", () => {
    expect(jobDidRun(job({ completed_at: "   " }))).toBe(false);
  });
});
