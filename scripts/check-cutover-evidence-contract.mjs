#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYAML } from "yaml";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function unique(values, label) {
  const duplicates = values.filter(
    (value, index) => values.indexOf(value) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `${label} contains duplicate keys: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
  return [...values].sort();
}

function assertExactSet(label, actual, expected) {
  const actualSorted = unique(actual, label);
  const expectedSorted = unique(expected, "backend allow-list");
  const missing = expectedSorted.filter((key) => !actualSorted.includes(key));
  const extra = actualSorted.filter((key) => !expectedSorted.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`extra: ${extra.join(", ")}`);
    throw new Error(
      `${label} differs from the backend allow-list (${details.join("; ")})`,
    );
  }
  console.log(`PASS ${label}: ${actualSorted.length} exact keys`);
}

function backendKeys() {
  const source = read(
    "services/migration/internal/handlers/pilot_acceptance.go",
  );
  const constants = new Map();
  for (const match of source.matchAll(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"\s*$/gm,
  )) {
    constants.set(match[1], match[2]);
  }
  const keys = new Set();
  // Discover every provider allow-list. A hand-maintained list previously
  // omitted HubSpot, making two real backend keys look like OpenAPI drift and,
  // worse, allowing the next provider map to be silently outside this gate.
  const mapNames = unique(
    [...source.matchAll(/^var\s+([A-Za-z_][A-Za-z0-9_]*CutoverEvidenceKeys)\s*=\s*map\[string\]bool\{/gm)].map(
      (match) => match[1],
    ),
    "backend cutover-evidence allow-list names",
  );
  if (mapNames.length === 0) {
    throw new Error("no backend cutover-evidence allow-lists found");
  }
  for (const mapName of mapNames) {
    const mapBody = source.match(
      new RegExp(`var ${mapName} = map\\[string\\]bool\\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    if (!mapBody) {
      throw new Error(
        `backend cutover-evidence allow-list ${mapName} not found`,
      );
    }
    const mapKeys = [];
    for (const match of mapBody.matchAll(
      /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*true,\s*$/gm,
    )) {
      if (match[1]) {
        mapKeys.push(match[1]);
        continue;
      }
      const resolved = constants.get(match[2]);
      if (!resolved) {
        throw new Error(
          `cannot resolve backend allow-list constant ${match[2]}`,
        );
      }
      mapKeys.push(resolved);
    }
    if (mapKeys.length === 0) {
      throw new Error(
        `backend cutover-evidence allow-list ${mapName} is empty`,
      );
    }
    for (const key of unique(mapKeys, mapName)) keys.add(key);
  }
  return [...keys];
}

function openAPIKeys(document, label) {
  const keys =
    document?.components?.schemas?.CutoverEvidenceRequest?.properties?.key
      ?.enum;
  if (!Array.isArray(keys)) {
    throw new Error(`${label} CutoverEvidenceRequest.key.enum not found`);
  }
  return keys;
}

function exportedConstKeys(relativePath) {
  const source = read(relativePath);
  const body = source.match(
    /export const CUTOVER_EVIDENCE_KEYS = \[([\s\S]*?)\]\s+as const;/,
  )?.[1];
  if (!body) throw new Error(`${relativePath} CUTOVER_EVIDENCE_KEYS not found`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function webLabelKeys() {
  const source = read("apps/web/src/lib/migration-api.ts");
  const body = source.match(
    /const CUTOVER_EVIDENCE_LABELS[\s\S]*?= \{([\s\S]*?)\n\};/,
  )?.[1];
  if (!body) throw new Error("web cutover-evidence label map not found");
  return [...body.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((match) => match[1]);
}

try {
  const expected = backendKeys();
  const yaml = parseYAML(read("packages/openapi/openapi.yaml"));
  const packageJSON = JSON.parse(read("packages/openapi/openapi.json"));
  const apiDocsJSON = JSON.parse(
    read("apps/api/internal/apidocs/openapi.json"),
  );

  assertExactSet(
    "OpenAPI YAML enum",
    openAPIKeys(yaml, "OpenAPI YAML"),
    expected,
  );
  assertExactSet(
    "OpenAPI package JSON enum",
    openAPIKeys(packageJSON, "OpenAPI package JSON"),
    expected,
  );
  assertExactSet(
    "API docs JSON enum",
    openAPIKeys(apiDocsJSON, "API docs JSON"),
    expected,
  );
  assertExactSet(
    "TypeScript SDK key union",
    exportedConstKeys("packages/sdk-ts/src/resources/migrations.ts"),
    expected,
  );
  assertExactSet(
    "web API key union",
    exportedConstKeys("apps/web/src/lib/migration-api.ts"),
    expected,
  );
  assertExactSet("web API label map", webLabelKeys(), expected);
  console.log("Cutover-evidence public-contract parity passed.");
} catch (error) {
  console.error(
    `Cutover-evidence public-contract parity failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
