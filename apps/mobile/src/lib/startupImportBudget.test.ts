/**
 * Startup-path import budget (NATIVE#58).
 *
 * `src/api/client.ts` is an EAGER barrel: it re-exports runtime values from
 * thirteen resource modules, so importing it for one symbol evaluates the SSE
 * transport (api/eventBus), the AI streaming client (api/aiGenerate) and the
 * whole ops surface. `src/lib/push.ts` needed exactly one symbol — `getClient`
 * — and the root layout imports push at module load, which put all of that on
 * the critical path to first paint.
 *
 * Screens and hooks may still use the barrel; this contract only guards the
 * modules that run BEFORE anything is on screen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const LIB_DIR = join(__dirname);
const STORE_DIR = join(__dirname, "..", "store");
const EAGER_BARREL = /from\s+["']@\/api\/client["']/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

function barrelOffenders(dir: string, marker: string): string[] {
  return sourceFiles(dir)
    .filter((file) => EAGER_BARREL.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(file.indexOf(marker)));
}

describe("startup import budget", () => {
  it("no src/lib module pulls the eager api/client barrel", () => {
    expect(barrelOffenders(LIB_DIR, "src/lib")).toEqual([]);
  });

  /**
   * src/store was the hole in the first cut of this contract: repointing
   * lib/push.ts at the SDK factory achieved nothing while src/store/auth.ts
   * still did `import { clearClient } from "@/api/client"`, because push.ts
   * AND app/_layout.tsx both import the auth store at module load. The barrel
   * therefore stayed on the path to first paint through a second hop.
   */
  it("no src/store module pulls the eager api/client barrel", () => {
    expect(barrelOffenders(STORE_DIR, "src/store")).toEqual([]);
  });

  it("push registration reaches the SDK factory directly", () => {
    const source = readFileSync(join(LIB_DIR, "push.ts"), "utf8");
    expect(source).toContain('from "@/api/sdkClient"');
  });
});
