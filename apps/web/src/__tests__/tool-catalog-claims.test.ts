// SPDX-License-Identifier: AGPL-3.0-only
//
// Two tool surfaces are described in public copy, and both had a way to lie.
//
// 1. The NATIVE agent-tool registry. apps/api already gates it: the checked-in
//    native_manifest.json must match the in-code registry or `genagenttools
//    -check` fails CI. But nothing tied that governed number to the /developers
//    page, which claimed "22 tools (registry version 22)" while the registry
//    shipped 59 — on the page whose subject is that the registry is governed.
//    ("registry version 22" was doubly wrong: agent tools have no version
//    concept at all; only reporting metrics and segments do.)
//
// 2. The MCP catalog (src/lib/mcp-tools.json) is a checked-in copy of the tools
//    packages/mcp-server actually registers, and it is the sole source for the
//    /docs/skills pages, the /mcp catalogue, and the /developers count. It has
//    drifted before — 211 catalog entries against 228 real tools, which shipped
//    8 phantom skill pages for tools that did not exist and silently hid 25
//    real ones, including the whole transactional-email family. It is in sync
//    today; this is the gate that keeps it that way.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

interface NativeTool {
  name: string;
}
interface CatalogTool {
  name: string;
  category: string;
}

const nativeManifest = JSON.parse(
  readFileSync(
    join(REPO, "apps/api/internal/agenttools/native_manifest.json"),
    "utf8",
  ),
) as NativeTool[];

const catalog = JSON.parse(
  readFileSync(join(SRC, "lib/mcp-tools.json"), "utf8"),
) as CatalogTool[];

/** Every source file that could publish a tool-surface claim. */
function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Tool names registered by the MCP server itself. */
function serverToolNames(): Set<string> {
  const dir = join(REPO, "packages/mcp-server/src/tools");
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    for (const m of text.matchAll(/name:\s*"([a-z0-9_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

describe("published tool-surface claims", () => {
  it("reads both registries", () => {
    // Guard the guard: a moved manifest or renamed tools directory must fail
    // loudly rather than let the comparisons below pass against empty sets.
    expect(nativeManifest.length).toBeGreaterThan(10);
    expect(catalog.length).toBeGreaterThan(10);
    expect(serverToolNames().size).toBeGreaterThan(10);
  });

  it("states the real native tool count on /developers", () => {
    const page = readFileSync(
      join(SRC, "app/(marketing)/developers/page.tsx"),
      "utf8",
    );
    // Both spellings. This originally matched only "<n> tools", so the page's
    // own metadata description — "a 22-tool native registry", hyphenated and
    // singular — sat stale at 22 while the body said 60 in three places and
    // this test passed. That description is the copy that reaches search
    // results and social cards, i.e. the most publicly visible one.
    //
    // The page now interpolates NATIVE_TOOL_COUNT everywhere, so a literal
    // reappearing here is itself the regression.
    const claims = [...page.matchAll(/(\d+)[- ]tools?\b/g)].map((m) =>
      Number(m[1]),
    );
    const interpolations = [...page.matchAll(/\$\{NATIVE_TOOL_COUNT\}/g)].length;
    expect(interpolations).toBeGreaterThan(2); // guard the guard
    for (const claimed of claims) expect(claimed).toBe(nativeManifest.length);
  });

  it("holds the native count in exactly one place, matching the manifest", () => {
    // Three copies existed and were fixed one at a time, because each guard was
    // shaped to the copy in front of it: /developers spelled it in prose, /mcp
    // held it in a constant the prose check could not see, and the developer
    // product shot held it in a data row neither check could see. The count is
    // now a single exported literal — so this checks the literal against the
    // manifest, and separately that nobody has written a second one.
    const stats = readFileSync(join(SRC, "lib/mcp-catalog-stats.ts"), "utf8");
    const declared = /NATIVE_TOOL_COUNT = (\d+)/.exec(stats);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(nativeManifest.length);

    const stale = sourceFiles()
      .filter((f) => f !== join(SRC, "lib/mcp-catalog-stats.ts"))
      .filter((f) => /\b(?:native|agent)[- ]?tools?\b/i.test(readFileSync(f, "utf8")))
      .flatMap((f) => {
        const text = readFileSync(f, "utf8");
        // A number sitting next to the words "native tools", in prose or as a
        // ["Native tools", "22"] pair, is a second copy of the count.
        return [
          ...text.matchAll(/(\d+)\s+native tools/gi),
          ...text.matchAll(/"Native tools",\s*"(\d+)"/gi),
        ]
          .map((m) => Number(m[1]))
          .filter((n) => n !== nativeManifest.length)
          .map((n) => `${f.slice(SRC.length + 1)}: ${n}`);
      });
    expect(stale.sort()).toEqual([]);
  });

  it("does not claim a version the agent registry does not have", () => {
    // native_manifest.json is a flat array with no version field anywhere, so
    // "registry v22" was never a real thing to quote. It outlived its removal
    // from /developers and /mcp inside the product shot's DATA table, which is
    // why this sweeps every source file rather than two named pages.
    //
    // The pattern allows words between "registry" and the version because the
    // first version of it required them adjacent, and the changelog's "tool
    // registry reaches v22 / 22 first-class tools" sailed straight through —
    // the guard passed while the exact claim it exists to prevent was still
    // published. A version claim is a version claim however it is phrased.
    const offenders = sourceFiles()
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return (
          /registry\b[^.\n]{0,40}?\bv(?:ersion)? ?\d+/i.test(text) ||
          /ASSISTANT_REGISTRY_VERSION/.test(text) ||
          /metricLabel:\s*"Registry"/.test(text)
        );
      })
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps the MCP catalog in sync with the server it documents", () => {
    const server = serverToolNames();
    const inCatalog = new Set(catalog.map((t) => t.name));
    const phantoms = [...inCatalog].filter((n) => !server.has(n)).sort();
    const missing = [...server].filter((n) => !inCatalog.has(n)).sort();

    // Phantoms render a skills page for a tool nobody can call; missing tools
    // are real capability the docs never mention.
    expect({ phantoms, missing }).toEqual({ phantoms: [], missing: [] });
  });
});
