// SPDX-License-Identifier: AGPL-3.0-only
//
// Controlled mailbox capacity is deployment state. The repository contains a
// small credential-free fixture and production has a separate live-capacity
// gate, so public copy must never turn either value into a present-tense fleet
// claim. This guard scans every public marketing/campaign-assurance copy source
// rather than pinning prose to an internal release minimum.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(process.cwd());
const REPO = resolve(WEB, "../..");

function walk(path: string, out: string[] = []): string[] {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else if (/\.(?:ts|tsx|json|md)$/.test(path)) {
    out.push(path);
  }
  return out;
}

function publicCopyFiles(): string[] {
  return [
    ...walk(join(WEB, "src/app/(marketing)")),
    ...walk(join(WEB, "src/components/marketing")),
    join(WEB, "src/components/tour/tours/marketing.ts"),
    ...walk(join(WEB, "locales")),
    join(WEB, "src/lib/integrations.ts"),
    join(WEB, "src/lib/mcp-tools.json"),
    join(WEB, "src/lib/mcp-tool-details.generated.json"),
    join(REPO, "packages/mcp-server/README.md"),
    join(REPO, "packages/mcp-server/src/tools/deliverability.ts"),
    join(REPO, "apps/api/internal/apikeycalls/tool-catalog.json"),
    ...walk(join(REPO, "docs-site/pages")),
  ];
}

const FIXED_SEED_FLEET =
  /(?:\b\d+\s*[- ]\s*(?:real\s+)?(?:seed(?:list)?[- ]?)?(?:inboxes?|mailboxes?)\b|\b\d+\s*[- ]\s*seedlist\b|\b\d+\s+(?:real\s+)?(?:seed(?:list)?\s+)?(?:inboxes?|mailboxes?)\b|\b\d+\/\d+\b[^\n.]{0,40}\bseedlist\b)/gi;
const FIXED_PROVIDER_SPLIT =
  /\b(?:gmail|outlook(?:\.com)?|o365|icloud|yahoo|proton|gmx|mail\.ru)\b\s*\((?:x|×)\d+\)/gi;

function violations(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of publicCopyFiles()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      found.push(`${file.slice(REPO.length + 1)}: ${match[0]}`);
    }
  }
  return found;
}

describe("controlled seedlist public claims", () => {
  it("does not publish a fixed mailbox fleet size", () => {
    expect(violations(FIXED_SEED_FLEET)).toEqual([]);
  });

  it("does not publish an unverified fixed provider split", () => {
    expect(violations(FIXED_PROVIDER_SPLIT)).toEqual([]);
  });

  it("describes observed deployment state instead", () => {
    const references = publicCopyFiles()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .match(/active (?:controlled )?seed roster/gi);
    expect(references?.length ?? 0).toBeGreaterThan(5);
  });
});
