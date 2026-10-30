// SPDX-License-Identifier: AGPL-3.0-only
//
// navigator.clipboard.writeText rejects in insecure contexts and when the
// permission is denied, so a copy button that swallows the rejection leaves
// the reader unable to tell a failed write from a mis-click — they walk away
// believing they hold an install command, a webhook secret, or a code sample
// they do not.
//
// Three sites did exactly that with `catch { setCopied(false) }` or
// `catch { /* noop */ }`: the docs CodeBlock copy chrome, and the marketing
// CopyButton / CopyablePre used for the /mcp and /migrate-anywhere install
// snippets. lib/clipboard.ts already reports "copied" | "error" |
// "unavailable" without throwing; they now use it.
//
// Sites that already surfaced failure through a toast (webhook secrets,
// inbound webhooks, Inbox Reality fixes) were left alone — this asserts the
// outcome, not one particular mechanism.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Files that write to the clipboard, however they do it. */
function clipboardSites(): { file: string; text: string }[] {
  return walk(SRC)
    .filter((f) => !f.endsWith("lib/clipboard.ts"))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }))
    .filter(
      ({ text }) =>
        /navigator\.clipboard\.writeText/.test(text) ||
        /copyToClipboard\(/.test(text),
    );
}

describe("clipboard failures are visible to the user", () => {
  const sites = clipboardSites();

  it("finds the clipboard call sites", () => {
    // Guard the guard: an empty list would pass the sweep below trivially.
    expect(sites.length).toBeGreaterThan(4);
  });

  it("never swallows a rejected write", () => {
    // A raw writeText whose catch neither reports nor routes anywhere.
    const SWALLOWED =
      /catch\s*\{\s*(\/\*[^*]*\*\/|\/\/[^\n]*)?\s*(setCopied\(false\);)?\s*\}/;
    const offenders: string[] = [];
    for (const { file, text } of sites) {
      if (!/navigator\.clipboard\.writeText/.test(text)) continue; // uses helper
      if (SWALLOWED.test(text)) offenders.push(file.slice(SRC.length + 1));
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("gives every helper-based site a failure branch", () => {
    const offenders: string[] = [];
    for (const { file, text } of sites) {
      if (!/copyToClipboard\(/.test(text)) continue;
      // Either it inspects the outcome, or it hands it to a toast.
      const inspects =
        /!==\s*"copied"|===\s*"copied"|"error"|"unavailable"|toast\./.test(text);
      if (!inspects) offenders.push(file.slice(SRC.length + 1));
    }
    expect(offenders.sort()).toEqual([]);
  });
});
