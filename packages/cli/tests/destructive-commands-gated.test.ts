// SPDX-License-Identifier: MIT
//
// Destructive CLI commands must require --yes, and the handler must actually
// check it.
//
// @postwave/cli is installed globally and run against production with a live
// API key. `postwave lists delete <id>` cascades; there is no undo, and the
// terminal it runs in has no confirmation dialog to fall back on. Every
// destructive command today declares `--yes` and every handler enforces it
// with a non-zero exit — this keeps the next one from shipping with the flag
// documented but unread, which is worse than no flag at all because the help
// text promises a safety net that isn't there.
//
// The CLI deliberately uses --yes with two different meanings, and both are
// right:
//
//   * destructive commands REQUIRE it and never prompt, so a script in CI
//     fails closed instead of hanging on a TTY read that will never come;
//   * `segments from-text` treats it as "skip the prompt", because creating a
//     segment is safe to confirm interactively.
//
// So this checks the destructive set specifically rather than every --yes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const INDEX = readFileSync(join(ROOT, "src/index.ts"), "utf8");

/** Every `.command("…")` with its options block and action handler. */
interface Command {
  name: string;
  block: string;
  handler: string | null;
}

function commands(): Command[] {
  const out: Command[] = [];
  // `[^)]*` stopped at the first ")" — which is the callback's own
  // parameter list, before the arrow — so every handler resolved to null
  // and the enforcement check silently degraded to "no resolvable
  // handler" for all of them. Capture to the end of the line instead.
  const re = /\.command\(\s*\n?\s*"([^"]+)"[\s\S]*?\.action\((.*)\);/g;
  for (const m of INDEX.matchAll(re)) {
    const handler = /=>\s*(\w+)\(/.exec(m[2] ?? "")?.[1] ?? null;
    out.push({ name: m[1]!, block: m[0]!, handler });
  }
  return out;
}

/** Source of every command module, keyed by exported function name. */
function handlerSources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".ts")) continue;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\n\}/g,
      )) {
        found.set(m[1]!, m[0]!);
      }
    }
  };
  walk(join(ROOT, "src"));
  return found;
}

const DESTRUCTIVE = /\b(delete|remove|purge|destroy|erase|wipe|reset)\b/i;

describe("destructive CLI commands", () => {
  const all = commands();
  const sources = handlerSources();

  it("parses the command table", () => {
    // Guard the guard: a regex that stopped matching would report a fully
    // gated CLI, which is exactly the wrong way for this to fail.
    expect(all.length).toBeGreaterThan(30);
    expect(sources.size).toBeGreaterThan(20);
    expect(all.some((c) => c.name === "subscribers delete <id>")).toBe(true);
  });

  it("declares --yes on every destructive command", () => {
    const missing = all
      .filter((c) => DESTRUCTIVE.test(c.name))
      .filter((c) => !c.block.includes('"--yes"'))
      .map((c) => c.name);
    expect(missing.sort()).toEqual([]);
  });

  it("enforces --yes in the handler, not just in the help text", () => {
    // A documented flag nobody reads is worse than no flag: the help promises
    // a confirmation step that does not exist.
    const unenforced: string[] = [];
    for (const cmd of all) {
      if (!DESTRUCTIVE.test(cmd.name)) continue;
      if (!cmd.handler) {
        unenforced.push(`${cmd.name} (no resolvable handler)`);
        continue;
      }
      const src = sources.get(cmd.handler);
      if (!src) {
        unenforced.push(`${cmd.name} → ${cmd.handler} (source not found)`);
        continue;
      }
      if (!/opts\.yes/.test(src)) {
        unenforced.push(`${cmd.name} → ${cmd.handler} never reads opts.yes`);
      }
    }
    expect(unenforced.sort()).toEqual([]);
  });

  it("fails closed rather than prompting, on the destructive path", () => {
    // A destructive command that prompts would hang forever under CI, where
    // stdin is not a TTY — so these must reject and exit, not ask.
    const prompting: string[] = [];
    for (const cmd of all) {
      if (!DESTRUCTIVE.test(cmd.name) || !cmd.handler) continue;
      const src = sources.get(cmd.handler);
      if (!src) continue;
      if (/prompts\s*\(/.test(src)) prompting.push(`${cmd.name} → ${cmd.handler}`);
      if (!/process\.exitCode\s*=\s*[1-9]/.test(src)) {
        prompting.push(`${cmd.name} → ${cmd.handler} does not set a failing exit code`);
      }
    }
    expect(prompting.sort()).toEqual([]);
  });
});
