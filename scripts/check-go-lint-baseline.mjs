#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class GoLintRatchetError extends Error {
  constructor(messages) {
    super(messages.join("\n"));
    this.name = "GoLintRatchetError";
    this.messages = messages;
  }
}

function fail(message) {
  throw new GoLintRatchetError([message]);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

function normalizeRepositoryPath(value, label) {
  assertNonEmptyString(value, label);
  if (value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(`${label} must be a repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../")) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return normalized;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a real calendar date`);
  }
  return parsed;
}

function normalizeFinding(value, label) {
  assertObject(value, label);
  assertExactKeys(
    value,
    ["linter", "path", "line", "column", "message", "sourceLines"],
    label,
  );
  assertNonEmptyString(value.linter, `${label}.linter`);
  const repositoryPath = normalizeRepositoryPath(value.path, `${label}.path`);
  if (!Number.isSafeInteger(value.line) || value.line < 1) {
    fail(`${label}.line must be a positive integer`);
  }
  if (!Number.isSafeInteger(value.column) || value.column < 1) {
    fail(`${label}.column must be a positive integer`);
  }
  assertNonEmptyString(value.message, `${label}.message`);
  if (!Array.isArray(value.sourceLines) || value.sourceLines.some((line) => typeof line !== "string")) {
    fail(`${label}.sourceLines must be an array of strings`);
  }
  return {
    linter: value.linter,
    path: repositoryPath,
    line: value.line,
    column: value.column,
    message: value.message,
    sourceLines: value.sourceLines,
  };
}

function findingFingerprint(finding) {
  return JSON.stringify([
    finding.linter,
    finding.path,
    finding.line,
    finding.column,
    finding.message,
    finding.sourceLines,
  ]);
}

function displayFinding(finding) {
  return `${finding.linter} ${finding.path}:${finding.line}:${finding.column} ${finding.message}`;
}

function normalizeReportIssue(issue, index) {
  const label = `report.Issues[${index}]`;
  assertObject(issue, label);
  assertNonEmptyString(issue.FromLinter, `${label}.FromLinter`);
  assertNonEmptyString(issue.Text, `${label}.Text`);
  assertObject(issue.Pos, `${label}.Pos`);
  return normalizeFinding(
    {
      linter: issue.FromLinter,
      path: issue.Pos.Filename,
      line: issue.Pos.Line,
      column: issue.Pos.Column,
      message: issue.Text,
      sourceLines: issue.SourceLines ?? [],
    },
    label,
  );
}

export function checkGoLintBaseline({
  baseline,
  report,
  toolVersion,
  configSha256,
  scope,
  today = new Date(),
}) {
  assertObject(baseline, "baseline");
  assertExactKeys(baseline, ["schemaVersion", "tool", "scope", "categories"], "baseline");
  if (baseline.schemaVersion !== 1) {
    fail(`baseline.schemaVersion must be 1; got ${JSON.stringify(baseline.schemaVersion)}`);
  }

  assertObject(baseline.tool, "baseline.tool");
  assertExactKeys(
    baseline.tool,
    ["name", "version", "config", "configSha256"],
    "baseline.tool",
  );
  if (baseline.tool.name !== "golangci-lint") {
    fail(`baseline.tool.name must be golangci-lint`);
  }
  assertNonEmptyString(toolVersion, "toolVersion");
  if (baseline.tool.version !== toolVersion) {
    fail(`tool version mismatch: baseline=${baseline.tool.version} invocation=${toolVersion}`);
  }
  normalizeRepositoryPath(baseline.tool.config, "baseline.tool.config");
  if (!/^[a-f0-9]{64}$/.test(baseline.tool.configSha256)) {
    fail(`baseline.tool.configSha256 must be a lowercase SHA-256 digest`);
  }
  if (baseline.tool.configSha256 !== configSha256) {
    fail(
      `lint config digest mismatch: baseline=${baseline.tool.configSha256} current=${configSha256}; regenerate the report and deliberately lower the baseline`,
    );
  }

  if (!Array.isArray(baseline.scope) || baseline.scope.length === 0) {
    fail(`baseline.scope must be a non-empty array`);
  }
  if (!Array.isArray(scope) || scope.length === 0) {
    fail(`invocation scope must be provided explicitly`);
  }
  for (const [index, pattern] of baseline.scope.entries()) {
    assertNonEmptyString(pattern, `baseline.scope[${index}]`);
  }
  if (JSON.stringify(baseline.scope) !== JSON.stringify(scope)) {
    fail(
      `lint scope mismatch: baseline=${JSON.stringify(baseline.scope)} invocation=${JSON.stringify(scope)}`,
    );
  }

  if (!Array.isArray(baseline.categories) || baseline.categories.length === 0) {
    fail(`baseline.categories must be a non-empty array`);
  }
  const normalizedToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const categoryIDs = new Set();
  const baselineByFingerprint = new Map();
  const categoryCounts = new Map();
  for (const [categoryIndex, category] of baseline.categories.entries()) {
    const label = `baseline.categories[${categoryIndex}]`;
    assertObject(category, label);
    assertExactKeys(
      category,
      ["id", "linter", "owner", "rationale", "expiresOn", "findings"],
      label,
    );
    for (const key of ["id", "linter", "owner", "rationale"]) {
      assertNonEmptyString(category[key], `${label}.${key}`);
    }
    if (category.rationale.trim().length < 20) {
      fail(`${label}.rationale must explain the accepted legacy risk`);
    }
    if (categoryIDs.has(category.id)) {
      fail(`duplicate baseline category id ${category.id}`);
    }
    categoryIDs.add(category.id);
    const expiresAt = parseDate(category.expiresOn, `${label}.expiresOn`);
    if (normalizedToday > expiresAt) {
      fail(`baseline category ${category.id} expired on ${category.expiresOn}`);
    }
    if (!Array.isArray(category.findings) || category.findings.length === 0) {
      fail(`${label}.findings must be a non-empty array`);
    }
    categoryCounts.set(category.id, category.findings.length);
    for (const [findingIndex, rawFinding] of category.findings.entries()) {
      const finding = normalizeFinding(rawFinding, `${label}.findings[${findingIndex}]`);
      if (finding.linter !== category.linter) {
        fail(
          `${label}.findings[${findingIndex}].linter must match category linter ${category.linter}`,
        );
      }
      const fingerprint = findingFingerprint(finding);
      if (baselineByFingerprint.has(fingerprint)) {
        fail(`duplicate baseline fingerprint: ${displayFinding(finding)}`);
      }
      baselineByFingerprint.set(fingerprint, { finding, category: category.id });
    }
  }

  assertObject(report, "report");
  if (!Array.isArray(report.Issues)) {
    fail(`report.Issues must be an array`);
  }
  const reportByFingerprint = new Map();
  for (const [index, rawIssue] of report.Issues.entries()) {
    const finding = normalizeReportIssue(rawIssue, index);
    const fingerprint = findingFingerprint(finding);
    if (reportByFingerprint.has(fingerprint)) {
      fail(`duplicate report fingerprint: ${displayFinding(finding)}`);
    }
    reportByFingerprint.set(fingerprint, finding);
  }

  const unexpected = [];
  for (const [fingerprint, finding] of reportByFingerprint) {
    if (!baselineByFingerprint.has(fingerprint)) {
      unexpected.push(finding);
    }
  }
  const stale = [];
  for (const [fingerprint, entry] of baselineByFingerprint) {
    if (!reportByFingerprint.has(fingerprint)) {
      stale.push(entry.finding);
    }
  }
  if (unexpected.length > 0 || stale.length > 0) {
    const messages = [
      `Go lint exact-fingerprint ratchet failed: ${unexpected.length} new/moved, ${stale.length} stale/resolved`,
    ];
    for (const finding of unexpected.slice(0, 40)) {
      messages.push(`NEW ${displayFinding(finding)}`);
    }
    if (unexpected.length > 40) {
      messages.push(`NEW ... ${unexpected.length - 40} more`);
    }
    for (const finding of stale.slice(0, 40)) {
      messages.push(`STALE ${displayFinding(finding)}`);
    }
    if (stale.length > 40) {
      messages.push(`STALE ... ${stale.length - 40} more`);
    }
    messages.push(
      `Fix new findings. Remove resolved findings from the baseline; never replace or move fingerprints merely to make this check pass.`,
    );
    throw new GoLintRatchetError(messages);
  }

  return {
    total: reportByFingerprint.size,
    categories: [...categoryCounts.entries()].map(([id, count]) => ({ id, count })),
  };
}

async function readRegularFile(filePath, maxBytes, label) {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular, non-symlink file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    fail(`${label} exceeds ${maxBytes} bytes: ${filePath}`);
  }
  return readFile(filePath);
}

function parseArgs(argv) {
  const parsed = { baseline: "config/go-lint-baseline.json", config: ".golangci.yml", scope: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      return { help: true };
    }
    if (!["--report", "--baseline", "--config", "--tool-version", "--scope"].includes(arg)) {
      fail(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--scope") {
      parsed.scope.push(value);
    } else {
      parsed[arg.slice(2).replace("-", "_")] = value;
    }
  }
  for (const required of ["report", "tool_version"]) {
    if (!parsed[required]) {
      fail(`--${required.replace("_", "-")} is required`);
    }
  }
  return parsed;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/check-go-lint-baseline.mjs --report FILE --tool-version VERSION --scope PATTERN [--scope PATTERN ...] [--baseline FILE] [--config FILE]\n",
    );
    return;
  }
  const [baselineBytes, reportBytes, configBytes] = await Promise.all([
    readRegularFile(args.baseline, MAX_BASELINE_BYTES, "baseline"),
    readRegularFile(args.report, MAX_REPORT_BYTES, "report"),
    readRegularFile(args.config, MAX_BASELINE_BYTES, "lint config"),
  ]);
  let baseline;
  let report;
  try {
    baseline = JSON.parse(baselineBytes.toString("utf8"));
  } catch (error) {
    fail(`baseline is not valid JSON: ${error.message}`);
  }
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
  } catch (error) {
    fail(`report is not valid JSON: ${error.message}`);
  }
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  if (baseline.tool?.config !== args.config) {
    fail(`baseline config path ${baseline.tool?.config} does not match invocation ${args.config}`);
  }
  const result = checkGoLintBaseline({
    baseline,
    report,
    toolVersion: args.tool_version,
    configSha256,
    scope: args.scope,
  });
  const counts = result.categories.map(({ id, count }) => `${id}=${count}`).join(", ");
  process.stdout.write(`Go lint ratchet passed: ${result.total} exact findings (${counts})\n`);
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
