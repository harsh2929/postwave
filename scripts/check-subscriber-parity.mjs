#!/usr/bin/env node
//
// scripts/check-subscriber-parity.mjs
//
// Audit finding (Week 3-4): the Subscriber type drifted across 4 sources
// of truth — OpenAPI spec, packages/schema TS types, apps/api Go type,
// packages/migrate canonical Go type. We can't repair drift everywhere
// in one CI step, but we CAN catch new drift between the spec and the
// gateway implementation, which is the surface SDKs talk to.
//
// What this checks:
//
//   1. Every property in the OpenAPI Subscriber schema has a matching
//      JSON tag in apps/api/internal/subscribers/types.go::Subscriber.
//   2. Every JSON tag on that Go struct is documented in the spec
//      (catches "field added to API without spec update").
//
// What this DOES NOT check:
//
//   * Type compatibility between spec and Go (we'd need a real codegen
//     pipeline for that — tracked as a follow-up).
//   * The packages/schema TS mirror — handled separately by the eventual
//     openapi-typescript codegen step.
//
// Usage: node scripts/check-subscriber-parity.mjs
// Exits 1 on drift; CI surfaces the diff in the job log.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const SPEC_PATH = resolve(repoRoot, "packages/openapi/openapi.yaml");
const GO_TYPE_PATH = resolve(repoRoot, "apps/api/internal/subscribers/types.go");

// Properties documented in the spec but intentionally NOT exposed via the
// gateway's Subscriber type (e.g. computed/aggregated views). Add with a
// comment so future me knows why each entry is here.
const SPEC_ONLY_ALLOWLIST = new Set([
  // (none today)
]);

// JSON tags on the Go struct that are intentionally omitted from the spec
// (e.g. internal fields, deprecated fields not yet ripped). Be very
// conservative about adding to this list — it's a drift-acceptance gate.
const GO_ONLY_ALLOWLIST = new Set([
  // (none today)
]);

function parseSpecSubscriberProps() {
  const yaml = readFileSync(SPEC_PATH, "utf8");
  // Minimal YAML walker: find the `Subscriber:` block under
  // components/schemas, then read its `properties:` mapping. We
  // deliberately don't pull a YAML dep — the script must run with a
  // bare Node + no install step.
  const lines = yaml.split(/\r?\n/);
  let inSubscriber = false;
  let inProperties = false;
  let subscriberIndent = -1;
  let propsIndent = -1;
  const props = new Set();
  for (const line of lines) {
    const trimmed = line.replace(/\t/g, "    ");
    const indent = trimmed.match(/^(\s*)/)?.[1].length ?? 0;
    const text = trimmed.trim();

    if (!inSubscriber && /^Subscriber:\s*$/.test(text)) {
      inSubscriber = true;
      subscriberIndent = indent;
      continue;
    }
    if (inSubscriber && indent <= subscriberIndent && text !== "") {
      break;
    }
    if (inSubscriber && !inProperties && /^properties:\s*$/.test(text)) {
      inProperties = true;
      propsIndent = indent;
      continue;
    }
    if (inProperties) {
      if (indent <= propsIndent && text !== "") {
        inProperties = false;
        continue;
      }
      // Property entries are exactly one indent deeper than properties:.
      if (indent === propsIndent + 2) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(text);
        if (m) props.add(m[1]);
      }
    }
  }
  return props;
}

function parseGoSubscriberJSONTags() {
  const src = readFileSync(GO_TYPE_PATH, "utf8");
  const tags = new Set();
  const startRe = /^\s*type\s+Subscriber\s+struct\s+\{\s*$/m;
  const startMatch = startRe.exec(src);
  if (!startMatch) {
    throw new Error(`could not find 'type Subscriber struct {' in ${GO_TYPE_PATH}`);
  }
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  const block = src.slice(startMatch.index, i);
  const tagRe = /`json:"([A-Za-z_][A-Za-z0-9_]*)(?:,[^"]*)?"/g;
  let m;
  while ((m = tagRe.exec(block)) !== null) {
    tags.add(m[1]);
  }
  return tags;
}

function diff(specProps, goTags) {
  const specOnly = [...specProps]
    .filter((p) => !goTags.has(p) && !SPEC_ONLY_ALLOWLIST.has(p))
    .sort();
  const goOnly = [...goTags]
    .filter((t) => !specProps.has(t) && !GO_ONLY_ALLOWLIST.has(t))
    .sort();
  return { specOnly, goOnly };
}

const specProps = parseSpecSubscriberProps();
const goTags = parseGoSubscriberJSONTags();

if (specProps.size === 0) {
  console.error("ERROR: parsed zero properties from OpenAPI Subscriber schema");
  process.exit(2);
}
if (goTags.size === 0) {
  console.error("ERROR: parsed zero JSON tags from Go Subscriber struct");
  process.exit(2);
}

const { specOnly, goOnly } = diff(specProps, goTags);

if (specOnly.length === 0 && goOnly.length === 0) {
  console.log(
    `Subscriber parity OK: ${specProps.size} spec props match ${goTags.size} Go tags.`,
  );
  process.exit(0);
}

console.error("Subscriber parity check FAILED.\n");
console.error("OpenAPI spec:        " + SPEC_PATH);
console.error("Go gateway type:     " + GO_TYPE_PATH + "\n");
if (specOnly.length) {
  console.error("In spec but missing from Go struct:");
  for (const p of specOnly) console.error("  - " + p);
  console.error("");
}
if (goOnly.length) {
  console.error("On Go struct (json tag) but undocumented in spec:");
  for (const t of goOnly) console.error("  - " + t);
  console.error("");
}
console.error(
  "Reconcile by either (a) updating apps/api/internal/subscribers/types.go,",
);
console.error(
  "(b) updating packages/openapi/openapi.yaml, or (c) adding the field to",
);
console.error(
  "SPEC_ONLY_ALLOWLIST / GO_ONLY_ALLOWLIST in this script with a comment.",
);
process.exit(1);
