import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const DESKTOP_DIR = process.cwd();
const OWNERS = [
  "components/audit/AuditRowItem.tsx",
  "components/audit/AuditFilters.tsx",
  "components/audit/AuditProofPath.tsx",
  "components/audit/AuditSinkTables.tsx",
  "components/audit/RetentionEditor.tsx",
  "components/audit/AuditInsightsRow.tsx",
] as const;

function source(path: (typeof OWNERS)[number]): string {
  return readFileSync(`${DESKTOP_DIR}/src/${path}`, "utf8");
}

describe("interactive title remediation wave 5", () => {
  it("keeps all six audit-governance owners at zero intrinsic interactive titles", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/interactive-title-inventory.mjs", "--json"],
      { cwd: DESKTOP_DIR, encoding: "utf8" },
    );
    const inventory = JSON.parse(output) as {
      findings: Array<{ file: string }>;
    };
    expect(
      inventory.findings.filter((finding) =>
        OWNERS.includes(finding.file as (typeof OWNERS)[number]),
      ),
    ).toEqual([]);
  });

  it("preserves visible descriptions, semantic disclosures, and high-zoom containment", () => {
    expect(source("components/audit/AuditFilters.tsx")).toContain(
      "audit-filter-help",
    );
    expect(source("components/audit/AuditFilters.tsx")).toContain(
      "aria-pressed",
    );
    expect(source("components/audit/AuditRowItem.tsx")).toContain(
      "audit-row-filter-verb",
    );
    expect(source("components/audit/AuditProofPath.tsx")).toContain(
      "aria-controls={pathId}",
    );
    expect(source("components/audit/AuditSinkTables.tsx")).toContain(
      "audit-table-scroll",
    );
    expect(source("components/audit/AuditSinkTables.tsx")).not.toMatch(
      /<tr[^>]*role="button"/su,
    );
  });

  it("owns async work, thrown failures, retry, and permission gates", () => {
    const proof = source("components/audit/AuditProofPath.tsx");
    const sinks = source("components/audit/AuditSinkTables.tsx");
    const retention = source("components/audit/RetentionEditor.tsx");
    const insights = source("components/audit/AuditInsightsRow.tsx");

    expect(proof).toContain("operation.promiseRef.current");
    expect(sinks).toContain('ownerId: "audit-sink-dlq-replay"');
    expect(sinks).toContain("const snapshot = entries ? [...entries] : []");
    expect(retention).toContain("loadRequestRef.current");
    expect(retention).toContain("aria-disabled={!canMutate}");
    expect(insights).toContain("uebaRequestRef.current");
    expect(insights).toContain("onRetry");
  });
});
