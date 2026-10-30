// SPDX-License-Identifier: AGPL-3.0-only
//
// Asserts that every response field a client READS exists in a recorded real
// response from the endpoint it calls.
//
// WHY THIS EXISTS ALONGSIDE THE VALUE-BASED CONTRACT TEST. That test feeds a
// recorded body through the client and compares parsed values. It is blind
// wherever the real value is falsy: this workspace reports
// `unclassified_replies: 0`, so a client misreading the key as `unclassified`
// gets undefined, coerces it to 0, and the comparison 0 === 0 passes. I proved
// that by mutation — the wrong-key mutant survived.
//
// A structural check does not care about values. If the server sends
// `subject_variants` and a client reads `variants`, the key is simply absent
// from the recorded body and this fails, whatever the data happens to be. That
// is the exact shape of the bug that shipped in ai-compose-api.
//
// Only TOP-LEVEL reads of the response object are checked, and only where the
// client names the field literally (`r?.foo`, `res?.foo`). Nested and computed
// access is out of scope rather than guessed at — a false accusation here
// would be indistinguishable from a real one and would train people to add
// exceptions.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = resolve(process.cwd(), "src/lib");
const FIXTURES = resolve(process.cwd(), "src/__tests__/fixtures/api");

const INDEX = JSON.parse(
  readFileSync(resolve(FIXTURES, "index.json"), "utf8"),
) as Record<string, string>;

function fixtureFor(path: string): Record<string, unknown> | null {
  const file = INDEX[path];
  if (!file) return null;
  const body = JSON.parse(readFileSync(resolve(FIXTURES, file), "utf8"));
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

/**
 * The body of the function that calls `path`, found by brace matching.
 *
 * A fixed character window does NOT work here and I proved it: a 900-char
 * window from one path literal reaches into the next function, so the checker
 * claimed developer-reference-api reads `ops` from the webhook playground
 * endpoint when `ops` belongs to the transforms call directly below it. 64
 * accusations, almost all of them that bleed. Scoping to the enclosing
 * function is what makes the rule sound.
 */
function enclosingFunction(source: string, path: string): string | null {
  const at = source.indexOf(`"${path}"`);
  if (at === -1) return null;

  // Walk back to the nearest function opening brace.
  const head = source.slice(0, at);
  const startMarkers = [
    head.lastIndexOf("export async function"),
    head.lastIndexOf("export function"),
    head.lastIndexOf("async function"),
    head.lastIndexOf("function "),
  ].filter((i) => i !== -1);
  if (startMarkers.length === 0) return null;
  const start = Math.max(...startMarkers);

  const open = source.indexOf("{", start);
  if (open === -1 || open > at) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return at < i ? source.slice(open, i) : null;
      }
    }
  }
  return null;
}

/** Literal top-level reads of the response object inside that function. */
function fieldsReadNear(source: string, path: string): string[] {
  const body = enclosingFunction(source, path);
  if (body === null) return [];
  const reads = new Set<string>();
  for (const m of body.matchAll(/\b(?:r|res|raw|response)\?\.(\w+)/g)) {
    reads.add(m[1]);
  }
  return [...reads];
}

const CLIENTS = readdirSync(LIB).filter((f) => f.endsWith("-api.ts"));

describe("clients read fields the server actually sends", () => {
  it("has clients and fixtures to cross-check", () => {
    // Vacuity floor: if either side is empty the rule below is free.
    expect(CLIENTS.length).toBeGreaterThan(50);
    expect(Object.keys(INDEX).length).toBeGreaterThan(30);
  });

  it("names no field absent from the recorded response", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of CLIENTS) {
      const source = readFileSync(resolve(LIB, file), "utf8");
      for (const path of Object.keys(INDEX)) {
        if (!source.includes(`"${path}"`)) continue;
        const body = fixtureFor(path);
        if (!body) continue;
        for (const field of fieldsReadNear(source, path)) {
          checked += 1;
          if (!(field in body)) {
            offenders.push(`${file} reads "${field}" from ${path}`);
          }
        }
      }
    }

    // Second vacuity floor: prove the scan actually inspected reads. Without
    // this, a regex that stopped matching would report a clean sweep.
    expect(checked).toBeGreaterThan(40);
    expect(offenders.sort()).toEqual([]);
  });

  it("still detects a field the server does not send", () => {
    // Guard the guard, using the shape that shipped: a client reading
    // `variants` from a body whose field is `subject_variants`.
    const body = { subject_variants: [] } as Record<string, unknown>;
    const source = `await api.post("/x", {}); return { v: r?.variants };`;
    const reads = [...source.matchAll(/\b(?:r|res|raw|response)\?\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(reads).toContain("variants");
    expect("variants" in body).toBe(false);
  });
});
