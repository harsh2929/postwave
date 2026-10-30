// SPDX-License-Identifier: AGPL-3.0-only
//
// The OpenAPI description for POST /api/v1/slack/commands offered
// `/postwave campaign-status` as its example. No such subcommand exists —
// slash_commands.go recognises "", "help", "campaigns" and "send", and
// anything else falls through to ":warning: unknown subcommand". That
// description renders on the public API reference at /docs/api/<slug> and
// ships in the MIT-licensed packages/openapi artifact, so the one example a
// reader is most likely to paste was the one guaranteed to fail.
//
// The docs integration page lists the commands separately, in prose, in a
// third place. All three are checked here against the handler.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

/**
 * A published `/postwave <sub>` mention.
 *
 * Two constraints learned from false positives. The separator is [^\S\n]+,
 * not \s+: the spec contains a webhook example whose url ends
 * `https://hooks.acme.com/postwave` with a YAML `events:` key on the next
 * line, and \s+ stitched them into "/postwave events". And the lookbehind
 * rejects that same URL case directly — a slash command is never preceded by
 * a hostname character.
 */
const COMMAND_RE = /(?<![A-Za-z0-9.])\/postwave[^\S\n]+([a-z][a-z0-9-]*)/g;

/** Subcommands the Go handler dispatches on. */
function recognised(): Set<string> {
  const go = readFileSync(
    join(REPO, "apps/api/internal/slackint/slash_commands.go"),
    "utf8",
  );
  const block = /switch sub \{([\s\S]*?)\n\t\}/.exec(go);
  if (!block) return new Set();
  const out = new Set<string>();
  for (const line of block[1]!.split("\n")) {
    const m = /^\s*case (.+):/.exec(line);
    if (!m) continue;
    for (const q of m[1]!.matchAll(/"([^"]*)"/g)) out.add(q[1]!);
  }
  return out;
}

/** Every `/postwave <sub>` published anywhere the web surface renders. */
function published(): { where: string; sub: string }[] {
  const sources: [string, string][] = [
    [
      "openapi spec",
      readFileSync(join(REPO, "packages/openapi/openapi.yaml"), "utf8"),
    ],
    [
      "docs integrations page",
      readFileSync(
        join(SRC, "app/(docs)/docs/integrations/[integration]/page.tsx"),
        "utf8",
      ),
    ],
  ];
  const out: { where: string; sub: string }[] = [];
  for (const [where, text] of sources) {
    for (const m of text.matchAll(COMMAND_RE)) {
      out.push({ where, sub: m[1]! });
    }
  }
  return out;
}

describe("published Slack slash commands", () => {
  const known = recognised();
  const claims = published();

  it("reads the handler and the published copy", () => {
    // Guard the guard: either side empty would make the sweep vacuous, and a
    // parser that missed the switch would report everything as unknown.
    expect(known.has("campaigns")).toBe(true);
    expect(known.has("send")).toBe(true);
    expect(known.has("help")).toBe(true);
    expect(claims.length).toBeGreaterThan(2);
  });

  it("names only subcommands the handler dispatches", () => {
    const unknown = claims
      .filter(({ sub }) => !known.has(sub))
      .map(({ where, sub }) => `${where}: /postwave ${sub}`);
    expect([...new Set(unknown)].sort()).toEqual([]);
  });

  it("keeps the spec's own example runnable", () => {
    // The spec is where a reader is most likely to copy from, so it has to
    // name at least one real subcommand rather than describing the endpoint
    // abstractly.
    const spec = readFileSync(
      join(REPO, "packages/openapi/openapi.yaml"),
      "utf8",
    );
    const line = spec
      .split("\n")
      .find((l) => l.includes("Receives Slack slash-command invocations"));
    expect(line).toBeDefined();
    const named = [...line!.matchAll(COMMAND_RE)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((s) => !known.has(s))).toEqual([]);
  });
});
