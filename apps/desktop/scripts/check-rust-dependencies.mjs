#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const rustDir = path.join(desktopDir, "src-tauri");
const policyPath = path.join(rustDir, "audit-exceptions.json");

export const SUPPORTED_TARGETS = Object.freeze([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
]);
export const EVIDENCE_TARGET = "x86_64-unknown-linux-gnu";
export const AUDIT_COMMAND = "pnpm --dir apps/desktop check:rust-dependencies";

const MAX_ACCEPTANCE_DAYS = 45;
const MAX_REVIEW_AGE_DAYS = 30;
const MAX_DATABASE_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const REMOVED_UNIC_PACKAGES = Object.freeze([
  "unic-char-property",
  "unic-char-range",
  "unic-common",
  "unic-ucd-ident",
  "unic-ucd-version",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareSets(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actual.length === actualSet.size &&
    expected.length === expectedSet.size &&
    actualSet.size === expectedSet.size &&
    [...actualSet].every((value) => expectedSet.has(value))
  );
}

function requireExactKeys(value, expected, label, issues) {
  if (!isObject(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(
      `${label} keys must be exactly [${wanted.join(", ")}], got [${actual.join(", ")}]`,
    );
    return false;
  }
  return true;
}

function parseDay(value, label, issues) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${label} must use YYYY-MM-DD`);
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    issues.push(`${label} is not a real calendar date`);
    return null;
  }
  return parsed;
}

function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

export function findingFingerprint(finding) {
  return JSON.stringify([
    finding.advisoryId,
    finding.kind,
    finding.package,
    finding.version,
    finding.checksum,
    finding.source,
    finding.advisoryDate,
    finding.advisoryUrl,
  ]);
}

export function collectPolicyIssues(policy, { today = new Date() } = {}) {
  const issues = [];
  const topKeys = [
    "schemaVersion",
    "scanner",
    "owner",
    "acceptedOn",
    "lastReviewedOn",
    "expiresOn",
    "supportedTargets",
    "evidenceTarget",
    "requiredPatch",
    "exceptions",
  ];
  if (!requireExactKeys(policy, topKeys, "policy", issues)) return issues;

  if (policy.schemaVersion !== 1) issues.push("policy.schemaVersion must be 1");
  if (typeof policy.owner !== "string" || policy.owner.trim().length < 10) {
    issues.push("policy.owner must name an accountable owner role");
  }

  if (
    requireExactKeys(
      policy.scanner,
      ["name", "version", "deny"],
      "policy.scanner",
      issues,
    )
  ) {
    if (policy.scanner.name !== "cargo-audit")
      issues.push("policy.scanner.name must be cargo-audit");
    if (policy.scanner.version !== "0.22.2")
      issues.push("policy.scanner.version must be 0.22.2");
    if (policy.scanner.deny !== "warnings")
      issues.push("policy.scanner.deny must be warnings");
  }

  const accepted = parseDay(policy.acceptedOn, "policy.acceptedOn", issues);
  const reviewed = parseDay(
    policy.lastReviewedOn,
    "policy.lastReviewedOn",
    issues,
  );
  const expires = parseDay(policy.expiresOn, "policy.expiresOn", issues);
  const todayDay = new Date(
    `${today.toISOString().slice(0, 10)}T00:00:00.000Z`,
  );
  if (accepted && reviewed && reviewed < accepted)
    issues.push("policy.lastReviewedOn cannot precede acceptedOn");
  if (reviewed && expires && expires < reviewed)
    issues.push("policy.expiresOn cannot precede lastReviewedOn");
  if (
    accepted &&
    expires &&
    daysBetween(accepted, expires) > MAX_ACCEPTANCE_DAYS
  ) {
    issues.push(
      `policy acceptance may last at most ${MAX_ACCEPTANCE_DAYS} days`,
    );
  }
  if (reviewed && daysBetween(reviewed, todayDay) > MAX_REVIEW_AGE_DAYS) {
    issues.push(`policy review is older than ${MAX_REVIEW_AGE_DAYS} days`);
  }
  if (expires && todayDay > expires)
    issues.push(`policy expired on ${policy.expiresOn}`);
  if (accepted && accepted > todayDay)
    issues.push("policy.acceptedOn cannot be in the future");
  if (reviewed && reviewed > todayDay)
    issues.push("policy.lastReviewedOn cannot be in the future");

  if (
    !Array.isArray(policy.supportedTargets) ||
    !compareSets(policy.supportedTargets, SUPPORTED_TARGETS)
  ) {
    issues.push(
      `policy.supportedTargets must be exactly ${SUPPORTED_TARGETS.join(", ")}`,
    );
  }
  if (policy.evidenceTarget !== EVIDENCE_TARGET) {
    issues.push(`policy.evidenceTarget must be ${EVIDENCE_TARGET}`);
  }

  const patchKeys = [
    "package",
    "version",
    "source",
    "upstreamCommit",
    "replacementDependency",
    "removedPackages",
  ];
  if (
    requireExactKeys(
      policy.requiredPatch,
      patchKeys,
      "policy.requiredPatch",
      issues,
    )
  ) {
    if (
      policy.requiredPatch.package !== "tauri-utils" ||
      policy.requiredPatch.version !== "2.9.3"
    ) {
      issues.push("policy.requiredPatch must pin tauri-utils 2.9.3");
    }
    const sourceMatch =
      typeof policy.requiredPatch.source === "string"
        ? policy.requiredPatch.source.match(
            /^git\+https:\/\/github\.com\/tauri-apps\/tauri\?rev=([0-9a-f]{40})#([0-9a-f]{40})$/,
          )
        : null;
    if (!sourceMatch) {
      issues.push(
        "policy.requiredPatch.source must pin an immutable full Tauri commit",
      );
    } else if (sourceMatch[1] !== sourceMatch[2]) {
      issues.push(
        "policy.requiredPatch.source revision and resolved commit must match",
      );
    }
    const upstreamMatch =
      typeof policy.requiredPatch.upstreamCommit === "string"
        ? policy.requiredPatch.upstreamCommit.match(
            /^https:\/\/github\.com\/tauri-apps\/tauri\/commit\/([0-9a-f]{40})$/,
          )
        : null;
    if (!upstreamMatch) {
      issues.push(
        "policy.requiredPatch.upstreamCommit must link the immutable upstream commit",
      );
    } else if (sourceMatch && upstreamMatch[1] !== sourceMatch[1]) {
      issues.push(
        "policy.requiredPatch.upstreamCommit must match the pinned source revision",
      );
    }
    if (
      requireExactKeys(
        policy.requiredPatch.replacementDependency,
        ["package", "version"],
        "policy.requiredPatch.replacementDependency",
        issues,
      ) &&
      (policy.requiredPatch.replacementDependency.package !== "urlpattern" ||
        policy.requiredPatch.replacementDependency.version !== "0.6.0")
    ) {
      issues.push(
        "policy.requiredPatch.replacementDependency must be urlpattern 0.6.0",
      );
    }
    if (
      !Array.isArray(policy.requiredPatch.removedPackages) ||
      !compareSets(policy.requiredPatch.removedPackages, REMOVED_UNIC_PACKAGES)
    ) {
      issues.push(
        `policy.requiredPatch.removedPackages must be exactly ${REMOVED_UNIC_PACKAGES.join(", ")}`,
      );
    }
  }

  if (!Array.isArray(policy.exceptions) || policy.exceptions.length === 0) {
    issues.push("policy.exceptions must be a non-empty array");
    return issues;
  }
  const entryKeys = [
    "advisoryId",
    "kind",
    "package",
    "version",
    "checksum",
    "source",
    "advisoryDate",
    "advisoryUrl",
    "rationale",
    "removalTrigger",
  ];
  const advisoryIds = new Set();
  const fingerprints = new Set();
  for (const [index, entry] of policy.exceptions.entries()) {
    const label = `policy.exceptions[${index}]`;
    if (!requireExactKeys(entry, entryKeys, label, issues)) continue;
    if (!/^RUSTSEC-\d{4}-\d{4}$/.test(entry.advisoryId))
      issues.push(`${label}.advisoryId is invalid`);
    if (
      !new Set(["vulnerability", "unmaintained", "unsound", "notice"]).has(
        entry.kind,
      )
    ) {
      issues.push(`${label}.kind is invalid`);
    }
    if (typeof entry.package !== "string" || entry.package.length === 0)
      issues.push(`${label}.package is required`);
    if (typeof entry.version !== "string" || entry.version.length === 0)
      issues.push(`${label}.version is required`);
    if (!/^[0-9a-f]{64}$/.test(entry.checksum))
      issues.push(`${label}.checksum must be a SHA-256 hex digest`);
    if (entry.source !== REGISTRY_SOURCE)
      issues.push(`${label}.source must be the crates.io registry`);
    parseDay(entry.advisoryDate, `${label}.advisoryDate`, issues);
    if (
      typeof entry.advisoryUrl !== "string" ||
      !entry.advisoryUrl.startsWith("https://")
    ) {
      issues.push(`${label}.advisoryUrl must be HTTPS`);
    }
    if (
      typeof entry.rationale !== "string" ||
      entry.rationale.trim().length < 80
    ) {
      issues.push(
        `${label}.rationale must document target reachability in detail`,
      );
    }
    if (
      typeof entry.removalTrigger !== "string" ||
      entry.removalTrigger.trim().length < 40
    ) {
      issues.push(`${label}.removalTrigger must be actionable`);
    }
    if (advisoryIds.has(entry.advisoryId))
      issues.push(`${label}.advisoryId is duplicated`);
    advisoryIds.add(entry.advisoryId);
    const fingerprint = findingFingerprint(entry);
    if (fingerprints.has(fingerprint))
      issues.push(`${label} has a duplicate fingerprint`);
    fingerprints.add(fingerprint);
  }
  return issues;
}

export function flattenAuditFindings(report) {
  if (
    !isObject(report) ||
    !isObject(report.vulnerabilities) ||
    !Array.isArray(report.vulnerabilities.list)
  ) {
    throw new Error("cargo-audit JSON is missing vulnerabilities.list");
  }
  if (!isObject(report.warnings))
    throw new Error("cargo-audit JSON is missing warnings");

  const findings = [];
  const add = (item, kind) => {
    if (
      !isObject(item) ||
      !isObject(item.advisory) ||
      !isObject(item.package)
    ) {
      throw new Error(`cargo-audit emitted a malformed ${kind} finding`);
    }
    const finding = {
      advisoryId: item.advisory.id,
      kind,
      package: item.package.name,
      version: item.package.version,
      checksum: item.package.checksum,
      source: item.package.source,
      advisoryDate: item.advisory.date,
      advisoryUrl: item.advisory.url,
    };
    if (
      Object.values(finding).some(
        (value) => typeof value !== "string" || value.length === 0,
      )
    ) {
      throw new Error(
        `cargo-audit finding ${item.advisory.id ?? "<unknown>"} has an incomplete fingerprint`,
      );
    }
    findings.push(finding);
  };
  for (const item of report.vulnerabilities.list) add(item, "vulnerability");
  for (const [kind, entries] of Object.entries(report.warnings)) {
    if (!Array.isArray(entries))
      throw new Error(`cargo-audit warnings.${kind} must be an array`);
    for (const item of entries) add(item, kind);
  }
  return findings;
}

export function compareFindings(actualFindings, expectedEntries) {
  const actual = new Map();
  const expected = new Map();
  const issues = [];
  for (const finding of actualFindings) {
    const fingerprint = findingFingerprint(finding);
    if (actual.has(fingerprint))
      issues.push(`cargo-audit repeated finding ${fingerprint}`);
    actual.set(fingerprint, finding);
  }
  for (const entry of expectedEntries)
    expected.set(findingFingerprint(entry), entry);
  for (const [fingerprint, finding] of actual) {
    if (!expected.has(fingerprint)) {
      issues.push(
        `unexpected finding: ${finding.advisoryId} ${finding.kind} ${finding.package}@${finding.version} ${finding.checksum}`,
      );
    }
  }
  for (const [fingerprint, entry] of expected) {
    if (!actual.has(fingerprint)) {
      issues.push(
        `stale or changed exception: ${entry.advisoryId} ${entry.kind} ${entry.package}@${entry.version} ${entry.checksum}`,
      );
    }
  }
  return issues;
}

export function collectAuditReportIssues(report, { today = new Date() } = {}) {
  const issues = [];
  const topKeys = [
    "database",
    "lockfile",
    "settings",
    "vulnerabilities",
    "warnings",
  ];
  requireExactKeys(report, topKeys, "cargo-audit report", issues);
  if (!isObject(report.database)) {
    issues.push("cargo-audit report.database must be an object");
  } else {
    if (
      !Number.isInteger(report.database["advisory-count"]) ||
      report.database["advisory-count"] <= 0
    ) {
      issues.push("cargo-audit advisory database must be non-empty");
    }
    if (!/^[0-9a-f]{40}$/.test(report.database["last-commit"] ?? "")) {
      issues.push("cargo-audit advisory database commit is missing or mutable");
    }
    const updated = new Date(report.database["last-updated"]);
    if (Number.isNaN(updated.getTime())) {
      issues.push("cargo-audit advisory database timestamp is invalid");
    } else {
      const age = Math.floor((today.getTime() - updated.getTime()) / DAY_MS);
      if (age > MAX_DATABASE_AGE_DAYS)
        issues.push(`cargo-audit advisory database is ${age} days old`);
      if (age < -1)
        issues.push("cargo-audit advisory database timestamp is in the future");
    }
  }
  if (
    !isObject(report.lockfile) ||
    !Number.isInteger(report.lockfile["dependency-count"]) ||
    report.lockfile["dependency-count"] <= 0
  ) {
    issues.push("cargo-audit reported an empty or malformed lockfile graph");
  }
  if (!isObject(report.settings)) {
    issues.push("cargo-audit report.settings must be an object");
  } else {
    if (
      !Array.isArray(report.settings.ignore) ||
      report.settings.ignore.length !== 0
    ) {
      issues.push("raw cargo-audit scan must not contain ignored advisories");
    }
    if (
      !Array.isArray(report.settings.target_arch) ||
      report.settings.target_arch.length !== 0
    ) {
      issues.push(
        "raw cargo-audit scan must inspect the complete lockfile without target_arch filtering",
      );
    }
    if (
      !Array.isArray(report.settings.target_os) ||
      report.settings.target_os.length !== 0
    ) {
      issues.push(
        "raw cargo-audit scan must inspect the complete lockfile without target_os filtering",
      );
    }
    const requiredWarnings = ["notice", "unmaintained", "unsound"];
    if (
      !Array.isArray(report.settings.informational_warnings) ||
      !compareSets(report.settings.informational_warnings, requiredWarnings)
    ) {
      issues.push(
        "raw cargo-audit scan must enable every informational warning category",
      );
    }
  }
  return issues;
}

export function collectWorkflowIssues({ ci, release }) {
  const issues = [];
  const installCommand = "cargo install cargo-audit --version 0.22.2 --locked";
  for (const [name, source] of Object.entries({ ci, release })) {
    const auditCommandCount = source.split(`run: ${AUDIT_COMMAND}`).length - 1;
    if (auditCommandCount !== 1)
      issues.push(
        `${name} workflow must invoke the shared Rust dependency gate exactly once`,
      );
    const installCount = source.split(`run: ${installCommand}`).length - 1;
    if (installCount !== 1)
      issues.push(
        `${name} workflow must install cargo-audit 0.22.2 exactly once`,
      );
    if (/run:\s*[^\n]*\bcargo audit\b/.test(source))
      issues.push(
        `${name} workflow must not bypass the shared gate with inline cargo audit`,
      );
    if (/run:\s*[^\n]*--ignore\b/.test(source))
      issues.push(`${name} workflow must not contain inline advisory ignores`);
  }
  const releaseTargets = [
    ...release.matchAll(/^\s*rust_targets:\s*["']([^"']+)["']\s*$/gm),
  ]
    .flatMap((match) => match[1].split(","))
    .map((target) => target.trim());
  if (!compareSets(releaseTargets, SUPPORTED_TARGETS)) {
    issues.push(
      `release workflow Rust targets must be exactly ${SUPPORTED_TARGETS.join(", ")}`,
    );
  }
  const releasePlatforms = [
    ...release.matchAll(/^\s*-\s+platform:\s*([^\s#]+)\s*$/gm),
  ].map((match) => match[1]);
  if (!compareSets(releasePlatforms, ["macos-14", "windows-2022"])) {
    issues.push(
      "release workflow runner matrix must be exactly macos-14 and windows-2022",
    );
  }
  return issues;
}

export function reachablePackages(metadata) {
  if (
    !isObject(metadata) ||
    !Array.isArray(metadata.packages) ||
    !isObject(metadata.resolve)
  ) {
    throw new Error("cargo metadata output is malformed");
  }
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(
    metadata.resolve.nodes.map((node) => [node.id, node]),
  );
  const pending = [metadata.resolve.root];
  const seen = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = nodesById.get(id);
    if (!node)
      throw new Error(`cargo metadata resolve node is missing for ${id}`);
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((entry) => entry.kind !== "dev"))
        pending.push(dependency.pkg);
    }
  }
  return [...seen].map((id) => packagesById.get(id)).filter(Boolean);
}

export function collectPatchIssues(metadata, patch) {
  const issues = [];
  const patched = metadata.packages.filter(
    (pkg) =>
      pkg.name === patch.package &&
      pkg.version === patch.version &&
      pkg.source === patch.source,
  );
  if (patched.length !== 1)
    issues.push(
      `Cargo metadata must contain exactly one ${patch.package}@${patch.version} from the reviewed commit`,
    );
  const replacement = metadata.packages.filter(
    (pkg) =>
      pkg.name === patch.replacementDependency.package &&
      pkg.version === patch.replacementDependency.version &&
      pkg.source === REGISTRY_SOURCE,
  );
  if (replacement.length !== 1) {
    issues.push(
      `Cargo metadata must contain exactly one ${patch.replacementDependency.package}@${patch.replacementDependency.version}`,
    );
  }
  if (patched.length === 1 && replacement.length === 1) {
    const node = metadata.resolve.nodes.find(
      (entry) => entry.id === patched[0].id,
    );
    if (
      !node?.deps.some(
        (dependency) =>
          dependency.pkg === replacement[0].id &&
          dependency.dep_kinds.some((entry) => entry.kind !== "dev"),
      )
    ) {
      issues.push(
        `${patch.package}@${patch.version} must directly depend on the reviewed replacement ${patch.replacementDependency.package}@${patch.replacementDependency.version}`,
      );
    }
  }
  for (const removed of patch.removedPackages) {
    if (metadata.packages.some((pkg) => pkg.name === removed))
      issues.push(`removed package ${removed} returned to Cargo.lock`);
  }
  return issues;
}

function run(command, args, { cwd = repoRoot, expectedStatus = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
  });
  if (result.error)
    throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.signal)
    throw new Error(`${command} was terminated by ${result.signal}`);
  if (result.status !== expectedStatus) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}, expected ${expectedStatus}${output ? `\n${output}` : ""}`,
    );
  }
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${error.message}`);
  }
}

function assertNoIssues(issues, label) {
  if (issues.length > 0) throw new Error(`${label}:\n- ${issues.join("\n- ")}`);
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function loadMetadata(target) {
  const args = ["metadata", "--locked", "--format-version", "1"];
  if (target) args.push("--filter-platform", target);
  return parseJsonOutput(
    run("cargo", args, { cwd: rustDir }),
    `cargo metadata for ${target ?? "all targets"}`,
  );
}

function checkReachability(metadata, policy, target, shouldContainExceptions) {
  const packages = reachablePackages(metadata);
  const has = (entry) =>
    packages.some(
      (pkg) =>
        pkg.name === entry.package &&
        pkg.version === entry.version &&
        pkg.source === entry.source,
    );
  const issues = [];
  for (const entry of policy.exceptions) {
    if (has(entry) !== shouldContainExceptions) {
      issues.push(
        `${entry.package}@${entry.version} must ${shouldContainExceptions ? "be present on" : "be absent from"} ${target}`,
      );
    }
  }
  for (const required of [
    policy.requiredPatch,
    policy.requiredPatch.replacementDependency,
  ]) {
    if (
      !packages.some(
        (pkg) =>
          pkg.name === required.package && pkg.version === required.version,
      )
    ) {
      issues.push(
        `${required.package}@${required.version} must be reachable on ${target}`,
      );
    }
  }
  return issues;
}

export function main({ today = new Date() } = {}) {
  const policy = loadPolicy();
  assertNoIssues(
    collectPolicyIssues(policy, { today }),
    "Rust audit policy is invalid",
  );

  const workflows = {
    ci: fs.readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-ci.yml"),
      "utf8",
    ),
    release: fs.readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-release.yml"),
      "utf8",
    ),
  };
  assertNoIssues(
    collectWorkflowIssues(workflows),
    "Desktop workflow contract is invalid",
  );

  const version = run("cargo", ["audit", "--version"], {
    cwd: rustDir,
  }).stdout.trim();
  if (!version.endsWith(` ${policy.scanner.version}`)) {
    throw new Error(
      `cargo-audit ${policy.scanner.version} is required, got ${version || "no version output"}`,
    );
  }

  const rawResult = run(
    "cargo",
    ["audit", "--deny", policy.scanner.deny, "--json"],
    {
      cwd: rustDir,
      expectedStatus: 1,
    },
  );
  const report = parseJsonOutput(rawResult, "raw cargo audit");
  assertNoIssues(
    collectAuditReportIssues(report, { today }),
    "Raw cargo-audit report is invalid",
  );
  const findings = flattenAuditFindings(report);
  assertNoIssues(
    compareFindings(findings, policy.exceptions),
    "RustSec exception fingerprint mismatch",
  );

  const allMetadata = loadMetadata();
  assertNoIssues(
    collectPatchIssues(allMetadata, policy.requiredPatch),
    "Tauri dependency patch is invalid",
  );
  for (const target of policy.supportedTargets) {
    assertNoIssues(
      checkReachability(loadMetadata(target), policy, target, false),
      `Supported-target reachability failed for ${target}`,
    );
  }
  assertNoIssues(
    checkReachability(
      loadMetadata(policy.evidenceTarget),
      policy,
      policy.evidenceTarget,
      true,
    ),
    `Evidence-target reachability failed for ${policy.evidenceTarget}`,
  );

  const ignoreArgs = policy.exceptions.flatMap((entry) => [
    "--ignore",
    entry.advisoryId,
  ]);
  run("cargo", ["audit", "--deny", policy.scanner.deny, ...ignoreArgs], {
    cwd: rustDir,
  });

  console.log(
    `Rust dependency gate passed: ${findings.length} exact, unexpired lockfile-only exceptions; ` +
      `${policy.supportedTargets.length} release target graphs are clean; Tauri urlpattern 0.6 patch is pinned.`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`Rust dependency gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
