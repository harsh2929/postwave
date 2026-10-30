#!/usr/bin/env node
//
// generate-operations.mjs — derive the SDK's operation surface FROM the
// contract instead of mirroring it by hand.
//
// ECO-30 asks for sdk-ts methods generated from the curated
// `packages/openapi/surfaces/openapi.yaml`, so that drift is impossible rather
// than merely visible. `check-sdk-type-shapes.mjs` made shape drift impossible
// to MISS; this removes the hand-copying that produces it, for the curated
// surface.
//
// TWO OUTPUTS, both committed, both self-contained:
//
//   src/generated/paths.ts       openapi-typescript over the curated spec. The
//                                whole `paths` tree, so request and response
//                                types come from the contract rather than being
//                                retyped.
//   src/generated/operations.ts  one typed entry per operation: method, path
//                                template, and Query/Body/Response aliases that
//                                index into `paths`.
//
// SELF-CONTAINED ON PURPOSE. The obvious shortcut is to import types from
// `@postwave/openapi`, which already generates them — but sdk-ts is PUBLISHED
// and that package is internal, so importing it would put a workspace path into
// a package other people install. Generating into the SDK keeps the published
// artefact standalone; the cost is one more generated file, which `--check`
// keeps honest.
//
// BODIES TOO, and the reason the first version stopped at aliases was wrong.
// It claimed a generated method "would have to reproduce this SDK's retry,
// idempotency, step-up replay and error mapping". It does not: every
// hand-written resource method is a one-line delegation to
// `client.request(method, path, {query, body})`, and all of that behaviour
// lives inside `request`. Generating the delegation reproduces nothing and
// loses nothing.
//
// So `operations.ts` now also emits a typed client. The transport stays exactly
// where it was; what becomes impossible is a method that calls the wrong path,
// or types a body the contract does not describe — the drift that shipped three
// times.
//
//   node packages/sdk-ts/scripts/generate-operations.mjs
//   node packages/sdk-ts/scripts/generate-operations.mjs --check

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SPEC = join(repoRoot, "packages/openapi/surfaces/openapi.yaml");
const OUT_DIR = join(repoRoot, "packages/sdk-ts/src/generated");
const PATHS_TS = join(OUT_DIR, "paths.ts");
const OPS_TS = join(OUT_DIR, "operations.ts");
const requireFromOpenAPIPackage = createRequire(
  join(repoRoot, "packages/openapi/package.json"),
);

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

/**
 * Operations in the curated spec, in document order.
 *
 * A minimal indentation walk rather than a YAML dependency: this file has to
 * run in CI with no install step beyond what the repo already has, and the
 * structure it reads (two-space path, four-space method, six-space keys) is
 * fixed by the generator that writes the spec.
 */
export function parseOperations(yaml) {
  const out = [];
  let path = null;
  let method = null;
  for (const raw of yaml.split("\n")) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;

    const pathMatch = /^ {2}(\/[^:]*):\s*$/.exec(raw);
    if (pathMatch) {
      path = pathMatch[1];
      method = null;
      continue;
    }
    // Stop at any other top-level-ish key (components:, tags:) so schema names
    // are never mistaken for paths.
    if (/^\S/.test(raw)) {
      path = null;
      method = null;
      continue;
    }
    if (!path) continue;

    const methodMatch = /^ {4}([a-z]+):\s*$/.exec(raw);
    if (methodMatch && HTTP_METHODS.has(methodMatch[1])) {
      method = methodMatch[1];
      out.push({ path, method, operationId: null });
      continue;
    }
    const idMatch = /^ {6}operationId:\s*(\S+)\s*$/.exec(raw);
    if (idMatch && out.length > 0 && method) {
      out[out.length - 1].operationId = idMatch[1];
    }
  }
  return out;
}

/** `postSubscribersBulkTag` -> `PostSubscribersBulkTag`. */
export function typeName(operationId) {
  return operationId.charAt(0).toUpperCase() + operationId.slice(1);
}

export function renderOperations(operations) {
  const lines = [];
  lines.push("// SPDX-License-Identifier: AGPL-3.0-only");
  lines.push("//");
  lines.push("// GENERATED FILE — do not edit.");
  lines.push("//");
  lines.push("// Source: packages/openapi/surfaces/openapi.yaml");
  lines.push("// Regenerate: node packages/sdk-ts/scripts/generate-operations.mjs");
  lines.push("// CI drift gate: the same script with --check.");
  lines.push("//");
  lines.push("// Each operation contributes its method, its path TEMPLATE, and three type");
  lines.push("// aliases indexing into the generated `paths` tree. An alias resolves to");
  lines.push("// `never` when the operation has no such part — a body-less GET has");
  lines.push("// `Body = never`, which is a compile error at the call site rather than an");
  lines.push("// `any` that silently accepts anything.");
  lines.push("");
  lines.push('import type { paths } from "./paths.js";');
  lines.push("");

  const table = [];
  for (const op of operations) {
    if (!op.operationId) continue;
    const name = typeName(op.operationId);
    const p = JSON.stringify(op.path);
    const m = op.method;
    lines.push(`/** \`${m.toUpperCase()} ${op.path}\` */`);
    lines.push(`export type ${name}Query = paths[${p}][${JSON.stringify(m)}] extends {`);
    lines.push("  parameters: { query?: infer Q };");
    lines.push("}");
    lines.push("  ? Q");
    lines.push("  : never;");
    lines.push(`export type ${name}Body = paths[${p}][${JSON.stringify(m)}] extends {`);
    lines.push('  requestBody: { content: { "application/json": infer B } };');
    lines.push("}");
    lines.push("  ? B");
    lines.push("  : never;");
    lines.push(`export type ${name}Response = paths[${p}][${JSON.stringify(m)}] extends {`);
    lines.push('  responses: { 200: { content: { "application/json": infer R } } };');
    lines.push("}");
    lines.push("  ? R");
    lines.push("  : never;");
    lines.push("");
    table.push({ operationId: op.operationId, method: m.toUpperCase(), path: op.path });
  }

  lines.push("/**");
  lines.push(" * Every curated operation, for callers that dispatch by id.");
  lines.push(" *");
  lines.push(" * Frozen so a consumer cannot mutate the route table at runtime and send a");
  lines.push(" * request to a path the contract never described.");
  lines.push(" */");
  lines.push("export const OPERATIONS = Object.freeze({");
  for (const entry of table) {
    lines.push(
      `  ${entry.operationId}: Object.freeze({ method: ${JSON.stringify(entry.method)}, path: ${JSON.stringify(entry.path)} }),`,
    );
  }
  lines.push("} as const);");
  lines.push("");
  lines.push("export type OperationId = keyof typeof OPERATIONS;");
  lines.push("");

  // The typed client. One method per operation, each a delegation.
  lines.push("/** The transport this client needs. `PostwaveClient` satisfies it. */");
  lines.push("export interface OperationTransport {");
  lines.push("  request<T>(");
  lines.push("    method: string,");
  lines.push("    path: string,");
  lines.push("    opts?: { query?: Record<string, unknown>; body?: unknown },");
  lines.push("  ): Promise<T>;");
  lines.push("}");
  lines.push("");
  lines.push("/**");
  lines.push(" * Every curated operation as a typed call.");
  lines.push(" *");
  lines.push(" * Generated, so a method cannot call a path the contract does not");
  lines.push(" * describe. The transport is the caller's — retry, idempotency, step-up");
  lines.push(" * replay and error mapping all stay in `PostwaveClient.request`, which is");
  lines.push(" * why generating these bodies reproduces none of it.");
  lines.push(" */");
  lines.push("export class GeneratedOperations {");
  lines.push("  constructor(private readonly client: OperationTransport) {}");
  lines.push("");
  for (const op of operations) {
    if (!op.operationId) continue;
    const name = typeName(op.operationId);
    const params = [...op.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    const args = params.map((p) => `${p}: string`);
    args.push(`opts: { query?: ${name}Query; body?: ${name}Body } = {}`);
    // Path parameters are encoded, not interpolated raw: an id containing a
    // slash would otherwise change which route the gateway matches.
    const pathExpr = params.length === 0
      ? JSON.stringify(op.path)
      : "`" + op.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, g) => "${encodeURIComponent(" + g + ")}") + "`";
    lines.push(`  /** \`${op.method.toUpperCase()} ${op.path}\` */`);
    lines.push(`  ${op.operationId}(${args.join(", ")}): Promise<${name}Response> {`);
    lines.push(`    return this.client.request<${name}Response>(${JSON.stringify(op.method.toUpperCase())}, ${pathExpr}, {`);
    lines.push("      query: opts.query as Record<string, unknown> | undefined,");
    lines.push("      body: opts.body,");
    lines.push("    });");
    lines.push("  }");
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export function resolveOpenAPITypeScriptCLI() {
  const packageJSONPath = requireFromOpenAPIPackage.resolve(
    "openapi-typescript/package.json",
  );
  const packageJSON = JSON.parse(readFileSync(packageJSONPath, "utf8"));
  const bin =
    typeof packageJSON.bin === "string"
      ? packageJSON.bin
      : packageJSON.bin?.["openapi-typescript"];
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(
      "openapi-typescript does not declare its openapi-typescript CLI",
    );
  }
  const cli = join(dirname(packageJSONPath), bin);
  if (!existsSync(cli)) {
    throw new Error(`openapi-typescript CLI is missing at ${cli}`);
  }
  return cli;
}

function generatePaths(target) {
  execFileSync(process.execPath, [resolveOpenAPITypeScriptCLI(), SPEC, "-o", target], {
    stdio: ["ignore", "ignore", "pipe"],
    cwd: repoRoot,
  });
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(SPEC)) {
    console.error(`generate-operations: curated spec not found at ${SPEC}`);
    process.exit(1);
  }
  const operations = parseOperations(readFileSync(SPEC, "utf8"));
  const withIds = operations.filter((o) => o.operationId);

  // A spec that parsed to nothing would regenerate an empty file and report
  // success — the shape of "clean sweep over zero rows" this repo keeps
  // catching. The curated surface is deliberately small; 15 is a floor well
  // under its current 27 that still refuses an empty parse.
  if (withIds.length < 15) {
    console.error(
      `generate-operations: parsed only ${withIds.length} operations with an operationId ` +
        `from the curated spec. The parse is broken; refusing to write.`,
    );
    process.exit(1);
  }

  const rendered = renderOperations(operations);

  if (check) {
    const tmp = mkdtempSync(join(tmpdir(), "sdk-ops-"));
    try {
      const tmpPaths = join(tmp, "paths.ts");
      generatePaths(tmpPaths);
      const freshPaths = readFileSync(tmpPaths, "utf8");
      const committedPaths = existsSync(PATHS_TS) ? readFileSync(PATHS_TS, "utf8") : "";
      const committedOps = existsSync(OPS_TS) ? readFileSync(OPS_TS, "utf8") : "";
      const drifted = [];
      if (freshPaths !== committedPaths) drifted.push("src/generated/paths.ts");
      if (rendered !== committedOps) drifted.push("src/generated/operations.ts");
      if (drifted.length > 0) {
        console.error(
          `generate-operations --check: ${drifted.join(" and ")} out of date.\n` +
            `Run: node packages/sdk-ts/scripts/generate-operations.mjs`,
        );
        process.exit(1);
      }
      console.log(`generate-operations --check: OK — ${withIds.length} operations up to date.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  generatePaths(PATHS_TS);
  writeFileSync(OPS_TS, rendered);
  console.log(`generate-operations: wrote ${withIds.length} operations to src/generated/.`);
}

if (process.argv.includes("--self-test")) {
  const yaml = [
    "paths:",
    "  /api/v1/things:",
    "    get:",
    "      operationId: listThings",
    "    post:",
    "      operationId: createThing",
    "  /api/v1/things/{id}:",
    "    delete:",
    "      operationId: deleteThing",
    "components:",
    "  schemas:",
    "    /notAPath:",
    "      type: object",
  ].join("\n");
  const ops = parseOperations(yaml);
  const got = ops.map((o) => `${o.method} ${o.path} ${o.operationId}`);
  const want = [
    "get /api/v1/things listThings",
    "post /api/v1/things createThing",
    "delete /api/v1/things/{id} deleteThing",
  ];
  let failures = 0;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`self-test FAIL parse: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failures++;
  }
  if (typeName("postThing") !== "PostThing") {
    console.error("self-test FAIL typeName");
    failures++;
  }
  const openAPITypeScriptCLI = resolveOpenAPITypeScriptCLI();
  if (!existsSync(openAPITypeScriptCLI)) {
    console.error(
      `self-test FAIL openapi-typescript CLI resolution: ${openAPITypeScriptCLI}`,
    );
    failures++;
  }
  const rendered = renderOperations(ops);
  for (const needle of ["ListThingsQuery", "CreateThingBody", "DeleteThingResponse", "OPERATIONS", "Object.freeze"]) {
    if (!rendered.includes(needle)) {
      console.error(`self-test FAIL render: missing ${needle}`);
      failures++;
    }
  }
  if (failures > 0) process.exit(1);
  console.log("generate-operations self-test OK (8 assertions)");
} else {
  main();
}
