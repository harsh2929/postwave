#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGETS_PATH = resolve(
  SCRIPT_DIR,
  "..",
  "performance-budgets.json",
);
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class PerformanceEvidenceError extends Error {
  constructor(issues) {
    super(issues.join("; "));
    this.name = "PerformanceEvidenceError";
    this.issues = issues;
  }
}

export function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("cannot calculate p95 of an empty sample");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function targetKey(platform, architecture) {
  return `${String(platform)}/${String(architecture)}`;
}

function numericVersion(value) {
  const matches = String(value).match(/\d+(?:\.\d+)*/g);
  const version = matches?.at(-1);
  return version ? version.split(".").map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const actualPart = left[index] ?? 0;
    const minimumPart = right[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

function validateInstalledBudgets(budgets) {
  const issues = [];
  if (
    !object(budgets) ||
    !Number.isInteger(budgets.schemaVersion) ||
    budgets.schemaVersion < 1
  ) {
    issues.push("performance budgets require a positive integer schemaVersion");
  }
  const installed = budgets?.installed;
  if (!object(installed)) {
    issues.push("performance budgets are missing the installed contract");
  } else {
    if (
      !Array.isArray(installed.requiredTargets) ||
      installed.requiredTargets.length === 0
    ) {
      issues.push("installed.requiredTargets must be a non-empty array");
    } else {
      const seen = new Set();
      installed.requiredTargets.forEach((target, index) => {
        if (
          !object(target) ||
          !nonEmpty(target.platform) ||
          !nonEmpty(target.architecture)
        ) {
          issues.push(
            `installed.requiredTargets[${index}] requires platform and architecture`,
          );
          return;
        }
        if (!["macos", "windows"].includes(target.platform)) {
          issues.push(
            `installed.requiredTargets[${index}].platform must be macos or windows`,
          );
        }
        const key = targetKey(target.platform, target.architecture);
        if (seen.has(key)) issues.push(`duplicate installed target ${key}`);
        seen.add(key);
      });
    }
    if (!object(installed.minimumWebviewVersions)) {
      issues.push("installed.minimumWebviewVersions must be an object");
    } else {
      for (const platform of ["macos", "windows"]) {
        if (!nonEmpty(installed.minimumWebviewVersions[platform])) {
          issues.push(
            `installed.minimumWebviewVersions.${platform} is required`,
          );
        }
      }
    }
    if (
      !Number.isInteger(installed.minimumRuns) ||
      installed.minimumRuns <= 0
    ) {
      issues.push("installed.minimumRuns must be a positive integer");
    }
    if (
      !finiteNonNegative(installed.minimumSustainedMinutes) ||
      installed.minimumSustainedMinutes === 0
    ) {
      issues.push(
        "installed.minimumSustainedMinutes must be a positive number",
      );
    }
    for (const field of [
      "coldLaunchP95Ms",
      "firstInteractionP95Ms",
      "idleRssP95MiB",
      "sustainedRssPeakMiB",
      "sustainedRssGrowthMiB",
    ]) {
      if (!finiteNonNegative(installed[field]) || installed[field] === 0) {
        issues.push(`installed.${field} must be a positive number`);
      }
    }
    if (
      !Number.isInteger(installed.maximumCrashCount) ||
      installed.maximumCrashCount < 0
    ) {
      issues.push("installed.maximumCrashCount must be a non-negative integer");
    }
  }
  if (issues.length > 0) throw new PerformanceEvidenceError(issues);
  return installed;
}

function digestFile(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular artifact file`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Validate one installed-run record and bind it to the exact installer file.
 * Returns computed summary values for logging/report attachment.
 */
export function validateInstalledPerformanceEvidence(
  evidence,
  budgets,
  artifactPath,
) {
  const issues = [];
  const installed = validateInstalledBudgets(budgets);
  if (!object(evidence)) {
    throw new PerformanceEvidenceError(["evidence must be a JSON object"]);
  }

  if (evidence.schema_version !== budgets.schemaVersion) {
    issues.push(
      `schema_version must equal ${String(budgets.schemaVersion)}, got ${String(evidence.schema_version)}`,
    );
  }
  if (
    !nonEmpty(evidence.recorded_at) ||
    Number.isNaN(Date.parse(evidence.recorded_at)) ||
    new Date(evidence.recorded_at).toISOString() !== evidence.recorded_at
  ) {
    issues.push("recorded_at must be a canonical ISO-8601 UTC timestamp");
  }

  const artifact = evidence.artifact;
  if (!object(artifact)) {
    issues.push("artifact must be an object");
  } else {
    if (!nonEmpty(artifact.file_name))
      issues.push("artifact.file_name is required");
    if (!SHA256_RE.test(artifact.sha256 ?? "")) {
      issues.push("artifact.sha256 must be a lowercase SHA-256 digest");
    }
    if (!nonEmpty(artifact.version))
      issues.push("artifact.version is required");
    if (!COMMIT_RE.test(artifact.commit_sha ?? "")) {
      issues.push(
        "artifact.commit_sha must be a full 40- or 64-character digest",
      );
    }
    if (artifact.signed_and_verified !== true) {
      issues.push("artifact.signed_and_verified must be true");
    }
    if (artifact.clean_install !== true) {
      issues.push("artifact.clean_install must be true");
    }
    if (!nonEmpty(artifact.signature_verification)) {
      issues.push("artifact.signature_verification is required");
    }
    try {
      const resolvedArtifact = resolve(artifactPath);
      if (artifact.file_name !== basename(resolvedArtifact)) {
        issues.push(
          `artifact.file_name ${String(artifact.file_name)} does not match ${basename(resolvedArtifact)}`,
        );
      }
      const actualDigest = digestFile(resolvedArtifact);
      if (artifact.sha256 !== actualDigest) {
        issues.push(
          `artifact digest mismatch: evidence=${String(artifact.sha256)} actual=${actualDigest}`,
        );
      }
    } catch (error) {
      issues.push(
        `could not hash artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const environment = evidence.environment;
  const platform = environment?.platform;
  if (!object(environment)) {
    issues.push("environment must be an object");
  } else {
    const requiredTarget = installed.requiredTargets.some(
      (target) =>
        target.platform === platform &&
        target.architecture === environment.architecture,
    );
    if (!requiredTarget) {
      issues.push(
        `environment target ${targetKey(platform, environment.architecture)} is not required/supported`,
      );
    }
    for (const field of [
      "os_version",
      "architecture",
      "cpu",
      "hardware_profile",
      "webview_version",
    ]) {
      if (!nonEmpty(environment[field]))
        issues.push(`environment.${field} is required`);
    }
    const minimumWebviewVersion = installed.minimumWebviewVersions?.[platform];
    if (
      nonEmpty(minimumWebviewVersion) &&
      !versionAtLeast(environment.webview_version, minimumWebviewVersion)
    ) {
      issues.push(
        `environment.webview_version must be ${minimumWebviewVersion}+ for ${String(platform)}`,
      );
    }
    if (!nonEmpty(environment.measurement_tool)) {
      issues.push("environment.measurement_tool is required");
    }
    if (
      !finiteNonNegative(environment.memory_mib) ||
      environment.memory_mib === 0
    ) {
      issues.push("environment.memory_mib must be a positive number");
    }
    if (environment.minimum_supported_os !== true) {
      issues.push("environment.minimum_supported_os must be true");
    }
    if (environment.minimum_supported_hardware !== true) {
      issues.push("environment.minimum_supported_hardware must be true");
    }
    if (
      platform === "macos" &&
      object(artifact) &&
      !/\.dmg$/i.test(artifact.file_name ?? "")
    ) {
      issues.push("macos evidence must bind to a .dmg installer");
    }
    if (
      platform === "windows" &&
      object(artifact) &&
      !/\.(?:msi|exe)$/i.test(artifact.file_name ?? "")
    ) {
      issues.push("windows evidence must bind to a .msi or .exe installer");
    }
  }

  const runs = evidence.runs;
  if (!Array.isArray(runs) || runs.length < installed.minimumRuns) {
    issues.push(
      `runs must contain at least ${installed.minimumRuns} cold starts`,
    );
  }
  const coldLaunch = [];
  const firstInteraction = [];
  const idleRss = [];
  if (Array.isArray(runs)) {
    runs.forEach((run, index) => {
      if (!object(run)) {
        issues.push(`runs[${index}] must be an object`);
        return;
      }
      for (const [field, target] of [
        ["cold_launch_ms", coldLaunch],
        ["first_interaction_ms", firstInteraction],
        ["idle_rss_mib", idleRss],
      ]) {
        if (!finiteNonNegative(run[field]) || run[field] === 0) {
          issues.push(`runs[${index}].${field} must be a positive number`);
        } else {
          target.push(run[field]);
        }
      }
      if (
        finiteNonNegative(run.cold_launch_ms) &&
        finiteNonNegative(run.first_interaction_ms) &&
        run.first_interaction_ms < run.cold_launch_ms
      ) {
        issues.push(
          `runs[${index}].first_interaction_ms cannot be below cold_launch_ms`,
        );
      }
    });
  }

  const sustained = evidence.sustained;
  if (!object(sustained)) {
    issues.push("sustained must be an object");
  } else {
    for (const field of [
      "duration_minutes",
      "rss_start_mib",
      "rss_peak_mib",
      "rss_end_mib",
      "crash_count",
    ]) {
      if (!finiteNonNegative(sustained[field])) {
        issues.push(`sustained.${field} must be a non-negative number`);
      }
    }
    if (
      finiteNonNegative(sustained.duration_minutes) &&
      sustained.duration_minutes < installed.minimumSustainedMinutes
    ) {
      issues.push(
        `sustained.duration_minutes ${sustained.duration_minutes} is below minimum ${installed.minimumSustainedMinutes}`,
      );
    }
    if (
      finiteNonNegative(sustained.rss_peak_mib) &&
      finiteNonNegative(sustained.rss_start_mib) &&
      finiteNonNegative(sustained.rss_end_mib) &&
      sustained.rss_peak_mib <
        Math.max(sustained.rss_start_mib, sustained.rss_end_mib)
    ) {
      issues.push(
        "sustained.rss_peak_mib cannot be below rss_start_mib or rss_end_mib",
      );
    }
    if (!Number.isInteger(sustained.crash_count)) {
      issues.push("sustained.crash_count must be an integer");
    }
  }

  const summary = {
    platform,
    architecture: environment?.architecture,
    version: artifact?.version,
    commitSha: artifact?.commit_sha,
    runCount: Array.isArray(runs) ? runs.length : 0,
    coldLaunchP95Ms: coldLaunch.length ? percentile95(coldLaunch) : null,
    firstInteractionP95Ms: firstInteraction.length
      ? percentile95(firstInteraction)
      : null,
    idleRssP95MiB: idleRss.length ? percentile95(idleRss) : null,
    sustainedRssPeakMiB: finiteNonNegative(sustained?.rss_peak_mib)
      ? sustained.rss_peak_mib
      : null,
    sustainedRssGrowthMiB:
      finiteNonNegative(sustained?.rss_end_mib) &&
      finiteNonNegative(sustained?.rss_start_mib)
        ? Math.max(0, sustained.rss_end_mib - sustained.rss_start_mib)
        : null,
    crashCount: finiteNonNegative(sustained?.crash_count)
      ? sustained.crash_count
      : null,
  };

  for (const [field, budgetField] of [
    ["coldLaunchP95Ms", "coldLaunchP95Ms"],
    ["firstInteractionP95Ms", "firstInteractionP95Ms"],
    ["idleRssP95MiB", "idleRssP95MiB"],
    ["sustainedRssPeakMiB", "sustainedRssPeakMiB"],
    ["sustainedRssGrowthMiB", "sustainedRssGrowthMiB"],
    ["crashCount", "maximumCrashCount"],
  ]) {
    const actual = summary[field];
    const limit = installed[budgetField];
    if (actual !== null && actual > limit) {
      issues.push(`${field} ${actual} exceeds budget ${limit}`);
    }
  }

  if (issues.length > 0) throw new PerformanceEvidenceError(issues);
  return summary;
}

/** Validate a set and, for release use, require every supported target. */
export function verifyInstalledPerformanceEvidenceSet(
  records,
  budgets,
  { requireAllTargets = false, expectedVersion, expectedCommit } = {},
) {
  const installed = validateInstalledBudgets(budgets);
  if (requireAllTargets && !nonEmpty(expectedVersion)) {
    throw new PerformanceEvidenceError([
      "expectedVersion is required for full installed qualification",
    ]);
  }
  if (requireAllTargets && !COMMIT_RE.test(expectedCommit ?? "")) {
    throw new PerformanceEvidenceError([
      "expectedCommit must be a full digest for full installed qualification",
    ]);
  }
  const seen = new Set();
  const summaries = [];
  let releaseVersion;
  let releaseCommit;
  for (const record of records) {
    const summary = validateInstalledPerformanceEvidence(
      record.evidence,
      budgets,
      record.artifactPath,
    );
    const key = targetKey(summary.platform, summary.architecture);
    if (seen.has(key)) {
      throw new PerformanceEvidenceError([
        `duplicate evidence for target ${key}`,
      ]);
    }
    seen.add(key);
    releaseVersion ??= summary.version;
    releaseCommit ??= summary.commitSha;
    if (
      summary.version !== releaseVersion ||
      summary.commitSha !== releaseCommit
    ) {
      throw new PerformanceEvidenceError([
        `mixed release evidence: expected ${releaseVersion}@${releaseCommit}, got ${summary.version}@${summary.commitSha}`,
      ]);
    }
    if (nonEmpty(expectedVersion) && summary.version !== expectedVersion) {
      throw new PerformanceEvidenceError([
        `artifact.version ${summary.version} does not match expected ${expectedVersion}`,
      ]);
    }
    if (nonEmpty(expectedCommit) && summary.commitSha !== expectedCommit) {
      throw new PerformanceEvidenceError([
        `artifact.commit_sha ${summary.commitSha} does not match expected ${expectedCommit}`,
      ]);
    }
    summaries.push(summary);
  }
  if (requireAllTargets) {
    const missing = installed.requiredTargets
      .map((target) => targetKey(target.platform, target.architecture))
      .filter((target) => !seen.has(target));
    if (missing.length > 0) {
      throw new PerformanceEvidenceError([
        `missing installed performance evidence for targets: ${missing.join(", ")}`,
      ]);
    }
  }
  return summaries;
}

function parseArgs(argv) {
  const parsed = {
    budgetsPath: DEFAULT_BUDGETS_PATH,
    evidencePaths: [],
    artifacts: new Map(),
    requireAllTargets: false,
    expectedVersion: undefined,
    expectedCommit: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-all-targets" || arg === "--require-all-platforms") {
      parsed.requireAllTargets = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--budgets") parsed.budgetsPath = resolve(value);
    else if (arg === "--expected-version") parsed.expectedVersion = value;
    else if (arg === "--expected-commit") parsed.expectedCommit = value;
    else if (arg === "--evidence") parsed.evidencePaths.push(resolve(value));
    else if (arg === "--artifact") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("--artifact must use platform=/path/to/installer");
      }
      parsed.artifacts.set(
        value.slice(0, separator),
        resolve(value.slice(separator + 1)),
      );
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (parsed.evidencePaths.length === 0) {
    throw new Error("at least one --evidence path is required");
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const budgets = JSON.parse(readFileSync(args.budgetsPath, "utf8"));
  const records = args.evidencePaths.map((evidencePath) => {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const platform = evidence?.environment?.platform;
    const artifactPath = args.artifacts.get(platform);
    if (!artifactPath) {
      throw new Error(
        `missing --artifact ${String(platform)}=/path for ${evidencePath}`,
      );
    }
    return { evidence, artifactPath };
  });
  const summaries = verifyInstalledPerformanceEvidenceSet(records, budgets, {
    requireAllTargets: args.requireAllTargets,
    expectedVersion: args.expectedVersion,
    expectedCommit: args.expectedCommit,
  });
  for (const summary of summaries) {
    // eslint-disable-next-line no-console
    console.log(`[installed-performance] PASS ${JSON.stringify(summary)}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[installed-performance] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
