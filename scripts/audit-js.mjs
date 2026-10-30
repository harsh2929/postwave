#!/usr/bin/env node
// Fail-closed policy gate for production JavaScript dependency advisories.
//
// npm retired the legacy audit endpoint used by pnpm <=10 in July 2026. The
// project remains on pnpm 9 for installs, but this read-only gate invokes an
// integrity-pinned pnpm 11.4 CLI, which uses npm's bulk advisory endpoint.
// Registry failures, malformed JSON, hidden ignores, and schema/count drift
// are failures rather than empty-report successes.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import semver from "semver";
import { parse as parseYaml } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const REGISTER_PATH = resolve(ROOT, "config/dependency-risk-register.json");
const REGISTER_SCHEMA_PATH = resolve(
  ROOT,
  "config/schemas/dependency-risk-register.schema.json",
);
const PACKAGE_PATH = resolve(ROOT, "package.json");
const NPMRC_PATH = resolve(ROOT, ".npmrc");
const WORKSPACE_PATH = resolve(ROOT, "pnpm-workspace.yaml");
const REGISTER_SCHEMA_REFERENCE =
  "./schemas/dependency-risk-register.schema.json";
const REGISTER_SCHEMA_ID =
  "https://moosewave.com/schemas/dependency-risk-register.schema.json";
const PINNED_PNPM_VERSION = "9.12.0";
const PINNED_AUDIT_PNPM_VERSION = "11.4.0";
const PINNED_AUDIT_PNPM_SPEC =
  "pnpm@11.4.0+sha512.f0febc7e37552ab485494a914241b338e0b3580b93d54ce31f00933015880863129038a1b4ae4e414a0ee63ac35bf21197e990172c4a68256450b5636310968f";
const PINNED_AUDIT_REGISTRY = "https://registry.npmjs.org/";
const PNPM_11_IGNORED_ROOT_CONFIG_WARNING =
  '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides", "pnpm.patchedDependencies". See https://pnpm.io/settings for the new home of each setting.';
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
// `pnpm audit --audit-level moderate` keeps the complete severity totals in
// metadata but intentionally omits the advisory bodies below the requested
// reporting floor.  Comparing those omitted info/low bodies for exact equality
// turns a healthy pnpm 11 report into a false schema-drift failure.  Moderate+
// remains exact and fail-closed; the command arguments that establish this
// floor are integrity-pinned in runPnpmAudit and covered by its contract test.
const BULK_AUDIT_REPORTING_FLOOR = "moderate";
const POLICY_FIELDS = [
  "ecosystem",
  "scope",
  "minimumSeverity",
  "maximumAcceptanceDays",
  "maximumReviewAgeDays",
];
const RISK_FIELDS = [
  "decision",
  "registryAuditId",
  "advisory",
  "aliases",
  "module",
  "severity",
  "expectedLatestStableVersion",
  "expectedVulnerableVersions",
  "expectedPatchedVersions",
  "expectedFindingVersions",
  "findingPaths",
  "affectedImporters",
  "ownerRole",
  "acceptedOn",
  "lastReviewedOn",
  "expiresOn",
  "rationale",
  "upgradeTrigger",
  "upstreamUrl",
  "compensatingControls",
];
const CONTROL_FIELDS = [
  "id",
  "description",
  "evidenceFiles",
  "verificationCommands",
];
const LEGACY_ADVISORY_FIELDS = [
  "findings",
  "found_by",
  "deleted",
  "references",
  "created",
  "metadata",
  "npm_advisory_id",
  "reported_by",
  "vulnerable_versions",
  "module_name",
  "severity",
  "github_advisory_id",
  "cves",
  "access",
  "patched_versions",
  "title",
  "recommendation",
  "overview",
  "url",
  "id",
  "updated",
  "cvss",
  "cwe",
];
const BULK_ADVISORY_FIELDS = [
  "findings",
  "id",
  "title",
  "module_name",
  "vulnerable_versions",
  "patched_versions",
  "severity",
  "cwe",
  "github_advisory_id",
  "url",
];
const BULK_FINDING_FIELDS = ["version", "paths", "dev", "optional", "bundled"];
const SEVERITY_RANK = new Map(
  SEVERITIES.map((severity, index) => [severity, index]),
);

export class DependencyAuditPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DependencyAuditPolicyError";
  }
}

export function parseJsonDocument(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DependencyAuditPolicyError(
      `${label} is not valid JSON: ${detail}`,
    );
  }
}

export function parseYamlDocument(source, label) {
  try {
    return parseYaml(source, { prettyErrors: true, uniqueKeys: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DependencyAuditPolicyError(
      `${label} is not valid YAML: ${detail}`,
    );
  }
}

export function assertNoHiddenAuditConfiguration(manifest, npmrc = "") {
  if (!isRecord(manifest)) fail("package.json must contain a JSON object");
  if (manifest.packageManager !== `pnpm@${PINNED_PNPM_VERSION}`) {
    fail(`package.json packageManager must pin pnpm@${PINNED_PNPM_VERSION}`);
  }
  if (Object.hasOwn(manifest, "auditConfig")) {
    fail(
      "package.json auditConfig is forbidden; accepted findings belong in config/dependency-risk-register.json",
    );
  }
  const pnpm = manifest.pnpm;
  if (isRecord(pnpm) && Object.hasOwn(pnpm, "auditConfig")) {
    fail(
      "package.json pnpm.auditConfig is forbidden; accepted findings belong in config/dependency-risk-register.json",
    );
  }
  if (isRecord(pnpm)) {
    const forbiddenPnpmKeys = findForbiddenConfigurationKeys(pnpm, "pnpm");
    if (forbiddenPnpmKeys.length > 0) {
      fail(
        `package.json pnpm configuration contains forbidden audit suppression(s): ${forbiddenPnpmKeys.join(", ")}`,
      );
    }
  }

  const forbiddenNpmrc = npmrc
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s*[#;].*$/u, "").trim())
    .filter(Boolean)
    .filter((line) => isForbiddenConfigAssignment(line));
  if (forbiddenNpmrc.length > 0) {
    fail(
      `.npmrc contains forbidden audit suppression: ${forbiddenNpmrc.join(", ")}`,
    );
  }
}

export function assertNoHiddenWorkspaceAuditConfiguration(workspace) {
  const root = requireRecord(workspace, "pnpm-workspace.yaml");
  const forbidden = findForbiddenConfigurationKeys(root, "workspace");
  if (forbidden.length > 0) {
    fail(
      `pnpm-workspace.yaml contains forbidden audit suppression(s): ${forbidden.join(", ")}`,
    );
  }
}

export function assertNoHiddenAuditEnvironment(environment = process.env) {
  const forbidden = Object.entries(environment)
    .filter(([key]) => /^(?:npm|pnpm)_config_/iu.test(key))
    .filter(([key, value]) =>
      isForbiddenConfigValue(
        normalizeConfigKey(key.replace(/^(?:npm|pnpm)_config_/iu, "")),
        String(value ?? ""),
      ),
    )
    .map(([key]) => key)
    .sort();
  if (forbidden.length > 0) {
    fail(
      `environment contains forbidden audit suppression variable(s): ${forbidden.join(", ")}`,
    );
  }
}

export function validatePnpmVersion(version) {
  if (version !== PINNED_PNPM_VERSION) {
    fail(
      `pnpm ${PINNED_PNPM_VERSION} is required, but ${String(version)} is active`,
    );
  }
}

export function validatePnpmRegistry(registry) {
  if (registry !== PINNED_AUDIT_REGISTRY) {
    fail(
      `pnpm audit registry must be ${PINNED_AUDIT_REGISTRY}, but ${String(registry)} is active`,
    );
  }
}

export function runPnpmVersion(spawn = spawnSync) {
  const result = spawn("pnpm", ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const version = parseSuccessfulTextCommand(
    result,
    "pnpm --version",
    "toolchain",
  );
  validatePnpmVersion(version);
  return version;
}

export function validateEffectivePnpmConfiguration(configuration) {
  const config = requireRecord(configuration, "effective pnpm configuration");
  validatePnpmRegistry(config.registry);
  const forbidden = [];
  const alternateRegistries = [];
  for (const [key, value] of Object.entries(config)) {
    const normalizedKey = normalizeConfigKey(key);
    if (isForbiddenConfigValue(normalizedKey, String(value ?? ""))) {
      forbidden.push(key);
    }
    if (
      normalizedKey.endsWith("registry") &&
      String(value) !== PINNED_AUDIT_REGISTRY
    ) {
      alternateRegistries.push(key);
    }
  }
  if (forbidden.length > 0) {
    fail(
      `effective pnpm configuration contains forbidden audit suppression(s): ${forbidden.sort().join(", ")}`,
    );
  }
  if (alternateRegistries.length > 0) {
    fail(
      `effective pnpm configuration contains alternate registry source(s): ${alternateRegistries.sort().join(", ")}`,
    );
  }
  return configuration;
}

export function runPnpmConfiguration(spawn = spawnSync) {
  const result = spawn("pnpm", ["config", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const stdout = parseSuccessfulCommand(
    result,
    "pnpm config list --json",
    "configuration",
  );
  return validateEffectivePnpmConfiguration(
    parseJsonDocument(stdout, "effective pnpm configuration"),
  );
}

export function validateRiskRegisterSchema(schema) {
  const root = requireRecord(schema, "dependency risk register schema");
  requireOnlyKeys(
    root,
    [
      "$schema",
      "$id",
      "title",
      "type",
      "additionalProperties",
      "required",
      "properties",
      "$defs",
    ],
    "dependency risk register schema",
  );
  if (root.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    fail("dependency risk register schema must use JSON Schema 2020-12");
  }
  if (root.$id !== REGISTER_SCHEMA_ID) {
    fail(`dependency risk register schema $id must be ${REGISTER_SCHEMA_ID}`);
  }
  if (root.type !== "object" || root.additionalProperties !== false) {
    fail("dependency risk register schema root must be a closed object");
  }
  assertExactSet(
    root.required,
    ["$schema", "schemaVersion", "policy", "acceptedRisks"],
    "dependency risk register schema root required fields",
  );
  const properties = requireRecord(
    root.properties,
    "dependency risk register schema properties",
  );
  assertExactSet(
    Object.keys(properties),
    ["$schema", "schemaVersion", "policy", "acceptedRisks"],
    "dependency risk register schema root properties",
  );
  if (properties.$schema?.const !== REGISTER_SCHEMA_REFERENCE) {
    fail(
      `dependency risk register schema must require $schema=${REGISTER_SCHEMA_REFERENCE}`,
    );
  }
  if (properties.schemaVersion?.const !== 1) {
    fail("dependency risk register schema must require schemaVersion 1");
  }

  const policySchema = requireRecord(
    properties.policy,
    "dependency risk register policy schema",
  );
  assertClosedSchemaFields(policySchema, POLICY_FIELDS, "policy schema");
  const policyProperties = requireRecord(
    policySchema.properties,
    "policy schema properties",
  );
  if (
    policyProperties.ecosystem?.const !== "npm" ||
    policyProperties.scope?.const !== "production"
  ) {
    fail("policy schema ecosystem/scope constants drifted");
  }
  if (policyProperties.minimumSeverity?.const !== "moderate") {
    fail("policy schema minimumSeverity must remain moderate");
  }
  if (
    policyProperties.maximumAcceptanceDays?.const !== 45 ||
    policyProperties.maximumReviewAgeDays?.const !== 30
  ) {
    fail("policy schema acceptance/review limits drifted");
  }

  const definitions = requireRecord(root.$defs, "dependency risk schema $defs");
  const controlSchema = requireRecord(
    definitions.control,
    "dependency risk control schema",
  );
  assertClosedSchemaFields(controlSchema, CONTROL_FIELDS, "control schema");
  const controlProperties = requireRecord(
    controlSchema.properties,
    "control schema properties",
  );
  if (
    controlProperties.description?.type !== "string" ||
    controlProperties.description.minLength !== 20
  ) {
    fail("control schema description minimum drifted");
  }
  const riskSchema = requireRecord(
    definitions.risk,
    "dependency risk item schema",
  );
  assertClosedSchemaFields(riskSchema, RISK_FIELDS, "risk schema");
  const riskProperties = requireRecord(
    riskSchema.properties,
    "risk schema properties",
  );
  if (
    riskProperties.decision?.const !== "temporarily_accepted_until_stable_fix"
  ) {
    fail("risk schema decision constant drifted");
  }
  assertExactSet(
    riskProperties.severity?.enum,
    ["moderate", "high", "critical"],
    "risk schema severity enum",
  );
  if (
    riskProperties.ownerRole?.const !== "Security Engineering" ||
    riskProperties.rationale?.minLength !== 40 ||
    riskProperties.upgradeTrigger?.minLength !== 40
  ) {
    fail("risk schema ownership/rationale minimums drifted");
  }
  return schema;
}

export function validateRiskRegister(register, options = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  requireDate(today, "current policy date");
  requireRecord(register, "dependency risk register");
  requireOnlyKeys(
    register,
    ["$schema", "schemaVersion", "policy", "acceptedRisks"],
    "register",
  );
  if (register.$schema !== REGISTER_SCHEMA_REFERENCE) {
    fail(`register.$schema must be ${REGISTER_SCHEMA_REFERENCE}`);
  }
  if (register.schemaVersion !== 1) fail("register.schemaVersion must be 1");

  const policy = requireRecord(register.policy, "register.policy");
  requireOnlyKeys(policy, POLICY_FIELDS, "register.policy");
  if (policy.ecosystem !== "npm")
    fail('register.policy.ecosystem must be "npm"');
  if (policy.scope !== "production")
    fail('register.policy.scope must be "production"');
  if (policy.minimumSeverity !== "moderate")
    fail("register.policy.minimumSeverity must be moderate");
  if (policy.maximumAcceptanceDays !== 45) {
    fail("register.policy.maximumAcceptanceDays must be 45");
  }
  if (policy.maximumReviewAgeDays !== 30) {
    fail("register.policy.maximumReviewAgeDays must be 30");
  }

  if (!Array.isArray(register.acceptedRisks))
    fail("register.acceptedRisks must be an array");
  const seenRisks = new Set();

  for (const [index, riskValue] of register.acceptedRisks.entries()) {
    const label = `register.acceptedRisks[${index}]`;
    const risk = requireRecord(riskValue, label);
    requireOnlyKeys(risk, RISK_FIELDS, label);
    if (risk.decision !== "temporarily_accepted_until_stable_fix") {
      fail(`${label}.decision is not an accepted temporary-risk decision`);
    }
    requireBoundedInteger(
      risk.registryAuditId,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.registryAuditId`,
    );
    requirePattern(risk.advisory, /^GHSA-[a-z0-9-]+$/u, `${label}.advisory`);
    requireString(risk.module, `${label}.module`);
    if (!SEVERITY_RANK.has(risk.severity)) fail(`${label}.severity is invalid`);
    if (severityRank(risk.severity) < severityRank(policy.minimumSeverity)) {
      fail(`${label}.severity is below the policy threshold`);
    }
    requireString(
      risk.expectedLatestStableVersion,
      `${label}.expectedLatestStableVersion`,
    );
    requireString(
      risk.expectedVulnerableVersions,
      `${label}.expectedVulnerableVersions`,
    );
    requireString(
      risk.expectedPatchedVersions,
      `${label}.expectedPatchedVersions`,
    );
    requireStableSemver(
      risk.expectedLatestStableVersion,
      `${label}.expectedLatestStableVersion`,
    );
    requireSemverRange(
      risk.expectedVulnerableVersions,
      `${label}.expectedVulnerableVersions`,
    );
    requireSemverRange(
      risk.expectedPatchedVersions,
      `${label}.expectedPatchedVersions`,
    );
    requireUniqueStrings(risk.aliases, `${label}.aliases`, {
      allowEmpty: true,
    });
    for (const [aliasIndex, alias] of risk.aliases.entries()) {
      requirePattern(
        alias,
        /^CVE-\d{4}-\d{4,}$/u,
        `${label}.aliases[${aliasIndex}]`,
      );
    }
    requireUniqueStrings(
      risk.expectedFindingVersions,
      `${label}.expectedFindingVersions`,
    );
    for (const [
      versionIndex,
      version,
    ] of risk.expectedFindingVersions.entries()) {
      requireSemver(
        version,
        `${label}.expectedFindingVersions[${versionIndex}]`,
      );
      if (!semver.satisfies(version, risk.expectedVulnerableVersions)) {
        fail(
          `${label}.expectedFindingVersions[${versionIndex}] is outside expectedVulnerableVersions`,
        );
      }
    }
    requireUniqueStrings(risk.findingPaths, `${label}.findingPaths`);
    requireUniqueStrings(risk.affectedImporters, `${label}.affectedImporters`);
    if (risk.ownerRole !== "Security Engineering") {
      fail(`${label}.ownerRole must be Security Engineering`);
    }
    requireString(risk.rationale, `${label}.rationale`, 40);
    requireString(risk.upgradeTrigger, `${label}.upgradeTrigger`, 40);
    requirePattern(
      risk.upstreamUrl,
      /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/u,
      `${label}.upstreamUrl`,
    );
    if (risk.upstreamUrl !== `https://github.com/advisories/${risk.advisory}`) {
      fail(`${label}.upstreamUrl does not match advisory`);
    }

    requireDate(risk.acceptedOn, `${label}.acceptedOn`);
    requireDate(risk.lastReviewedOn, `${label}.lastReviewedOn`);
    requireDate(risk.expiresOn, `${label}.expiresOn`);
    if (risk.lastReviewedOn < risk.acceptedOn)
      fail(`${label}.lastReviewedOn precedes acceptedOn`);
    if (risk.lastReviewedOn > today)
      fail(`${label}.lastReviewedOn is in the future`);
    if (risk.expiresOn < risk.acceptedOn)
      fail(`${label}.expiresOn precedes acceptedOn`);
    if (
      daysBetween(risk.acceptedOn, risk.expiresOn) >
      policy.maximumAcceptanceDays
    ) {
      fail(
        `${label} exceeds the ${policy.maximumAcceptanceDays}-day acceptance limit`,
      );
    }
    if (today > risk.expiresOn) fail(`${label} expired on ${risk.expiresOn}`);
    if (daysBetween(risk.lastReviewedOn, today) > policy.maximumReviewAgeDays) {
      fail(
        `${label} has not been reviewed in ${policy.maximumReviewAgeDays} days`,
      );
    }

    if (
      !Array.isArray(risk.compensatingControls) ||
      risk.compensatingControls.length === 0
    ) {
      fail(`${label}.compensatingControls must contain at least one control`);
    }
    const controlIds = new Set();
    for (const [
      controlIndex,
      controlValue,
    ] of risk.compensatingControls.entries()) {
      const controlLabel = `${label}.compensatingControls[${controlIndex}]`;
      const control = requireRecord(controlValue, controlLabel);
      requireOnlyKeys(control, CONTROL_FIELDS, controlLabel);
      requireString(control.id, `${controlLabel}.id`);
      requireString(control.description, `${controlLabel}.description`, 20);
      requireUniqueStrings(
        control.evidenceFiles,
        `${controlLabel}.evidenceFiles`,
      );
      requireUniqueStrings(
        control.verificationCommands,
        `${controlLabel}.verificationCommands`,
      );
      if (controlIds.has(control.id))
        fail(`${label} has duplicate control id ${control.id}`);
      controlIds.add(control.id);
    }

    const key = `${risk.registryAuditId}\u0000${risk.module}`;
    if (seenRisks.has(key))
      fail(
        `${label} duplicates registry advisory/module ${risk.registryAuditId}/${risk.module}`,
      );
    seenRisks.add(key);
  }

  return register;
}

export function validateRiskEvidence(
  register,
  root = ROOT,
  manifest = parseJsonDocument(
    readFileSync(PACKAGE_PATH, "utf8"),
    "package.json",
  ),
) {
  const scripts = requireRecord(manifest.scripts, "package.json scripts");
  for (const risk of register.acceptedRisks) {
    for (const control of risk.compensatingControls) {
      for (const evidenceFile of control.evidenceFiles) {
        if (isAbsolute(evidenceFile))
          fail(
            `risk evidence path must be repository-relative: ${evidenceFile}`,
          );
        const target = resolve(root, evidenceFile);
        const rel = relative(root, target);
        if (rel === ".." || rel.startsWith(`..${sep}`)) {
          fail(`risk evidence path escapes the repository: ${evidenceFile}`);
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          fail(`risk evidence file does not exist: ${evidenceFile}`);
        }
        const realTarget = realpathSync(target);
        const realRoot = realpathSync(root);
        const realRel = relative(realRoot, realTarget);
        if (realRel === ".." || realRel.startsWith(`..${sep}`)) {
          fail(`risk evidence symlink escapes the repository: ${evidenceFile}`);
        }
        if (statSync(realTarget).size === 0) {
          fail(`risk evidence file is empty: ${evidenceFile}`);
        }
      }
      for (const command of control.verificationCommands) {
        const scriptName = verificationScriptName(command);
        if (!scriptName) {
          fail(
            `risk verification command must be one exact pnpm package script: ${command}`,
          );
        }
        if (!Object.hasOwn(scripts, scriptName)) {
          fail(`risk verification script does not exist: ${scriptName}`);
        }
      }
    }
  }
}

export function runRiskVerificationCommands(
  register,
  manifest,
  spawn = spawnSync,
) {
  const scripts = requireRecord(manifest.scripts, "package.json scripts");
  const scriptNames = new Set(
    register.acceptedRisks.flatMap((risk) =>
      risk.compensatingControls.flatMap((control) =>
        control.verificationCommands.map((command) => {
          const scriptName = verificationScriptName(command);
          if (!scriptName || !Object.hasOwn(scripts, scriptName)) {
            fail(`invalid risk verification command: ${command}`);
          }
          return scriptName;
        }),
      ),
    ),
  );
  for (const scriptName of scriptNames) {
    const result = spawn("pnpm", ["run", scriptName], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "inherit",
      shell: false,
    });
    if (result.error) {
      const detail =
        result.error instanceof Error
          ? result.error.message
          : String(result.error);
      fail(`could not execute risk verification ${scriptName}: ${detail}`);
    }
    if (result.signal) {
      fail(
        `risk verification ${scriptName} was terminated by signal ${result.signal}`,
      );
    }
    if (result.status !== 0) {
      fail(
        `risk verification ${scriptName} failed with exit code ${String(result.status)}`,
      );
    }
  }
}

export function validateLatestStableVersions(register, latestVersions) {
  for (const risk of register.acceptedRisks) {
    const latest = latestVersions.get(risk.module);
    if (!latest)
      fail(`latest stable registry version is missing for ${risk.module}`);
    requireStableSemver(latest, `latest stable ${risk.module} version`);
    if (latest !== risk.expectedLatestStableVersion) {
      fail(
        `${risk.module} latest stable version changed from ${risk.expectedLatestStableVersion} to ${latest}; fix availability must be re-triaged`,
      );
    }
  }
}

export function validateNoStablePatchedVersions(register, versionsByModule) {
  for (const risk of register.acceptedRisks) {
    const versions = versionsByModule.get(risk.module);
    if (!Array.isArray(versions) || versions.length === 0) {
      fail(`registry version history is missing for ${risk.module}`);
    }
    const seen = new Set();
    for (const [index, version] of versions.entries()) {
      requireSemver(version, `${risk.module} registry versions[${index}]`);
      if (seen.has(version)) {
        fail(
          `${risk.module} registry version history contains ${version} twice`,
        );
      }
      seen.add(version);
    }
    if (!seen.has(risk.expectedLatestStableVersion)) {
      fail(
        `${risk.module} registry version history omits expected latest ${risk.expectedLatestStableVersion}`,
      );
    }
    const stableFixes = versions.filter(
      (version) =>
        semver.prerelease(version) === null &&
        semver.satisfies(version, risk.expectedPatchedVersions),
    );
    if (stableFixes.length > 0) {
      fail(
        `${risk.module} has stable version(s) matching the patched range ${risk.expectedPatchedVersions}: ${stableFixes.join(", ")}; the exception is invalid`,
      );
    }
  }
}

export function validateLegacyPnpm9AuditReport(report) {
  requireRecord(report, "pnpm audit report");
  requireOnlyKeys(
    report,
    ["actions", "advisories", "muted", "metadata"],
    "pnpm audit report",
  );
  if (!Array.isArray(report.actions))
    fail("pnpm audit report.actions must be an array");
  const advisoriesRecord = requireRecord(
    report.advisories,
    "pnpm audit report.advisories",
  );
  if (!Array.isArray(report.muted))
    fail("pnpm audit report.muted must be an array");
  if (report.muted.length > 0)
    fail(
      "pnpm audit returned muted findings; scanner-level suppression is forbidden",
    );

  const metadata = requireRecord(report.metadata, "pnpm audit report.metadata");
  requireOnlyKeys(
    metadata,
    [
      "vulnerabilities",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "totalDependencies",
    ],
    "pnpm audit report.metadata",
  );
  const vulnerabilities = requireRecord(
    metadata.vulnerabilities,
    "metadata.vulnerabilities",
  );
  requireOnlyKeys(vulnerabilities, SEVERITIES, "metadata.vulnerabilities");
  for (const severity of SEVERITIES) {
    requireBoundedInteger(
      vulnerabilities[severity],
      0,
      Number.MAX_SAFE_INTEGER,
      `metadata.vulnerabilities.${severity}`,
    );
  }
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "totalDependencies",
  ]) {
    requireBoundedInteger(
      metadata[key],
      0,
      Number.MAX_SAFE_INTEGER,
      `metadata.${key}`,
    );
  }
  if (
    metadata.totalDependencies !==
    metadata.dependencies +
      metadata.devDependencies +
      metadata.optionalDependencies
  ) {
    fail("pnpm audit dependency totals are internally inconsistent");
  }

  const advisories = new Map();
  const countedBySeverity = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  );
  for (const [key, advisoryValue] of Object.entries(advisoriesRecord)) {
    const label = `pnpm audit advisory ${key}`;
    const advisory = requireRecord(advisoryValue, label);
    requireOnlyKeys(advisory, LEGACY_ADVISORY_FIELDS, label);
    requireBoundedInteger(
      advisory.id,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.id`,
    );
    if (String(advisory.id) !== key) fail(`${label} key does not match its id`);
    requireString(advisory.module_name, `${label}.module_name`);
    if (!SEVERITY_RANK.has(advisory.severity))
      fail(`${label}.severity is invalid`);
    requirePattern(
      advisory.github_advisory_id,
      /^GHSA-[a-z0-9-]+$/u,
      `${label}.github_advisory_id`,
    );
    requireUniqueStrings(advisory.cves, `${label}.cves`, { allowEmpty: true });
    for (const [cveIndex, cve] of advisory.cves.entries()) {
      requirePattern(cve, /^CVE-\d{4}-\d{4,}$/u, `${label}.cves[${cveIndex}]`);
    }
    requireString(advisory.vulnerable_versions, `${label}.vulnerable_versions`);
    requireString(advisory.patched_versions, `${label}.patched_versions`);
    requireSemverRange(
      advisory.vulnerable_versions,
      `${label}.vulnerable_versions`,
    );
    requireSemverRange(advisory.patched_versions, `${label}.patched_versions`);
    requireString(advisory.title, `${label}.title`);
    requireString(advisory.url, `${label}.url`);
    for (const optionalString of [
      "access",
      "recommendation",
      "overview",
      "updated",
      "references",
      "created",
    ]) {
      if (Object.hasOwn(advisory, optionalString)) {
        requireString(advisory[optionalString], `${label}.${optionalString}`);
      }
    }
    if (
      Object.hasOwn(advisory, "metadata") &&
      advisory.metadata !== null &&
      !isRecord(advisory.metadata)
    ) {
      fail(`${label}.metadata must be null or an object`);
    }
    for (const nullableRegistryField of [
      "found_by",
      "deleted",
      "npm_advisory_id",
      "reported_by",
    ]) {
      if (
        Object.hasOwn(advisory, nullableRegistryField) &&
        advisory[nullableRegistryField] !== null
      ) {
        fail(`${label}.${nullableRegistryField} must be null in pnpm 9 output`);
      }
    }
    if (Object.hasOwn(advisory, "cwe")) {
      requireUniqueStrings(advisory.cwe, `${label}.cwe`, { allowEmpty: true });
    }
    if (Object.hasOwn(advisory, "cvss")) {
      const cvss = requireRecord(advisory.cvss, `${label}.cvss`);
      requireOnlyKeys(cvss, ["score", "vectorString"], `${label}.cvss`);
      if (
        typeof cvss.score !== "number" ||
        !Number.isFinite(cvss.score) ||
        cvss.score < 0 ||
        cvss.score > 10
      ) {
        fail(`${label}.cvss.score must be a number between 0 and 10`);
      }
      requireString(cvss.vectorString, `${label}.cvss.vectorString`);
    }
    if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
      fail(`${label}.findings must be a non-empty array`);
    }
    for (const [findingIndex, findingValue] of advisory.findings.entries()) {
      const findingLabel = `${label}.findings[${findingIndex}]`;
      const finding = requireRecord(findingValue, findingLabel);
      requireOnlyKeys(finding, ["version", "paths"], findingLabel);
      requireString(finding.version, `${findingLabel}.version`);
      requireSemver(finding.version, `${findingLabel}.version`);
      requireUniqueStrings(finding.paths, `${findingLabel}.paths`);
    }
    advisories.set(advisory.id, advisory);
    countedBySeverity[advisory.severity] += 1;
  }

  for (const severity of SEVERITIES) {
    if (countedBySeverity[severity] !== vulnerabilities[severity]) {
      fail(
        `pnpm audit ${severity} count mismatch: metadata=${vulnerabilities[severity]}, advisories=${countedBySeverity[severity]}`,
      );
    }
  }

  const resolutionsByAdvisory = new Map();
  const seenResolutions = new Set();
  for (const [actionIndex, actionValue] of report.actions.entries()) {
    const label = `pnpm audit report.actions[${actionIndex}]`;
    const action = requireRecord(actionValue, label);
    requireOnlyKeys(
      action,
      ["action", "module", "target", "depth", "resolves"],
      label,
    );
    requireString(action.action, `${label}.action`);
    if (!new Set(["install", "update", "review"]).has(action.action)) {
      fail(`${label}.action is not a supported pnpm 9 remediation action`);
    }
    requireString(action.module, `${label}.module`);
    if (Object.hasOwn(action, "target")) {
      requireString(action.target, `${label}.target`);
    }
    if (Object.hasOwn(action, "depth")) {
      requireBoundedInteger(
        action.depth,
        0,
        Number.MAX_SAFE_INTEGER,
        `${label}.depth`,
      );
    }
    if (!Array.isArray(action.resolves) || action.resolves.length === 0) {
      fail(`${label}.resolves must be a non-empty array`);
    }
    for (const [
      resolutionIndex,
      resolutionValue,
    ] of action.resolves.entries()) {
      const resolutionLabel = `${label}.resolves[${resolutionIndex}]`;
      const resolution = requireRecord(resolutionValue, resolutionLabel);
      requireOnlyKeys(
        resolution,
        ["id", "path", "dev", "optional", "bundled"],
        resolutionLabel,
      );
      requireBoundedInteger(
        resolution.id,
        1,
        Number.MAX_SAFE_INTEGER,
        `${resolutionLabel}.id`,
      );
      requireString(resolution.path, `${resolutionLabel}.path`);
      for (const booleanKey of ["dev", "optional", "bundled"]) {
        if (typeof resolution[booleanKey] !== "boolean") {
          fail(`${resolutionLabel}.${booleanKey} must be boolean`);
        }
      }
      const advisory = advisories.get(resolution.id);
      if (!advisory) {
        fail(`${resolutionLabel} references missing advisory ${resolution.id}`);
      }
      if (advisory.module_name !== action.module) {
        fail(
          `${resolutionLabel} module ${action.module} does not match advisory ${advisory.module_name}`,
        );
      }
      const resolutionKey = `${resolution.id}\u0000${action.module}\u0000${resolution.path}`;
      if (seenResolutions.has(resolutionKey))
        fail(`${resolutionLabel} duplicates ${resolution.path}`);
      seenResolutions.add(resolutionKey);
      const entries = resolutionsByAdvisory.get(resolution.id) ?? [];
      entries.push({ action, resolution });
      resolutionsByAdvisory.set(resolution.id, entries);
    }
  }

  for (const advisoryId of advisories.keys()) {
    if (!resolutionsByAdvisory.has(advisoryId)) {
      fail(
        `pnpm audit advisory ${advisoryId} has no remediation action/resolution`,
      );
    }
  }

  return { advisories, resolutionsByAdvisory, metadata, vulnerabilities };
}

export function validateAuditReport(report) {
  requireRecord(report, "pnpm 11 bulk audit report");
  requireOnlyKeys(
    report,
    ["advisories", "metadata"],
    "pnpm 11 bulk audit report",
  );
  const advisoriesRecord = requireRecord(
    report.advisories,
    "pnpm 11 bulk audit report.advisories",
  );
  const metadata = requireRecord(
    report.metadata,
    "pnpm 11 bulk audit report.metadata",
  );
  requireOnlyKeys(
    metadata,
    [
      "vulnerabilities",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "totalDependencies",
    ],
    "pnpm 11 bulk audit report.metadata",
  );
  const vulnerabilities = requireRecord(
    metadata.vulnerabilities,
    "pnpm 11 bulk audit metadata.vulnerabilities",
  );
  requireOnlyKeys(
    vulnerabilities,
    SEVERITIES,
    "pnpm 11 bulk audit metadata.vulnerabilities",
  );
  for (const severity of SEVERITIES) {
    requireBoundedInteger(
      vulnerabilities[severity],
      0,
      Number.MAX_SAFE_INTEGER,
      `pnpm 11 bulk audit metadata.vulnerabilities.${severity}`,
    );
  }
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "totalDependencies",
  ]) {
    requireBoundedInteger(
      metadata[key],
      0,
      Number.MAX_SAFE_INTEGER,
      `pnpm 11 bulk audit metadata.${key}`,
    );
  }
  if (
    metadata.totalDependencies !==
    metadata.dependencies +
      metadata.devDependencies +
      metadata.optionalDependencies
  ) {
    fail("pnpm 11 bulk audit dependency totals are internally inconsistent");
  }
  if (metadata.totalDependencies === 0) {
    fail("pnpm 11 bulk audit reported an empty dependency graph");
  }
  if (metadata.devDependencies !== 0) {
    fail("pnpm 11 bulk audit unexpectedly included development dependencies");
  }

  const advisories = new Map();
  const countedBySeverity = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  );
  for (const [key, advisoryValue] of Object.entries(advisoriesRecord)) {
    const label = `pnpm 11 bulk audit advisory ${key}`;
    const advisory = requireRecord(advisoryValue, label);
    requireOnlyKeys(advisory, BULK_ADVISORY_FIELDS, label);
    requireBoundedInteger(
      advisory.id,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.id`,
    );
    if (String(advisory.id) !== key) fail(`${label} key does not match its id`);
    requireString(advisory.title, `${label}.title`);
    requireString(advisory.module_name, `${label}.module_name`);
    requireString(advisory.vulnerable_versions, `${label}.vulnerable_versions`);
    requireString(advisory.patched_versions, `${label}.patched_versions`);
    requireSemverRange(
      advisory.vulnerable_versions,
      `${label}.vulnerable_versions`,
    );
    requireSemverRange(advisory.patched_versions, `${label}.patched_versions`);
    if (!SEVERITY_RANK.has(advisory.severity)) {
      fail(`${label}.severity is invalid`);
    }
    requireString(advisory.cwe, `${label}.cwe`);
    requirePattern(
      advisory.github_advisory_id,
      /^GHSA-[a-z0-9-]+$/u,
      `${label}.github_advisory_id`,
    );
    requireString(advisory.url, `${label}.url`);
    if (
      advisory.url !==
      `https://github.com/advisories/${advisory.github_advisory_id}`
    ) {
      fail(`${label}.url does not match its GitHub advisory id`);
    }
    if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
      fail(`${label}.findings must be a non-empty array`);
    }
    const findingKeys = new Set();
    for (const [findingIndex, findingValue] of advisory.findings.entries()) {
      const findingLabel = `${label}.findings[${findingIndex}]`;
      const finding = requireRecord(findingValue, findingLabel);
      requireOnlyKeys(finding, BULK_FINDING_FIELDS, findingLabel);
      requireSemver(finding.version, `${findingLabel}.version`);
      if (!semver.satisfies(finding.version, advisory.vulnerable_versions)) {
        fail(
          `${findingLabel}.version is outside the advisory vulnerable range`,
        );
      }
      requireUniqueStrings(finding.paths, `${findingLabel}.paths`);
      for (const booleanKey of ["dev", "optional", "bundled"]) {
        if (typeof finding[booleanKey] !== "boolean") {
          fail(`${findingLabel}.${booleanKey} must be boolean`);
        }
      }
      if (finding.dev) {
        fail(`${findingLabel} is a development finding in a production audit`);
      }
      for (const path of finding.paths) {
        validateBulkFindingPath(path, advisory.module_name, findingLabel);
        const findingKey = `${finding.version}\u0000${path}`;
        if (findingKeys.has(findingKey)) {
          fail(`${findingLabel} duplicates finding path ${path}`);
        }
        findingKeys.add(findingKey);
      }
    }
    advisories.set(advisory.id, advisory);
    countedBySeverity[advisory.severity] += 1;
  }

  for (const severity of SEVERITIES) {
    const counted = countedBySeverity[severity];
    const total = vulnerabilities[severity];
    if (
      severityRank(severity) >= severityRank(BULK_AUDIT_REPORTING_FLOOR)
        ? counted !== total
        : counted > total
    ) {
      fail(
        `pnpm 11 bulk audit ${severity} count mismatch: metadata=${total}, advisories=${counted}`,
      );
    }
  }

  return { advisories, metadata, vulnerabilities };
}

export function evaluateAuditReport(report, register, options = {}) {
  validateRiskRegister(register, options);
  const normalized = validateAuditReport(report);
  const threshold = severityRank(register.policy.minimumSeverity);
  const riskByKey = new Map(
    register.acceptedRisks.map((risk) => [
      `${risk.registryAuditId}\u0000${risk.module}`,
      risk,
    ]),
  );
  const matchedRisks = new Set();
  const accepted = [];
  const belowThreshold = [];

  for (const advisory of normalized.advisories.values()) {
    if (severityRank(advisory.severity) < threshold) {
      belowThreshold.push(advisory);
      continue;
    }

    const riskKey = `${advisory.id}\u0000${advisory.module_name}`;
    const risk = riskByKey.get(riskKey);
    if (!risk) {
      fail(
        `unexpected ${advisory.severity} advisory ${advisory.github_advisory_id} (${advisory.id}) for ${advisory.module_name}`,
      );
    }
    matchedRisks.add(riskKey);

    if (advisory.github_advisory_id !== risk.advisory) {
      fail(
        `advisory ${advisory.id} identity changed from ${risk.advisory} to ${advisory.github_advisory_id}`,
      );
    }
    if (advisory.severity !== risk.severity) {
      fail(
        `advisory ${advisory.id} severity changed from ${risk.severity} to ${advisory.severity}`,
      );
    }
    if (advisory.vulnerable_versions !== risk.expectedVulnerableVersions) {
      fail(
        `advisory ${advisory.id} vulnerable range changed; re-triage is required`,
      );
    }
    if (advisory.patched_versions !== risk.expectedPatchedVersions) {
      fail(
        `advisory ${advisory.id} patched range changed; a fix may now be available`,
      );
    }
    if (advisory.url !== risk.upstreamUrl) {
      fail(
        `advisory ${advisory.id} upstream URL changed; re-triage is required`,
      );
    }

    assertExactSet(
      advisory.findings.map((finding) => finding.version),
      risk.expectedFindingVersions,
      `advisory ${advisory.id} finding versions`,
    );
    const findings = advisory.findings.flatMap((finding) => finding.paths);
    assertExactSet(
      findings,
      risk.findingPaths,
      `advisory ${advisory.id} finding paths`,
    );
    assertExactSet(
      [
        ...new Set(
          findings.map((path) => decodeBulkPathSegment(path.split(">", 1)[0])),
        ),
      ],
      risk.affectedImporters,
      `advisory ${advisory.id} affected importers`,
    );

    accepted.push({ advisory, risk });
  }

  for (const riskKey of riskByKey.keys()) {
    if (!matchedRisks.has(riskKey)) {
      const risk = riskByKey.get(riskKey);
      fail(
        `risk register entry ${risk.advisory} (${risk.registryAuditId}) no longer matches the raw audit; remove or re-triage it`,
      );
    }
  }

  return { accepted, belowThreshold, ...normalized };
}

export function validateAuditExitCode(
  exitCode,
  vulnerabilities,
  minimumSeverity,
) {
  if (exitCode !== 0 && exitCode !== 1) {
    fail(`pnpm audit returned unsupported exit code ${String(exitCode)}`);
  }
  const threshold = severityRank(minimumSeverity);
  const blockingTotal = SEVERITIES.reduce(
    (sum, severity) =>
      severityRank(severity) >= threshold
        ? sum + vulnerabilities[severity]
        : sum,
    0,
  );
  const expectedExitCode = blockingTotal > 0 ? 1 : 0;
  if (exitCode !== expectedExitCode) {
    fail(
      `pnpm audit exit code ${exitCode} disagrees with its ${minimumSeverity}+ vulnerability total ${blockingTotal}`,
    );
  }
}

export function parseAuditCommandResult(result) {
  if (result.error) {
    const detail =
      result.error instanceof Error
        ? result.error.message
        : String(result.error);
    fail(`could not execute pnpm audit: ${detail}`);
  }
  if (result.signal)
    fail(`pnpm audit was terminated by signal ${result.signal}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(
      `pnpm audit failed with infrastructure/registry exit code ${String(result.status)}`,
    );
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr && stderr !== PNPM_11_IGNORED_ROOT_CONFIG_WARNING) {
    fail(`pnpm audit wrote unexpected stderr: ${stderr}`);
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (!stdout.trim()) fail("pnpm audit did not return JSON output");
  return {
    exitCode: result.status,
    report: parseJsonDocument(stdout, "pnpm audit output"),
  };
}

export function runPnpmAudit(spawn = spawnSync) {
  if (
    !PINNED_AUDIT_PNPM_SPEC.startsWith(
      `pnpm@${PINNED_AUDIT_PNPM_VERSION}+sha512.`,
    )
  ) {
    fail("internal audit pnpm version/integrity pin is inconsistent");
  }
  return parseAuditCommandResult(
    spawn(
      "corepack",
      [
        PINNED_AUDIT_PNPM_SPEC,
        "--pm-on-fail=ignore",
        "audit",
        "--prod",
        "--audit-level",
        "moderate",
        `--registry=${PINNED_AUDIT_REGISTRY}`,
        "--json",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // corepack prints "! Corepack is about to download …" to stderr the
        // first time it fetches the pinned pnpm 11; stderr is treated as a
        // failure here, so the notice is disabled for this one invocation.
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      },
    ),
  );
}

export function runPnpmViewReleaseMetadata(moduleName, spawn = spawnSync) {
  requireString(moduleName, "registry module name");
  const result = spawn(
    "pnpm",
    ["view", moduleName, "version", "versions", "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  const stdout = parseSuccessfulCommand(
    result,
    `pnpm view ${moduleName}`,
    "registry",
  );
  const metadata = requireRecord(
    parseJsonDocument(stdout, `pnpm view ${moduleName} output`),
    `pnpm view ${moduleName} output`,
  );
  requireOnlyKeys(
    metadata,
    ["version", "versions"],
    `pnpm view ${moduleName} output`,
  );
  requireStableSemver(metadata.version, `pnpm view ${moduleName} version`);
  if (!Array.isArray(metadata.versions) || metadata.versions.length === 0) {
    fail(`pnpm view ${moduleName} versions must be a non-empty array`);
  }
  for (const [index, version] of metadata.versions.entries()) {
    requireSemver(version, `pnpm view ${moduleName} versions[${index}]`);
  }
  return metadata;
}

function main() {
  if (process.argv.length > 2)
    fail("audit-js.mjs does not accept report overrides or ignore flags");
  const manifest = parseJsonDocument(
    readFileSync(PACKAGE_PATH, "utf8"),
    "package.json",
  );
  const npmrc = existsSync(NPMRC_PATH) ? readFileSync(NPMRC_PATH, "utf8") : "";
  assertNoHiddenAuditConfiguration(manifest, npmrc);
  if (!existsSync(WORKSPACE_PATH)) fail("pnpm-workspace.yaml is missing");
  assertNoHiddenWorkspaceAuditConfiguration(
    parseYamlDocument(
      readFileSync(WORKSPACE_PATH, "utf8"),
      "pnpm-workspace.yaml",
    ),
  );
  assertNoHiddenAuditEnvironment();
  runPnpmVersion();
  runPnpmConfiguration();

  const registerSchema = parseJsonDocument(
    readFileSync(REGISTER_SCHEMA_PATH, "utf8"),
    "dependency risk register schema",
  );
  validateRiskRegisterSchema(registerSchema);

  const register = parseJsonDocument(
    readFileSync(REGISTER_PATH, "utf8"),
    "dependency risk register",
  );
  validateRiskRegister(register);
  validateRiskEvidence(register, ROOT, manifest);
  const releaseMetadata = new Map(
    register.acceptedRisks.map((risk) => [
      risk.module,
      runPnpmViewReleaseMetadata(risk.module),
    ]),
  );
  const latestVersions = new Map(
    register.acceptedRisks.map((risk) => [
      risk.module,
      releaseMetadata.get(risk.module).version,
    ]),
  );
  validateLatestStableVersions(register, latestVersions);
  validateNoStablePatchedVersions(
    register,
    new Map(
      register.acceptedRisks.map((risk) => [
        risk.module,
        releaseMetadata.get(risk.module).versions,
      ]),
    ),
  );

  const { exitCode, report } = runPnpmAudit();
  const result = evaluateAuditReport(report, register);
  validateAuditExitCode(
    exitCode,
    result.vulnerabilities,
    register.policy.minimumSeverity,
  );
  runRiskVerificationCommands(register, manifest);

  if (result.accepted.length === 0) {
    console.log(
      "dependency audit OK: no production advisories at or above moderate",
    );
    return;
  }

  console.log(
    "Temporarily accepted production dependency risks (raw pnpm audit remains non-zero):",
  );
  for (const { advisory, risk } of result.accepted) {
    console.log(
      `- ${advisory.github_advisory_id} ${advisory.module_name} (${advisory.severity}); owner=${risk.ownerRole}; expires=${risk.expiresOn}`,
    );
  }
  console.log(
    `dependency audit OK under the expiring risk policy: ${result.accepted.length} exact accepted finding(s), 0 unexpected moderate+ findings`,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireOnlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0)
    fail(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

function validateBulkFindingPath(path, moduleName, label) {
  requireString(path, `${label}.path`);
  if (/\s/u.test(path)) {
    fail(`${label}.path must use pnpm 11 bulk path encoding without spaces`);
  }
  const segments = path.split(">");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    fail(`${label}.path is not a valid pnpm 11 bulk dependency path`);
  }
  const importer = decodeBulkPathSegment(segments[0]);
  if (
    importer !== "." &&
    (isAbsolute(importer) ||
      importer === ".." ||
      importer.startsWith("../") ||
      importer.includes("/../"))
  ) {
    fail(`${label}.path importer escapes the workspace`);
  }
  if (decodeBulkPathSegment(segments.at(-1)) !== moduleName) {
    fail(`${label}.path does not terminate at ${moduleName}`);
  }
  return importer;
}

function decodeBulkPathSegment(segment) {
  return segment.replaceAll("__", "/");
}

function assertClosedSchemaFields(schema, fields, label) {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    fail(`${label} must describe a closed object`);
  }
  requireUniqueStrings(schema.required, `${label}.required`);
  assertExactSet(schema.required, fields, `${label}.required`);
  const properties = requireRecord(schema.properties, `${label}.properties`);
  assertExactSet(Object.keys(properties), fields, `${label}.properties`);
}

function normalizeConfigKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function isForbiddenConfigAssignment(line) {
  const equals = line.indexOf("=");
  if (equals < 1) return false;
  return isForbiddenConfigValue(
    normalizeConfigKey(line.slice(0, equals)),
    line.slice(equals + 1),
  );
}

function isForbiddenConfigValue(normalizedKey, rawValue) {
  const value = rawValue
    .trim()
    .replace(/^["']|["']$/gu, "")
    .toLowerCase();
  if (
    normalizedKey.includes("ignorecve") ||
    normalizedKey.includes("ignoreghsa") ||
    normalizedKey.includes("ignoreunfixable") ||
    normalizedKey.includes("auditconfig")
  ) {
    return true;
  }
  if (normalizedKey === "audit" && ["false", "0", "no"].includes(value)) {
    return true;
  }
  return (
    normalizedKey === "ignoreregistryerrors" &&
    ["true", "1", "yes"].includes(value)
  );
}

function findForbiddenConfigurationKeys(value, path) {
  const forbidden = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      forbidden.push(
        ...findForbiddenConfigurationKeys(entry, `${path}[${index}]`),
      );
    }
    return forbidden;
  }
  if (!isRecord(value)) return forbidden;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenConfigValue(normalizeConfigKey(key), String(child ?? ""))) {
      forbidden.push(childPath);
    }
    forbidden.push(...findForbiddenConfigurationKeys(child, childPath));
  }
  return forbidden;
}

function verificationScriptName(command) {
  const match = /^pnpm (?:run )?([a-z0-9][a-z0-9:._-]*)$/u.exec(command);
  return match?.[1] ?? null;
}

function parseSuccessfulCommand(result, label, failureClass) {
  if (result.error) {
    const detail =
      result.error instanceof Error
        ? result.error.message
        : String(result.error);
    fail(`could not execute ${label}: ${detail}`);
  }
  if (result.signal) fail(`${label} was terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    fail(
      `${label} failed with ${failureClass} exit code ${String(result.status)}`,
    );
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr) fail(`${label} wrote to stderr: ${stderr}`);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (!stdout.trim()) fail(`${label} returned empty output`);
  return stdout;
}

function parseSuccessfulTextCommand(result, label, failureClass) {
  return parseSuccessfulCommand(result, label, failureClass).trim();
}

function requireString(value, label, minimumLength = 1) {
  if (typeof value !== "string" || value.trim().length < minimumLength) {
    fail(
      `${label} must be a non-empty string of at least ${minimumLength} characters`,
    );
  }
}

function requirePattern(value, pattern, label) {
  requireString(value, label);
  if (!pattern.test(value)) fail(`${label} has an invalid format`);
}

function requireSemver(value, label) {
  requireString(value, label);
  if (semver.valid(value) !== value) fail(`${label} must be a valid semver`);
}

function requireStableSemver(value, label) {
  requireSemver(value, label);
  if (semver.prerelease(value) !== null) {
    fail(`${label} must be a stable semver release`);
  }
}

function requireSemverRange(value, label) {
  requireString(value, label);
  if (semver.validRange(value) === null) {
    fail(`${label} must be a valid semver range`);
  }
}

function requireUniqueStrings(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    fail(`${label} must be ${options.allowEmpty ? "an" : "a non-empty"} array`);
  }
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    requireString(entry, `${label}[${index}]`);
    if (seen.has(entry)) fail(`${label} contains duplicate value ${entry}`);
    seen.add(entry);
  }
}

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function requireDate(value, label) {
  requirePattern(value, /^\d{4}-\d{2}-\d{2}$/u, label);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    fail(`${label} is not a real calendar date`);
  }
}

function daysBetween(from, to) {
  return Math.floor(
    (new Date(`${to}T00:00:00.000Z`).getTime() -
      new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

function severityRank(severity) {
  const rank = SEVERITY_RANK.get(severity);
  if (rank === undefined) fail(`unknown severity ${String(severity)}`);
  return rank;
}

function assertExactSet(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    fail(`${label} must compare two arrays`);
  }
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  if (
    actual.length !== actualSet.size ||
    missing.length > 0 ||
    extra.length > 0
  ) {
    fail(
      `${label} mismatch${missing.length ? `; missing: ${missing.join(" | ")}` : ""}${extra.length ? `; unexpected: ${extra.join(" | ")}` : ""}`,
    );
  }
}

function fail(message) {
  throw new DependencyAuditPolicyError(message);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`dependency audit failed: ${detail}`);
    process.exitCode = 1;
  }
}
