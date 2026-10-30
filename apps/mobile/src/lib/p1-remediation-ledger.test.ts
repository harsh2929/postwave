import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Audit = { findings: { id: string; severity: string }[] };

describe("mobile P1 remediation ledger", () => {
  it("contains every and only mobile P1 audit id exactly once", () => {
    const repoRoot = resolve(process.cwd(), "../..");
    const audit = JSON.parse(
      readFileSync(
        resolve(repoRoot, "docs/logic-audit-2026-07/mobile-findings.json"),
        "utf8",
      ),
    ) as Audit;
    const ledger = readFileSync(
      resolve(repoRoot, "docs/logic-audit-2026-07/mobile-p1-remediation.md"),
      "utf8",
    );
    const expected = audit.findings
      .filter((finding) => finding.severity === "P1")
      .map((finding) => finding.id)
      .sort();
    const actual = Array.from(
      ledger.matchAll(/^\| ((?:M\d+-[^|]+|GAP-\d+)#\d+) \|/gm),
      (match) => match[1],
    ).sort();

    expect(actual).toHaveLength(13);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toEqual(expected);
  });
});
