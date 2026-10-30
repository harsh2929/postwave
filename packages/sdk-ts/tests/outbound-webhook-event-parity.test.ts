// The public outbound-webhook event vocabulary, held to its Go authority.
//
// WHY THIS SURFACE AND NOT THE OTHER ONE. There are two webhook systems in this
// repo, deliberately separate (see the header of
// apps/api/internal/outbound_webhooks): the internal `webhooks` package drives
// Moosewave's own product webhooks, and `outbound_webhooks` is the PUBLIC
// integration surface that Zapier and third parties configure. They carry
// different event catalogs -- 24 and 15 entries -- and comparing the SDK
// against the wrong one manufactures a drift report where there is none. This
// guard names its authority explicitly for that reason.
//
// WHY IT EXISTS. The SDK's list is hand-mirrored: nothing derives it, and
// nothing checked it. It happens to be exactly right today, which is precisely
// when a parity guard is free to add. Written after a divergence, it is a bug
// report and a migration.
//
// WHAT DRIFT COSTS HERE, IN BOTH DIRECTIONS:
//   - Go-only event: a real event no SDK user can subscribe to, because the
//     union will not let them name it. It looks like a missing feature.
//   - SDK-only event: worse. `validateEvents` rejects unknown types, so the
//     subscription call fails -- the SDK offers an event the API refuses, and
//     the type system promises it will work.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OUTBOUND_WEBHOOK_EVENT_TYPES } from "../src/types.js";

const GO = resolve(
  __dirname,
  "../../../apps/api/internal/outbound_webhooks/outbound_webhooks.go",
);

/**
 * The AllowedEvents slice, resolved through its constants.
 *
 * Entries are written two ways -- bare string literals and Event* constant
 * references -- so a literal-only scan silently sees a fraction of the list and
 * the comparison passes for the wrong reason.
 */
function goAllowedEvents(): string[] {
  const src = readFileSync(GO, "utf8");
  const block = /AllowedEvents\s*=\s*\[\]string\{(.*?)\n\}/s.exec(src);
  if (!block?.[1]) throw new Error("AllowedEvents slice not found — the guard cannot see its subject");

  const constants = new Map<string, string>();
  for (const m of src.matchAll(/(Event\w+)\s*(?:EventType)?\s*=\s*"([a-z_.]+)"/g)) {
    constants.set(m[1]!, m[2]!);
  }

  const values: string[] = [];
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    const literal = /^"([a-z_.]+)",?$/.exec(line);
    if (literal) {
      values.push(literal[1]!);
      continue;
    }
    for (const ref of line.matchAll(/(Event\w+)/g)) {
      const resolved = constants.get(ref[1]!);
      if (!resolved) throw new Error(`AllowedEvents references ${ref[1]} but no constant defines it`);
      values.push(resolved);
    }
  }
  if (values.length === 0) throw new Error("AllowedEvents parsed to zero entries");
  return [...new Set(values)].sort();
}

describe("outbound webhook event parity", () => {
  it("offers exactly the events the public API accepts", () => {
    expect([...OUTBOUND_WEBHOOK_EVENT_TYPES].sort()).toEqual(goAllowedEvents());
  });

  it("says which direction drifted", () => {
    // Widened to string[] deliberately: the SDK constant is a narrow union, and
    // .includes() on it rejects the plain strings parsed out of Go. Comparing
    // two vocabularies means treating both as vocabularies.
    const ts: string[] = [...OUTBOUND_WEBHOOK_EVENT_TYPES].sort();
    const go = goAllowedEvents();
    expect({
      offeredButRejectedByTheAPI: ts.filter((e) => !go.includes(e)),
      acceptedButNotOfferedBySDK: go.filter((e) => !ts.includes(e)),
    }).toEqual({ offeredButRejectedByTheAPI: [], acceptedButNotOfferedBySDK: [] });
  });

  it("resolved constant references, not just bare literals", () => {
    // Guards the guard. AllowedEvents mixes literals and Event* references; a
    // parser that only saw literals would compare a fraction of the list and
    // pass vacuously. At least one entry must have arrived via a constant.
    const src = readFileSync(GO, "utf8");
    const block = /AllowedEvents\s*=\s*\[\]string\{(.*?)\n\}/s.exec(src)![1]!;
    const refLines = block
      .split("\n")
      .filter((l) => /^\s*Event\w+,?\s*$/.test(l)).length;
    expect(refLines).toBeGreaterThan(0);
    expect(goAllowedEvents().length).toBeGreaterThanOrEqual(10);
  });
});
