import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITY_OBSERVATION_OWNERS } from "../../lib/capability-observation-owners";
import { capabilityForSection } from "../../lib/desktop-capabilities";

const srcRoot = resolve(import.meta.dirname, "../../");

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (name === "__tests__" || name.endsWith(".stories.tsx")) return [];
    if (statSync(path).isDirectory()) return productionFiles(path);
    return /\.(?:ts|tsx)$/u.test(name) ? [path] : [];
  });
}

function reporterCalls(source: string): Array<{ section: string; owner: string }> {
  return [...source.matchAll(
    /useCapabilityReporter\(\s*"([A-Za-z]+)"\s*,\s*"([a-z0-9.-]+)"\s*[,)]/gu,
  )].map((match) => ({ section: match[1]!, owner: match[2]! }));
}

describe("runtime capability observation owners", () => {
  it("pins each authoritative reporter to one unique bounded owner", () => {
    const keys = new Set<string>();
    for (const entry of CAPABILITY_OBSERVATION_OWNERS) {
      const key = `${entry.section}:${entry.owner}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      expect(entry.owner).toMatch(/^[a-z0-9.-]{1,64}$/u);
      expect(entry.evidence.length).toBeGreaterThan(20);

      const source = readFileSync(resolve(srcRoot, entry.source), "utf8");
      expect(reporterCalls(source)).toContainEqual({
        section: entry.section,
        owner: entry.owner,
      });
    }
  });

  it("fails when production adds an undeclared reporter", () => {
    const declared = new Set(
      CAPABILITY_OBSERVATION_OWNERS.map(
        (entry) => `${entry.section}:${entry.owner}`,
      ),
    );
    const discovered = productionFiles(srcRoot).flatMap((path) =>
      reporterCalls(readFileSync(path, "utf8")).map(
        (call) => `${call.section}:${call.owner}`,
      ),
    );
    expect(new Set(discovered)).toEqual(declared);
  });

  it("uses partial impact only on destinations with an enterable mixed scope", () => {
    for (const entry of CAPABILITY_OBSERVATION_OWNERS) {
      if (entry.impact !== "partial") continue;
      const readiness = capabilityForSection(entry.section).readiness;
      expect(["mixed", "conditional"]).toContain(readiness);
    }
  });
});
