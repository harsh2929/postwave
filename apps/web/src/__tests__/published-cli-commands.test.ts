// SPDX-License-Identifier: AGPL-3.0-only
//
// Copy-pasteable first-party CLI commands are published on reviewed integration
// pages. The release-held MCP pages deliberately publish none. The remaining
// commands are executable instructions: a visitor pastes one into a terminal,
// and a wrong subcommand or a flag the binary doesn't accept fails on the very
// first thing they try.
//
// Nothing connected the two sides. The registry lives in packages/cli, which
// apps/web neither imports nor builds against, so a renamed subcommand or a
// dropped flag would leave the published copy silently stale.
//
// One shape note, learned the hard way while writing this: the CLI registers
// most commands as
//
//     cli
//       .command(
//         "integrations native runs <family> <id>",
//
// so a line-based grep for `.command("` finds only the handful declared on a
// single line — it reported `integrations native` as unknown when eleven such
// subcommands exist. The parser below chunks on `.command(` and reads the name
// across the newline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const CLI_SRC = resolve(process.cwd(), "../../packages/cli/src");

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(p)) out.push(p);
  }
  return out;
}

interface Registry {
  /** command signature → the long flags it accepts */
  commands: Map<string, Set<string>>;
  /** flags accepted by every command */
  globals: Set<string>;
}

function cliRegistry(): Registry {
  const commands = new Map<string, Set<string>>();
  const globals = new Set<string>();
  for (const file of walk(CLI_SRC, /\.ts$/)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bcli\.option\(\s*"(--[a-z0-9-]+)/g)) {
      globals.add(m[1]!);
    }
    // Each `.command(` starts a chain; everything up to the next one is that
    // command's own `.option(` calls.
    const starts = [...text.matchAll(/\.command\(/g)].map((m) => m.index!);
    starts.forEach((start, i) => {
      const chunk = text.slice(start, starts[i + 1] ?? text.length);
      const name = /^\.command\(\s*\n?\s*"([^"]+)"/.exec(chunk);
      if (!name) return;
      commands.set(
        name[1]!,
        new Set(
          [...chunk.matchAll(/\.option\(\s*\n?\s*"(--[a-z0-9-]+)/g)].map(
            (m) => m[1]!,
          ),
        ),
      );
    });
  }
  return { commands, globals };
}

/** The literal words of a signature — "migrate [source]" → "migrate". */
function literalPrefix(signature: string): string {
  return signature
    .split(/\s+/)
    .filter((t) => !/^[<[]/.test(t))
    .join(" ");
}

/**
 * Command lines we publish. A line qualifies when `postwave` opens a line (in
 * a code block or a quoted array entry) or follows a backtick that opens a
 * template literal — which keeps prose out: the blog page's SEO comment lists
 * the phrase "postwave blog" mid-sentence, and lib/integrations.ts logs
 * "postwave webhook received" inside a sample handler. Neither is a command.
 */
function publishedCommands(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const file of walk(SRC, /\.tsx?$/)) {
    // Join backslash-continued lines so flags on wrapped lines get checked.
    const text = readFileSync(file, "utf8").replace(/\\\\\n[ \t]*/g, " ");
    for (const m of text.matchAll(
      /(?:^[ \t]*["']?|`)(postwave [a-z][^"'`\n]*)/gm,
    )) {
      out.push({ file: file.slice(SRC.length + 1), line: m[1]!.trim() });
    }
  }
  return out;
}

describe("published CLI commands", () => {
  const { commands, globals } = cliRegistry();
  const byPrefix = new Map(
    [...commands].map(([sig, opts]) => [literalPrefix(sig), { sig, opts }]),
  );
  const published = publishedCommands();

  it("reads both sides", () => {
    // Guard the guard: a parser that silently returns nothing would make the
    // sweep below pass while checking no command at all.
    expect(commands.size).toBeGreaterThan(100);
    expect(globals.has("--output")).toBe(true);
    // Route 39 removed the formerly runnable MCP install commands. Five
    // reviewed integration commands remain; dropping any of those must still
    // make this guard fail rather than silently shrinking the sweep.
    expect(published.length).toBeGreaterThanOrEqual(5);
    // The multi-line `.command(` shape must survive parsing — this exact
    // command is published on the Stripe docs page.
    expect(byPrefix.has("integrations native runs")).toBe(true);
    // And per-command flags must actually be collected, or the flag assertion
    // below would accept anything.
    expect(byPrefix.get("migrate")?.opts.has("--dry-run")).toBe(true);
  });

  it("names a subcommand the binary registers", () => {
    const unknown = published
      .filter(({ line }) => {
        const tokens = line.split(/\s+/).slice(1);
        for (let k = Math.min(5, tokens.length); k >= 1; k--) {
          if (byPrefix.has(tokens.slice(0, k).join(" "))) return false;
        }
        return true;
      })
      .map(({ file, line }) => `${file}: ${line}`);
    expect(unknown.sort()).toEqual([]);
  });

  it("passes only flags that command accepts", () => {
    const wrong: string[] = [];
    for (const { file, line } of published) {
      const tokens = line.split(/\s+/).slice(1);
      let match: { sig: string; opts: Set<string> } | undefined;
      for (let k = Math.min(5, tokens.length); k >= 1 && !match; k--) {
        match = byPrefix.get(tokens.slice(0, k).join(" "));
      }
      if (!match) continue; // reported by the test above
      for (const m of line.matchAll(/\s(--[a-z0-9-]+)/g)) {
        const flag = m[1]!;
        if (!match.opts.has(flag) && !globals.has(flag)) {
          wrong.push(`${file}: "${match.sig}" has no ${flag} — ${line}`);
        }
      }
    }
    expect(wrong.sort()).toEqual([]);
  });
});
