#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// i18n key-drift detector. Loads every locale JSON from apps/web/locales/,
// flattens to a sorted set of dotted keys, and asserts every locale has the
// same key set as English. Fails non-zero with a detailed diff if any
// locale is missing or has extra keys.
//
// Run via: node apps/web/scripts/check-i18n-keys.mjs
// Or wired into CI as the i18n smoke test.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, "..", "locales");
const REFERENCE_LOCALE = "en";

function flatten(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flatten(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

function loadLocale(locale) {
  const file = join(LOCALES_DIR, `${locale}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json"));
const locales = files.map((f) => f.replace(/\.json$/, "")).sort();

if (!locales.includes(REFERENCE_LOCALE)) {
  console.error(`[i18n-check] missing reference locale ${REFERENCE_LOCALE}.json`);
  process.exit(2);
}

const referenceKeys = new Set(flatten(loadLocale(REFERENCE_LOCALE)).sort());
let drift = 0;

for (const locale of locales) {
  if (locale === REFERENCE_LOCALE) continue;
  const keys = new Set(flatten(loadLocale(locale)).sort());

  const missing = [...referenceKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !referenceKeys.has(k));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`[i18n-check] ${locale}: ok (${keys.size} keys)`);
    continue;
  }
  drift += missing.length + extra.length;
  console.error(`[i18n-check] ${locale}: drift detected`);
  for (const k of missing) console.error(`    - missing: ${k}`);
  for (const k of extra) console.error(`    + extra:   ${k}`);
}

if (drift > 0) {
  console.error(`\n[i18n-check] FAILED: ${drift} key(s) out of sync`);
  process.exit(1);
}
console.log(`\n[i18n-check] all locales in sync (${referenceKeys.size} keys × ${locales.length} locales)`);
