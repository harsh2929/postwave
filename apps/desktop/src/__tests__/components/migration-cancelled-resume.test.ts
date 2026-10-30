/**
 * migration-cancelled-resume — gating for the restored Resume action
 * (POST /migrations/{id}/resume).
 *
 * The server persists an operator cancel as status="failed" plus an
 * error like "migration cancelled by operator" — there is no distinct
 * "cancelled" status on the wire. `isCancelledJob` is the single
 * classifier both the detail-modal banner and the resume confirm rely
 * on; a false positive offers Resume on a genuinely-failed job (where
 * the endpoint 409s), a false negative hides the only recovery path.
 */

import { describe, expect, it } from "vitest";

import { isCancelledJob } from "../../components/migration/cancelledJob";

describe("isCancelledJob", () => {
  it("matches the persisted operator-cancel shape", () => {
    expect(
      isCancelledJob({
        status: "failed",
        error: "migration cancelled by operator",
      }),
    ).toBe(true);
  });

  it("matches case-insensitively and mid-sentence", () => {
    expect(
      isCancelledJob({ status: "failed", error: "Cancelled at checkpoint 3" }),
    ).toBe(true);
  });

  it("ignores non-failed statuses, even with a cancel-ish error", () => {
    expect(
      isCancelledJob({ status: "importing", error: "cancel requested" }),
    ).toBe(false);
    expect(
      isCancelledJob({ status: "completed", error: "cancelled earlier" }),
    ).toBe(false);
  });

  it("ignores failed jobs with unrelated errors", () => {
    expect(
      isCancelledJob({ status: "failed", error: "source API returned 500" }),
    ).toBe(false);
    expect(isCancelledJob({ status: "failed", error: null })).toBe(false);
    expect(isCancelledJob({ status: "failed" })).toBe(false);
  });
});
