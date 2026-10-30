// SPDX-License-Identifier: AGPL-3.0-only
//
// The generated operation table has a CONSUMER, and this is it.
//
// A generated module nothing imports is the failure this repository keeps
// meeting: it compiles, it is drift-gated, it looks like infrastructure, and it
// changes nothing. `OPERATIONS` is derived from the curated contract, so it is
// the one place that knows, without anybody maintaining it, which routes the
// SDK's curated surface is supposed to reach. This asserts the hand-written
// resources actually reach them.
//
// It is deliberately a ROUTE check and not a shape check. Shapes are covered by
// `scripts/check-sdk-type-shapes.mjs`, which compares against the full contract;
// duplicating that here would give two answers to one question and eventually
// two different answers.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPERATIONS } from "./operations.js";

const resourcesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");

/** Every resource file's source, concatenated — the SDK's call surface. */
function resourceSources(): string {
  return readdirSync(resourcesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(resourcesDir, f), "utf8"))
    .join("\n");
}

/**
 * A route template as it appears in SDK source.
 *
 * The contract writes `/api/v1/subscribers/{id}`; the SDK writes a template
 * literal, `/api/v1/subscribers/${id}`. Comparing the LITERAL PREFIX up to the
 * first parameter avoids inventing a translation between the two spellings that
 * would itself need testing — and a prefix match is enough to answer "does the
 * SDK talk to this route at all", which is the question here.
 */
function literalPrefix(path: string): string {
  const brace = path.indexOf("{");
  return brace === -1 ? path : path.slice(0, brace);
}

describe("the curated contract's operations are reachable from the SDK", () => {
  const source = resourceSources();

  // Guard the guard: an empty read would pass every assertion below.
  it("reads the resource sources", () => {
    expect(source.length).toBeGreaterThan(10_000);
    expect(Object.keys(OPERATIONS).length).toBeGreaterThanOrEqual(20);
  });

  for (const [operationId, op] of Object.entries(OPERATIONS)) {
    it(`${operationId} (${op.method} ${op.path})`, () => {
      expect(
        source.includes(literalPrefix(op.path)),
        `no resource references ${op.path}. The curated contract declares ` +
          `${op.method} ${op.path}, and a caller reaching for it through this SDK ` +
          `has nothing to call.`,
      ).toBe(true);
    });
  }
});
