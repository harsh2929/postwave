#!/usr/bin/env node
//
// check-sdk-type-shapes.mjs — does the hand-written SDK agree with the contract
// about the SHAPE of what it returns?
//
// `check-sdk-surface-drift.mjs` already asks whether the SDK covers the right
// routes and verbs. It cannot ask this one, and the gap has already cost us: an
// adversarial review found THREE methods declaring field names the gateway
// never sends — `issues`/`next_cursor` where the Go struct sends
// `items`/`nextCursor`, `html`/`published_at` where it sends
// `htmlBody`/`publishedAt`, and `sample_size` for a heatmap that returns
// `subscribers_with_data`.
//
// Every one of those reads `undefined` at runtime WITHOUT ERRORING. A consumer
// renders an empty archive and nothing fails: no exception, no 4xx, no log
// line. The route was right, the verb was right, and the surface gate was
// green.
//
// `packages/sdk-ts/src/types.ts` opens with "Hand-mirrored from openapi.yaml …
// when it changes, update this file in the same PR" — a rule somebody has to
// remember, on 1011 lines, against a spec of 1074 schemas. This is that rule,
// enforced.
//
// WHAT IT COMPARES, and why by NAME. 81 of the SDK's 87 exported types share a
// name with a schema in the contract, so matching on the name covers most of
// the surface without needing to map each method to an operation — a mapping
// that would itself be hand-maintained, which is the thing being replaced.
//
// TWO DIRECTIONS, and they are not equally severe:
//
//   EXTRA   the SDK declares a property the contract does not have.
//   MISSING the contract marks a property REQUIRED and the SDK omits it.
//
// IT REPORTS DISAGREEMENT AND CANNOT SAY WHICH SIDE IS WRONG. That distinction
// is load-bearing and an earlier draft of this file got it wrong, asserting the
// SDK was at fault in both directions. It is not always: `WebhookEvent` declares
// `occurred_at`, the contract requires `created_at`, and the gateway really does
// send `occurred_at` (outbound_webhooks/playground.go:480) — so there the SPEC is
// the stale one. A gate that misattributes blame sends somebody to edit the
// correct file. Every message therefore names both possibilities and says to
// check the handler first.
//
// Optional contract properties the SDK omits are NOT reported. An SDK may
// legitimately expose a subset, and flagging every optional field would produce
// a list nobody reads — the failure mode of a guard that cries wolf.
//
//   node scripts/check-sdk-type-shapes.mjs
//   node scripts/check-sdk-type-shapes.mjs --self-test

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(repoRoot, "packages/openapi/openapi.json");
const SDK = join(repoRoot, "packages/sdk-ts/src/types.ts");
const BASELINE = join(repoRoot, "packages/openapi/sdk-shape-baseline.json");

/**
 * Property names a spec schema exposes, following $ref and allOf.
 *
 * allOf is followed because the contract composes with it — SubscriberBulkTagInput
 * is a target plus a tag — and a comparison that stopped at the top level would
 * report every composed schema as missing everything it inherits.
 */
export function specProperties(schema, spec, seen = new Set()) {
  if (!schema || typeof schema !== "object") return null;

  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    // A cycle is a self-referential schema (a tree node, a nested group). Return
    // empty rather than recursing: the properties are already collected by the
    // outer visit, and looping would hang the gate.
    if (seen.has(name)) return new Set();
    seen.add(name);
    return specProperties(spec.components?.schemas?.[name], spec, seen);
  }

  const out = new Set();
  for (const branch of schema.allOf ?? []) {
    const nested = specProperties(branch, spec, seen);
    if (nested) for (const k of nested) out.add(k);
  }
  for (const key of Object.keys(schema.properties ?? {})) out.add(key);

  // oneOf/anyOf deliberately contribute NOTHING. A property present in only one
  // branch is not one the SDK must declare, and treating the union as a sum
  // would invent required fields for every alternative.
  if (out.size === 0 && !schema.properties && !schema.allOf) return null;
  return out;
}

/** Required property names, following the same composition rules. */
export function specRequired(schema, spec, seen = new Set()) {
  if (!schema || typeof schema !== "object") return new Set();
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return new Set();
    seen.add(name);
    return specRequired(spec.components?.schemas?.[name], spec, seen);
  }
  const out = new Set(schema.required ?? []);
  for (const branch of schema.allOf ?? []) {
    for (const k of specRequired(branch, spec, seen)) out.add(k);
  }
  return out;
}

/**
 * Top-level property names of each `export interface X { … }` in a TS source.
 *
 * Brace-depth tracking rather than a regex over the whole block: a nested object
 * literal's keys are not the interface's properties, and counting them would
 * report inner fields as extras on the parent.
 */
export function sdkInterfaces(source) {
  const own = new Map();
  const parents = new Map();
  const header = /export interface ([A-Za-z0-9_]+)([^{]*)\{/g;
  let match;
  while ((match = header.exec(source))) {
    const name = match[1];
    // `extends A, B` is the SDK's allOf, and it must be followed for the same
    // reason. The first version resolved composition on the CONTRACT side only,
    // so `FormListItem extends Form` was reported as missing every field it
    // inherits — six false findings from one unhandled keyword. A gate that
    // invents findings is worse than no gate: it gets muted.
    const ext = /extends\s+([^{]+)/.exec(match[2]);
    parents.set(
      name,
      ext ? ext[1].split(",").map((p) => p.trim().replace(/<.*$/, "")).filter(Boolean) : [],
    );

    const props = new Set();
    const rest = source.slice(header.lastIndex);
    let depth = 1;
    for (const rawLine of rest.split("\n")) {
      const line = rawLine.trim();
      // Depth is read at the START of the line, before this line's own braces
      // are counted. Counting them first left `outer: {` already at depth 2 when
      // the property was tested, so `outer` was never recorded — an UNDER-read,
      // which manufactures false "the contract requires this" findings. The
      // self-test caught that one before the real run was believed.
      if (depth === 1 && line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("[")) {
        const prop = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\??\s*:/.exec(line);
        if (prop) props.add(prop[1]);
      }
      for (const ch of rawLine) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) break;
    }
    own.set(name, props);
  }

  // Flatten the extends chain. `seen` guards a cycle, which TypeScript rejects
  // but a malformed edit can produce mid-refactor; hanging the gate on bad
  // input helps nobody.
  const resolve = (name, seen = new Set()) => {
    if (seen.has(name)) return new Set();
    seen.add(name);
    const out = new Set(own.get(name) ?? []);
    for (const parent of parents.get(name) ?? []) {
      for (const k of resolve(parent, seen)) out.add(k);
    }
    return out;
  };

  const flat = new Map();
  for (const name of own.keys()) flat.set(name, resolve(name));
  return flat;
}

function run() {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const sdk = readFileSync(SDK, "utf8");
  const interfaces = sdkInterfaces(sdk);

  const findings = [];
  const collisions = [];
  let compared = 0;
  for (const [name, sdkProps] of interfaces) {
    const schema = spec.components?.schemas?.[name];
    if (!schema) continue;
    const contract = specProperties(schema, spec);
    if (!contract || contract.size === 0) continue;

    // SAME NAME, DIFFERENT CONCEPT is a distinct outcome from drift, and
    // conflating them floods the report. The SDK's `CampaignReport` is an
    // inbox-placement report (providers, placements, overall_pct); the
    // contract's is send statistics (opens, clicks, bounces). They share
    // `campaign_id` and nothing else. Property-level findings there are not
    // twelve bugs, they are one fact stated twelve times.
    //
    // Drift looks different: mostly-matching with a few differences. So a match
    // that shares almost nothing is classified as a collision and reported once.
    const shared = [...sdkProps].filter((k) => contract.has(k)).length;
    const overlap = sdkProps.size === 0 ? 1 : shared / sdkProps.size;
    if (overlap < 0.25 && sdkProps.size >= 3) {
      collisions.push(
        `${name}: the SDK type and the contract schema share ${shared} of ` +
          `${sdkProps.size} properties — the same name is being used for two ` +
          `different things, which anyone generating from names will hit`,
      );
      continue;
    }
    compared++;

    for (const prop of sdkProps) {
      if (!contract.has(prop)) {
        findings.push(
          `${name}.${prop}: the SDK declares it, the contract does not. If the ` +
            `SDK is wrong it reads undefined at runtime and nothing errors; if the ` +
            `CONTRACT is wrong the spec understates what the gateway sends. Check ` +
            `the handler before editing either.`,
        );
      }
    }
    const required = specRequired(schema, spec);
    for (const prop of required) {
      if (!sdkProps.has(prop)) {
        findings.push(
          `${name}.${prop}: the contract marks it REQUIRED, the SDK omits it. If ` +
            `the contract is right no SDK consumer can reach a field the gateway ` +
            `sends; if it is stale the requirement is fiction. Check the handler.`,
        );
      }
    }
  }

  // A comparison over nothing is a pass that means nothing — the failure every
  // discovery guard in this repo has hit at least once.
  if (compared < 40) {
    console.error(
      `check-sdk-type-shapes: only ${compared} SDK types matched a contract schema ` +
        `(expected at least 40). The name matching is broken and a clean result here ` +
        `would mean nothing.`,
    );
    process.exit(1);
  }

  // Collisions are reported and do NOT fail the gate. They are pre-existing
  // facts about two vocabularies that grew separately, not regressions, and a
  // gate that fails on them on day one is a gate somebody disables on day one.
  // Printing them keeps the count visible so it can shrink deliberately.
  if (collisions.length > 0) {
    console.log(`check-sdk-type-shapes: ${collisions.length} name collision(s) (reported, not failed):`);
    for (const c of collisions) console.log(`  ~ ${c}`);
    console.log("");
  }

  const baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")).acknowledged ?? []);
  const isNew = (f) => !baseline.has(f.slice(0, f.indexOf(":")));
  const fresh = findings.filter(isNew);

  // An entry that no longer reproduces must leave the baseline, or the list
  // becomes where fixed problems go to be remembered forever — and the next
  // reader cannot tell which entries are real.
  const live = new Set(findings.map((f) => f.slice(0, f.indexOf(":"))));
  const stale = [...baseline].filter((b) => !live.has(b));

  if (fresh.length > 0 || stale.length > 0) {
    if (fresh.length > 0) {
      console.error(`check-sdk-type-shapes: ${fresh.length} NEW shape disagreement(s):\n`);
      for (const f of fresh) console.error(`  - ${f}`);
    }
    if (stale.length > 0) {
      console.error(`\ncheck-sdk-type-shapes: ${stale.length} baseline entr(y/ies) no longer reproduce — remove them from sdk-shape-baseline.json:\n`);
      for (const b of stale) console.error(`  + ${b}`);
    }
    process.exit(1);
  }
  console.log(
    `check-sdk-type-shapes: OK — ${compared} types compared, ` +
      `${findings.length} acknowledged disagreement(s), 0 new.`,
  );
}

function selfTest() {
  let failures = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      console.error(`self-test FAIL ${label}: got ${a}, want ${e}`);
      failures++;
    }
  };

  const spec = {
    components: {
      schemas: {
        Base: { type: "object", properties: { id: {}, name: {} }, required: ["id"] },
        Composed: {
          allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { extra: {} }, required: ["extra"] }],
        },
        Cyclic: { type: "object", properties: { self: { $ref: "#/components/schemas/Cyclic" }, leaf: {} } },
        Choice: { oneOf: [{ properties: { a: {} } }, { properties: { b: {} } }] },
      },
    },
  };
  check("plain", [...specProperties(spec.components.schemas.Base, spec)].sort(), ["id", "name"]);
  check("allOf is followed", [...specProperties(spec.components.schemas.Composed, spec)].sort(), ["extra", "id", "name"]);
  check("required across allOf", [...specRequired(spec.components.schemas.Composed, spec)].sort(), ["extra", "id"]);
  check("cycle terminates", [...specProperties(spec.components.schemas.Cyclic, spec)].sort(), ["leaf", "self"]);
  check("oneOf contributes nothing", specProperties(spec.components.schemas.Choice, spec), null);

  const src = [
    "export interface Flat {",
    "  id: string;",
    "  count?: number;",
    '  "quoted-ish": string;',
    "  // a comment: not a property",
    "  [key: string]: unknown;",
    "}",
    "export interface Nested {",
    "  outer: {",
    "    inner: string;",
    "  };",
    "  after: number;",
    "}",
  ].join("\n");
  const parsed = sdkInterfaces(src);
  check("flat props, comments and index signatures ignored", [...parsed.get("Flat")].sort(), ["count", "id"]);
  check("nested keys are not the parent's", [...parsed.get("Nested")].sort(), ["after", "outer"]);

  const inherit = [
    "export interface Base2 {",
    "  id: string;",
    "}",
    "export interface Child extends Base2 {",
    "  extra: number;",
    "}",
    "export interface GrandChild extends Child {",
    "  deep: boolean;",
    "}",
  ].join("\n");
  const chain = sdkInterfaces(inherit);
  check("extends is followed", [...chain.get("Child")].sort(), ["extra", "id"]);
  check("extends is transitive", [...chain.get("GrandChild")].sort(), ["deep", "extra", "id"]);

  if (failures > 0) {
    console.error(`check-sdk-type-shapes self-test: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("check-sdk-type-shapes self-test OK (9 assertions)");
}

if (process.argv.includes("--self-test")) selfTest();
else run();
