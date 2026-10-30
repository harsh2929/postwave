#!/usr/bin/env node
// Source-size guard for apps/desktop.
//
// This does not pretend the existing large modules are fixed. It makes the
// debt explicit and stops the biggest files from quietly growing while the
// team extracts route/page/API/CSS slices over time.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectSourceSizeFindings,
  countSourceLines,
} from "./source-size-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const SRC_DIR = join(PROJECT_DIR, "src");

const DEFAULT_TS_MAX_LINES = intFromEnv("SOURCE_MAX_TS_LINES", 2_000);
const DEFAULT_CSS_MAX_LINES = intFromEnv("SOURCE_MAX_CSS_LINES", 2_000);

// These are exact legacy ratchets, not exemptions: growth fails and shrinkage
// also fails until this reviewed value is lowered. Any unlisted source must
// satisfy the 2,000-line default.
const FILE_BUDGETS = new Map([
  ["src/lib/api-client.ts", intFromEnv("SOURCE_MAX_API_CLIENT_LINES", 12_537)],
]);

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[check-source-size] FAIL: ${message}`);
  process.exit(1);
}

function info(message) {
  // eslint-disable-next-line no-console
  console.log(`[check-source-size] ${message}`);
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, files);
    } else if (/\.(css|ts|tsx)$/.test(entry)) {
      files.push(abs);
    }
  }
  return files;
}

function lineCount(abs) {
  return countSourceLines(readFileSync(abs, "utf8"));
}

function budgetFor(rel) {
  if (FILE_BUDGETS.has(rel)) return FILE_BUDGETS.get(rel);
  return rel.endsWith(".css") ? DEFAULT_CSS_MAX_LINES : DEFAULT_TS_MAX_LINES;
}

const apiClientSource = readFileSync(
  join(SRC_DIR, "lib/api-client.ts"),
  "utf8",
);
if (/\bObject\.assign\s*\(/.test(apiClientSource)) {
  fail(
    "src/lib/api-client.ts must compose domain method bags explicitly; runtime Object.assign augmentation is prohibited",
  );
}

const rows = walk(SRC_DIR)
  .map((abs) => {
    const rel = relative(PROJECT_DIR, abs).replaceAll("\\", "/");
    return { rel, lines: lineCount(abs) };
  })
  .sort((a, b) => b.lines - a.lines);

const findings = collectSourceSizeFindings(rows, {
  fileBudgets: FILE_BUDGETS,
  defaultTypeScriptMax: DEFAULT_TS_MAX_LINES,
  defaultCssMax: DEFAULT_CSS_MAX_LINES,
});

for (const row of rows.slice(0, 10)) {
  info(`${row.rel}: ${row.lines} lines (budget ${budgetFor(row.rel)})`);
}

if (findings.length > 0) {
  fail(findings.join("; "));
}

info(`OK: ${rows.length} source files are within line-count budgets`);
