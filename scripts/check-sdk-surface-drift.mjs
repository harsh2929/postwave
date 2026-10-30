#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The curated surface spec and the TypeScript SDK must describe the same API.
//
// `packages/openapi/surfaces/openapi.yaml` is the 27-operation slice declared as
// the SDK's contract, and `packages/sdk-ts` is hand-written against it — its own
// header says "Hand-mirrored from packages/openapi/openapi.yaml". Two hand-kept
// descriptions of one wire contract is this repo's dominant defect class, and
// nothing compared them: `check-sdk-parity.mjs` compares the THREE SDKs to each
// other, so all three drifting from the spec together is invisible to it.
//
// It had drifted. Five of the 27 curated operations had no SDK method at all:
// `updateList` (the SDK could create and enumerate lists but not rename one),
// `getSegmentBestSendTime` and `getSegmentSendTimeHeatmap`, and both public
// archive reads. An integration hitting any of those had to reach past the
// client it was given.
//
// WHAT THIS IS NOT. It is not codegen. Generating the SDK from the spec is the
// stated end state and would make drift impossible rather than merely visible;
// this makes it fail loudly, which is the part that holds while the generator
// does not exist. The gap between those two is recorded rather than papered
// over — see the ledger row.
//
// Run: node scripts/check-sdk-surface-drift.mjs [--self-test]

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "packages/openapi/surfaces/openapi.yaml";
const SDK_RESOURCES = "packages/sdk-ts/src/resources";

// The curated surface is 27 operations. A floor rather than an equality so
// ADDING one does not fail the build — the drift check itself covers additions,
// since a new operation with no SDK method is exactly what it reports.
const MIN_EXPECTED_OPERATIONS = 20;

/**
 * Operations declared by the curated spec, as (METHOD, path).
 *
 * Parsed with a line matcher rather than a YAML library on purpose: this file
 * must run with no dependency install, in the same shell as the other guards,
 * and the two shapes it needs (a path key at two-space indent, a verb key at
 * four) are stable and checked by the self-test.
 */
export function specOperations(source) {
  const ops = [];
  let path = null;
  for (const line of source.split("\n")) {
    const pathMatch = /^ {2}(\/\S+):\s*$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    // A top-level key ends the current path block; without this a verb nested
    // under `components:` would be attributed to the last path seen.
    if (/^\S/.test(line)) {
      path = null;
      continue;
    }
    const verbMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (verbMatch && path) ops.push({ method: verbMatch[1].toUpperCase(), path });
  }
  return ops;
}

/**
 * Normalises a route so a spec template and a TS template literal compare equal.
 *
 * `/api/v1/lists/{id}` and `` `/api/v1/lists/${encodeURIComponent(id)}` `` are
 * the same route; the parameter NAME is not part of the contract's identity,
 * so both collapse to `{}`.
 */
export function normalizeRoute(path) {
  return path
    .replace(/\$\{[^}]*\}/g, "{}")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/\/+$/, "");
}

/**
 * Strips comments so a commented-out call cannot satisfy a link.
 *
 * String-literal aware, because the routes themselves are quoted and a `//`
 * inside one (`"https://…"`) would otherwise open a fake line comment and eat
 * the rest of the file. Scanning line-vs-block by whichever opens FIRST, since
 * a `/*` inside a line comment must not open a block.
 *
 * WHAT THIS STILL CANNOT SEE: a call in an unreachable function, or a route
 * string sitting in an unused constant. Both satisfy this gate while breaking
 * nothing and fixing nothing. Closing that needs real TS analysis; the gate's
 * claim is "this route is referenced somewhere in the resource layer", and that
 * is the claim to read it as.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      if (end === -1) return out;
      out += "\n";
      i = end + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return out;
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** (METHOD, path) pairs the SDK actually calls. */
export function sdkCalls(sources) {
  const calls = new Set();
  // `\s*` spans newlines, which matters: several resources put the method and
  // path on separate lines, and a line-anchored pattern would miss them and
  // report a present method as missing.
  const pattern =
    /request(?:<[^>]*>)?\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*[`"]([^`"]+)[`"]/g;
  for (const raw of sources) {
    const source = stripComments(raw);
    for (const m of source.matchAll(pattern)) {
      calls.add(`${m[1]} ${normalizeRoute(m[2])}`);
    }
  }
  return calls;
}

function readSdkSources() {
  const dir = resolve(repoRoot, SDK_RESOURCES);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

export function findDrift(specSource, sdkSources) {
  const ops = specOperations(specSource);
  const calls = sdkCalls(sdkSources);
  const missing = ops.filter(
    (op) => !calls.has(`${op.method} ${normalizeRoute(op.path)}`),
  );
  return { total: ops.length, missing };
}

function selfTest() {
  const cases = [];
  const ok = (name, pass) => cases.push({ name, pass });

  const spec = [
    "paths:",
    "  /api/v1/things:",
    "    get:",
    "      operationId: listThings",
    "    post:",
    "      operationId: createThing",
    "  /api/v1/things/{id}:",
    "    patch:",
    "      operationId: updateThing",
    "components:",
    "  schemas:",
    "    Thing:",
    "      get: not-an-operation",
  ].join("\n");

  ok("parses each verb under each path", specOperations(spec).length === 3);

  // A verb-shaped key under `components:` must not be read as an operation.
  ok(
    "a top-level key ends the path block",
    !specOperations(spec).some((o) => o.path === "/api/v1/things/{id}" && o.method === "GET"),
  );

  ok(
    "a template literal matches a spec parameter",
    normalizeRoute("/api/v1/lists/${encodeURIComponent(id)}") ===
      normalizeRoute("/api/v1/lists/{id}"),
  );

  ok(
    "a multi-line request call is found",
    sdkCalls([
      'this.client.request(\n  "GET",\n  `/api/v1/things/${id}`,\n);',
    ]).has("GET /api/v1/things/{}"),
  );

  ok(
    "a generic type argument does not hide the call",
    sdkCalls(['request<Thing>("POST", "/api/v1/things")']).has("POST /api/v1/things"),
  );

  ok(
    "a commented-out call does not satisfy the gate",
    findDrift(spec, [
      '// request("GET", "/api/v1/things")',
      'request("POST", "/api/v1/things")',
      'request("PATCH", `/api/v1/things/${id}`)',
    ]).missing.length === 1,
  );

  ok(
    "a block-commented call does not satisfy the gate",
    findDrift(spec, [
      '/* request("GET", "/api/v1/things") */',
      'request("POST", "/api/v1/things")',
      'request("PATCH", `/api/v1/things/${id}`)',
    ]).missing.length === 1,
  );

  ok(
    "a URL inside a string does not open a comment",
    sdkCalls(['const base = "https://api.test";\nrequest("GET", "/api/v1/things")'])
      .has("GET /api/v1/things"),
  );

  // The load-bearing case: a declared operation with no SDK method must be
  // reported, or this whole file is decoration.
  const drift = findDrift(spec, ['request("GET", "/api/v1/things")']);
  ok("an unimplemented operation is reported", drift.missing.length === 2);

  ok(
    "a fully implemented surface reports no drift",
    findDrift(spec, [
      'request("GET", "/api/v1/things")',
      'request("POST", "/api/v1/things")',
      'request("PATCH", `/api/v1/things/${id}`)',
    ]).missing.length === 0,
  );

  for (const c of cases) console.log(`${c.pass ? "  ok  " : "  FAIL"}  ${c.name}`);
  const failed = cases.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`\nself-test: ${failed.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nself-test: ${cases.length}/${cases.length} passed`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const { total, missing } = findDrift(
    readFileSync(resolve(repoRoot, SPEC), "utf8"),
    readSdkSources(),
  );
  // A parse that finds NOTHING must not read as a clean sweep.
  //
  // Pointed at the repo's own openapi.JSON — the same contract, other format,
  // which CI already round-trips — this reported "0/0 implemented" and exited
  // 0. So did an empty file and garbage. A guard whose failure mode is
  // indistinguishable from total success is worse than absent, because it is
  // the one people stop reading.
  if (total < MIN_EXPECTED_OPERATIONS) {
    console.error(
      `Parsed only ${total} operations from ${SPEC}, expected at least ` +
        `${MIN_EXPECTED_OPERATIONS}. The spec did not parse — a format change, ` +
        `a $ref'd path item, or the wrong file — and "0 missing" here would ` +
        `mean nothing was checked rather than everything passed.`,
    );
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(
      `The TypeScript SDK is missing ${missing.length} of the ${total} ` +
        `operations its own surface spec declares:\n`,
    );
    for (const op of missing) console.error(`  ✗ ${op.method} ${op.path}`);
    console.error(
      `\n${SPEC} is the declared contract for packages/sdk-ts. An operation ` +
        `here with no SDK method means an integration has to reach past the ` +
        `client it was given. Add the method, or remove the operation from the ` +
        `curated surface — either is a decision; drifting is not.`,
    );
    process.exit(1);
  }
  console.log(`SDK surface: ${total}/${total} curated operations implemented.`);
}
