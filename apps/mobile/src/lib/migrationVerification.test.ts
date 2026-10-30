/**
 * The verification parser decides what an operator is told about a six-hour
 * import. Two rules carry the weight and both are tested here directly:
 * a missing count is never rendered as zero, and "clean" is hard to earn.
 */
import { describe, expect, it } from "vitest";

import {
  parseMigrationRollback,
  parseMigrationVerification,
  shouldReadRollbackStatus,
  verificationAbsenceCopy,
  verificationRisk,
  verificationRiskCopy,
} from "@/lib/migrationVerification";

describe("parseMigrationVerification", () => {
  it("refuses anything that is not an object", () => {
    expect(parseMigrationVerification(null)).toBeNull();
    expect(parseMigrationVerification("report")).toBeNull();
    expect(parseMigrationVerification([1, 2])).toBeNull();
  });

  it("keeps an absent count absent instead of coercing it to zero", () => {
    const out = parseMigrationVerification({ subscribers_imported: 1200 });
    expect(out?.subscribersImported).toBe(1200);
    // "0 templates imported" is the sentence that sends someone to re-run a
    // migration that was fine.
    expect(out?.templatesImported).toBeNull();
    expect(out?.archiveImported).toBeNull();
    expect(out?.dataLossEstimatePct).toBeNull();
  });

  it("counts warning ARRAYS rather than reading a count field", () => {
    const out = parseMigrationVerification({
      segments_with_warnings: [{ segment: "a" }, { segment: "b" }],
      automations_unsupported: [{ name: "x" }],
      custom_fields_unmapped: ["nickname", "crm_id", "score"],
      custom_fields_mapped: [{ source: "a", target: "b" }],
    });
    expect(out?.segmentWarnings).toBe(2);
    expect(out?.automationsUnsupported).toBe(1);
    expect(out?.customFieldsUnmapped).toBe(3);
    expect(out?.customFieldsMapped).toBe(1);
  });

  it("drops resource rows with no name and keeps the server's own percentage", () => {
    const out = parseMigrationVerification({
      resource_completeness: [
        { resource: "subscribers", imported: 90, expected: 100 },
        { imported: 5 },
        { resource: "archive", completeness: 62.5 },
        { resource: "tags", completeness: 0.5 },
        { resource: "segments", note: "source API paginates unreliably" },
      ],
    });
    expect(out?.resources.map((r) => r.resource)).toEqual([
      "subscribers",
      "archive",
      "tags",
      "segments",
    ]);
    // Derived from the pair.
    expect(out?.resources[0]?.completeness).toBeCloseTo(0.9);
    // A percentage > 1 is read as 0..100 and normalised; 0..1 is left alone.
    expect(out?.resources[1]?.completeness).toBeCloseTo(0.625);
    expect(out?.resources[2]?.completeness).toBeCloseTo(0.5);
    // Neither a pair nor a served value → null, never a fabricated 0%.
    expect(out?.resources[3]?.completeness).toBeNull();
    expect(out?.resources[3]?.note).toBe("source API paginates unreliably");
  });

  it("never divides by a zero denominator", () => {
    const out = parseMigrationVerification({
      resource_completeness: [{ resource: "tags", imported: 0, expected: 0 }],
    });
    expect(out?.resources[0]?.completeness).toBeNull();
  });

  it("keeps only string discovery warnings", () => {
    const out = parseMigrationVerification({
      discovery_warnings: ["rate limited", "", 42, null, "  padded  "],
    });
    expect(out?.discoveryWarnings).toEqual(["rate limited", "padded"]);
  });
});

describe("verificationRisk", () => {
  const clean = parseMigrationVerification({
    subscribers_imported: 10,
    data_loss_estimate_pct: 0,
  })!;

  it("earns 'clean' only with no loss and no warnings", () => {
    expect(verificationRisk(clean)).toBe("clean");
    expect(verificationRiskCopy("clean").headline).toBe("No warnings");
  });

  it("treats any estimated loss as the worst verdict", () => {
    const report = parseMigrationVerification({ data_loss_estimate_pct: 0.4 })!;
    expect(verificationRisk(report)).toBe("loss");
  });

  it("flags a single unsupported automation for review", () => {
    const report = parseMigrationVerification({
      data_loss_estimate_pct: 0,
      automations_unsupported: [{ name: "welcome" }],
    })!;
    expect(verificationRisk(report)).toBe("review");
  });

  it("flags an unmapped field and a discovery warning for review", () => {
    expect(
      verificationRisk(
        parseMigrationVerification({ custom_fields_unmapped: ["x"] })!,
      ),
    ).toBe("review");
    expect(
      verificationRisk(
        parseMigrationVerification({ discovery_warnings: ["rate limited"] })!,
      ),
    ).toBe("review");
  });
});

describe("verificationAbsenceCopy", () => {
  it("says a running job simply has no report yet", () => {
    expect(verificationAbsenceCopy("importing")).toContain(
      "No verification report yet",
    );
    expect(verificationAbsenceCopy(undefined)).toContain(
      "No verification report yet",
    );
  });

  it("does not alarm about a failed job that never got far enough", () => {
    expect(verificationAbsenceCopy("failed")).toContain(
      "failed before a verification report was written",
    );
  });

  it("DOES flag a completed job with no report as unusual", () => {
    expect(verificationAbsenceCopy("completed")).toContain("unusual");
    expect(verificationAbsenceCopy("ROLLED_BACK")).toContain("unusual");
  });
});

describe("rollback status", () => {
  it("is only requested for the two states that have one", () => {
    // The handler RECREATES a rollback worker for a job in `rolling_back`, so
    // asking speculatively would be a side effect rather than a read.
    expect(shouldReadRollbackStatus("rolling_back")).toBe(true);
    expect(shouldReadRollbackStatus("ROLLED_BACK")).toBe(true);
    expect(shouldReadRollbackStatus("completed")).toBe(false);
    expect(shouldReadRollbackStatus("importing")).toBe(false);
    expect(shouldReadRollbackStatus(undefined)).toBe(false);
  });

  it("returns null for a payload carrying nothing to report", () => {
    expect(parseMigrationRollback(null)).toBeNull();
    expect(parseMigrationRollback({})).toBeNull();
    expect(parseMigrationRollback({ unrelated: 1 })).toBeNull();
  });

  it("reads the progress fields under either name", () => {
    expect(
      parseMigrationRollback({ state: "running", deleted: 40, total: 100 }),
    ).toMatchObject({ state: "running", deleted: 40, total: 100 });
    expect(
      parseMigrationRollback({ status: "completed", removed: 12 }),
    ).toMatchObject({ state: "completed", deleted: 12, total: null });
  });

  it("keeps an error even when nothing else is present", () => {
    expect(parseMigrationRollback({ error: "worker died" })).toMatchObject({
      error: "worker died",
      state: null,
    });
  });
});
