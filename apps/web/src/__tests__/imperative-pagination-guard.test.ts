// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const GUARD = resolve(SRC, "lib/infinite-query-action.ts");

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) productionSources(file, out);
    else if (file.endsWith(".ts") || file.endsWith(".tsx")) out.push(file);
  }
  return out;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("imperative infinite-query continuation wiring", () => {
  const files = productionSources(SRC);

  it("has no raw continuation transport outside the shared runtime guard", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === GUARD) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bfetchNextPage\s*\(/gu)) {
        offenders.push(
          `${relative(SRC, file)}:${lineAt(source, match.index!)}`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("guards all 31 continuations across 25 production modules", () => {
    const calls: string[] = [];
    const modules = new Set<string>();
    for (const file of files) {
      if (file === GUARD) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bloadNextQueryPage\s*\(/gu)) {
        const modulePath = relative(SRC, file);
        modules.add(modulePath);
        calls.push(`${modulePath}:${lineAt(source, match.index!)}`);
      }
    }
    expect(calls).toHaveLength(31);
    expect(modules).toHaveLength(25);
    for (const modulePath of modules) {
      expect(readFileSync(resolve(SRC, modulePath), "utf8")).toContain(
        'import { loadNextQueryPage } from "@/lib/infinite-query-action";',
      );
    }
  });
});
