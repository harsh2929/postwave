#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

import {
  collectFunctionQualityFindings,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_FUNCTION_LINES,
} from "./function-quality-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const BUDGET_PATH = resolve(SCRIPT_DIR, "function-quality-budgets.json");

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[check-function-quality] FAIL: ${message}`);
  process.exit(1);
}

function relativeSourcePath(filePath) {
  return relative(PROJECT_DIR, filePath).replaceAll("\\", "/");
}

function parseMetric(message, pattern, ruleId) {
  const match = pattern.exec(message);
  if (!match) fail(`could not parse ${ruleId} diagnostic: ${message}`);
  return Number.parseInt(match[1], 10);
}

let rawBudgets;
try {
  rawBudgets = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
} catch (error) {
  fail(`cannot read function-quality budgets: ${error.message}`);
}
if (
  rawBudgets == null ||
  typeof rawBudgets !== "object" ||
  Array.isArray(rawBudgets)
) {
  fail("function-quality budgets must be a JSON object keyed by source path");
}
for (const [path, metrics] of Object.entries(rawBudgets)) {
  if (!/^src\/.+\.(ts|tsx)$/.test(path)) {
    fail(`invalid function-quality source path: ${path}`);
  }
  if (metrics == null || typeof metrics !== "object" || Array.isArray(metrics)) {
    fail(`${path} function-quality budget must be an object`);
  }
  const keys = Object.keys(metrics);
  if (keys.length === 0) fail(`${path} function-quality budget is empty`);
  for (const key of keys) {
    const defaultLimit =
      key === "maxFunctionLines"
        ? DEFAULT_MAX_FUNCTION_LINES
        : key === "maxComplexity"
          ? DEFAULT_MAX_COMPLEXITY
          : null;
    if (defaultLimit == null) fail(`${path} has unknown budget key ${key}`);
    if (!Number.isSafeInteger(metrics[key]) || metrics[key] <= defaultLimit) {
      fail(
        `${path} ${key} must be an integer above the default ${defaultLimit}`,
      );
    }
  }
}
const legacyBudgets = new Map(Object.entries(rawBudgets));

const eslint = new ESLint({
  cwd: PROJECT_DIR,
  overrideConfig: {
    rules: {
      complexity: ["error", DEFAULT_MAX_COMPLEXITY],
      "max-lines-per-function": [
        "error",
        {
          max: DEFAULT_MAX_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  },
});

const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
const productionResults = results.filter((result) => {
  const path = relativeSourcePath(result.filePath);
  return !path.startsWith("src/__tests__/") && !/\.stories\.(ts|tsx)$/.test(path);
});
if (productionResults.length === 0) fail("no production TypeScript sources found");
for (const result of productionResults) {
  if (result.fatalErrorCount > 0) {
    fail(
      `${relativeSourcePath(result.filePath)} could not be analyzed: ${result.messages
        .filter((message) => message.fatal)
        .map((message) => message.message)
        .join("; ")}`,
    );
  }
}
const existingPaths = new Set(
  productionResults.map((result) => relativeSourcePath(result.filePath)),
);
const observed = new Map();

for (const result of productionResults) {
  const path = relativeSourcePath(result.filePath);
  for (const message of result.messages) {
    let key;
    let value;
    if (message.ruleId === "max-lines-per-function") {
      key = "maxFunctionLines";
      value = parseMetric(
        message.message,
        /too many lines \((\d+)\)/,
        message.ruleId,
      );
    } else if (message.ruleId === "complexity") {
      key = "maxComplexity";
      value = parseMetric(
        message.message,
        /complexity of (\d+)/,
        message.ruleId,
      );
    } else {
      continue;
    }
    const metrics = observed.get(path) ?? {};
    metrics[key] = Math.max(metrics[key] ?? 0, value);
    observed.set(path, metrics);
  }
}

if (process.argv.includes("--print-baseline")) {
  // eslint-disable-next-line no-console
  console.log(
    `${JSON.stringify(Object.fromEntries([...observed].sort()), null, 2)}\n`,
  );
  process.exit(0);
}

const findings = collectFunctionQualityFindings(
  observed,
  legacyBudgets,
  existingPaths,
);
if (findings.length > 0) fail(findings.join("; "));

// eslint-disable-next-line no-console
console.log(
  `[check-function-quality] OK: ${productionResults.length} production files; ${legacyBudgets.size} exact legacy file ratchets; defaults ${DEFAULT_MAX_FUNCTION_LINES} lines / complexity ${DEFAULT_MAX_COMPLEXITY}`,
);
