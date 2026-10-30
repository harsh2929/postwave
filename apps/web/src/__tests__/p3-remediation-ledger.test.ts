// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Audit = { findings: Array<{ id: string; severity: string }> };

describe("P3 remediation ledger", () => {
  it("contains every and only P3 audit id exactly once", () => {
    const repoRoot = resolve(process.cwd(), "../..");
    const audit = JSON.parse(
      readFileSync(
        resolve(repoRoot, "docs/logic-audit-2026-07/web-findings.json"),
        "utf8",
      ),
    ) as Audit;
    const ledger = readFileSync(
      resolve(repoRoot, "docs/logic-audit-2026-07/web-p3-remediation.md"),
      "utf8",
    );
    const expected = audit.findings
      .filter((finding) => finding.severity === "P3")
      .map((finding) => finding.id)
      .sort();
    const actual = Array.from(
      ledger.matchAll(/^\| ((?:W\d+-[^|]+|GAP-\d+)#\d+) \|/gm),
      (match) => match[1],
    ).sort();

    expect(actual).toHaveLength(103);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toEqual(expected);
  });
});
