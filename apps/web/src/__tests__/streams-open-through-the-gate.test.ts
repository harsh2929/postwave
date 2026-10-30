// SPDX-License-Identifier: AGPL-3.0-only
//
// Every server-sent-event stream in the app opens through the one gate.
//
// An EventSource is a high-priority request. On a connection Chrome rates as
// slow it queues ahead of the lazy chunks and first queries a page needs to
// become interactive, and a stream never completes — which is how a cold
// dashboard load spent 18–22 seconds with its "Preparing your workspace…"
// overlay up and every click swallowed. lib/realtime/stream-gate.ts defers the
// first open until the page has loaded and gone idle once.
//
// The fix only holds while it has no way around it, and the next stream someone
// adds is the way around it. This walks the runtime source and requires every
// file that constructs an EventSource to go through the gate. Its limit is
// honest: it proves the gate is in the file, not that the construction is
// lexically inside the callback, which would need a parser. Timing itself is
// proved in realtime-stream-gate.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

/** The token that constructs a stream, and the gate it must come through. */
const CONSTRUCTS_A_STREAM = "new EventSource(";
const THROUGH_THE_GATE = "whenStreamsMayOpen";

/**
 * Comments removed so a doc comment that merely MENTIONS `new EventSource(...)`
 * is not read as one (lib/audit-investigations-api.ts documents the URL it
 * builds for one, and constructs nothing).
 *
 * Line comments go first. A `//` comment containing an unclosed `/*` would
 * otherwise let the block stripper run from inside it to the next `*` + `/`
 * anywhere below, deleting real code — and a guard that deletes the code it is
 * checking passes for the wrong reason.
 */
function withoutComments(source: string): string {
  return source
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // The tests themselves stub EventSource; they are not runtime code.
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

describe("server-sent event streams", () => {
  const openers = sourceFiles(SRC)
    .map((path) => ({ path, code: withoutComments(readFileSync(path, "utf8")) }))
    .filter((file) => file.code.includes(CONSTRUCTS_A_STREAM));

  it("finds the stream openers it is meant to be guarding", () => {
    // A walk that matched nothing would pass the assertion below in silence.
    // These are the six the dashboard and its detail pages open today.
    const relative = openers
      .map((file) => file.path.slice(SRC.length + 1))
      .sort();
    expect(relative).toEqual([
      "app/(dashboard)/app/analytics/page.tsx",
      "app/(dashboard)/app/settings/audit/investigations/_components/use-investigation-stream.ts",
      "lib/campaign-detail-panels-api.ts",
      "lib/live-streams-api.ts",
      "lib/migration-progress-api.ts",
      "lib/realtime/event-bus-client.ts",
    ]);
  });

  it("opens every one of them through the stream gate", () => {
    const ungated = openers
      .filter((file) => !file.code.includes(THROUGH_THE_GATE))
      .map((file) => file.path.slice(SRC.length + 1));
    expect(ungated).toEqual([]);
  });
});
