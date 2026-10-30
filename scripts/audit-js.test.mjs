import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  assertNoHiddenAuditConfiguration,
  assertNoHiddenAuditEnvironment,
  assertNoHiddenWorkspaceAuditConfiguration,
  evaluateAuditReport,
  parseAuditCommandResult,
  parseJsonDocument,
  parseYamlDocument,
  runPnpmAudit,
  runPnpmConfiguration,
  runPnpmVersion,
  runPnpmViewReleaseMetadata,
  runRiskVerificationCommands,
  validateAuditExitCode,
  validateAuditReport,
  validateEffectivePnpmConfiguration,
  validateLegacyPnpm9AuditReport,
  validateLatestStableVersions,
  validateNoStablePatchedVersions,
  validateRiskEvidence,
  validateRiskRegister,
  validateRiskRegisterSchema,
} from "./audit-js.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURES = resolve(SCRIPT_DIR, "__fixtures__/audit-js");

function fixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));
}

function register() {
  return fixture("accepted-risk-register.json");
}

function manifest(pnpm = {}) {
  return { packageManager: "pnpm@9.12.0", pnpm };
}

function successfulCommand(stdout) {
  return { status: 0, signal: null, stdout, stderr: "" };
}

test("accepts an exact bulk-endpoint MJML fixture before its expiry", () => {
  const result = evaluateAuditReport(
    fixture("accepted-mjml-bulk.json"),
    register(),
    {
      today: "2026-07-14",
    },
  );
  assert.equal(result.accepted.length, 1);
  assert.equal(
    result.accepted[0].advisory.github_advisory_id,
    "GHSA-45h5-66jx-r2wf",
  );
});

test("accepts a clean report when the risk register is empty", () => {
  const policy = register();
  policy.acceptedRisks = [];
  const result = evaluateAuditReport(fixture("clean.json"), policy, {
    today: "2026-07-14",
  });
  assert.equal(result.accepted.length, 0);
});

test("accepts pnpm 11 metadata totals for findings below the moderate reporting floor", () => {
  const report = fixture("clean.json");
  report.metadata.vulnerabilities.low = 2;
  assert.doesNotThrow(() => validateAuditReport(report));

  report.metadata.vulnerabilities.moderate = 1;
  assert.throws(
    () => validateAuditReport(report),
    /moderate count mismatch/u,
  );
});

test("rejects the former actions-only false green", () => {
  assert.throws(
    () =>
      validateLegacyPnpm9AuditReport(fixture("false-green-actions-only.json")),
    /moderate count mismatch/u,
  );
});

test("retains the legacy pnpm 9 parser only as an offline regression check", () => {
  const parsed = validateLegacyPnpm9AuditReport(fixture("accepted-mjml.json"));
  assert.equal(parsed.advisories.size, 1);
  assert.throws(
    () => validateAuditReport(fixture("accepted-mjml.json")),
    /unsupported field/u,
  );
});

test("rejects an unexpected moderate advisory", () => {
  const policy = register();
  policy.acceptedRisks = [];
  assert.throws(
    () =>
      evaluateAuditReport(fixture("accepted-mjml-bulk.json"), policy, {
        today: "2026-07-14",
      }),
    /unexpected moderate advisory/u,
  );
});

test("rejects an expired accepted risk", () => {
  assert.throws(
    () =>
      evaluateAuditReport(fixture("accepted-mjml-bulk.json"), register(), {
        today: "2026-08-14",
      }),
    /expired on 2026-08-13/u,
  );
});

test("rejects a new stable release even if the bulk advisory is unchanged", () => {
  assert.throws(
    () =>
      validateLatestStableVersions(register(), new Map([["mjml", "5.4.0"]])),
    /latest stable version changed from 4\.18\.0 to 5\.4\.0/u,
  );
});

test("fails closed when the release-metadata registry query fails", () => {
  assert.throws(
    () =>
      runPnpmViewReleaseMetadata("mjml", () => ({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "registry unavailable",
      })),
    /failed with registry exit code 1/u,
  );
});

test("rejects a prerelease latest tag in release metadata", () => {
  assert.throws(
    () =>
      runPnpmViewReleaseMetadata("mjml", () =>
        successfulCommand(
          JSON.stringify({
            version: "5.0.0-beta.1",
            versions: ["4.18.0", "5.0.0-beta.1"],
          }),
        ),
      ),
    /must be a stable semver release/u,
  );
});

test("rejects changed patched-version metadata", () => {
  const report = fixture("accepted-mjml-bulk.json");
  report.advisories["1121799"].patched_versions = ">=5.0.0";
  assert.throws(
    () => evaluateAuditReport(report, register(), { today: "2026-07-14" }),
    /patched range changed/u,
  );
});

test("rejects a dependency-path mismatch", () => {
  const policy = register();
  policy.acceptedRisks[0].findingPaths.pop();
  assert.throws(
    () =>
      evaluateAuditReport(fixture("accepted-mjml-bulk.json"), policy, {
        today: "2026-07-14",
      }),
    /finding paths mismatch/u,
  );
});

test("requires an owner, rationale, expiry, and compensating control", () => {
  const policy = register();
  delete policy.acceptedRisks[0].ownerRole;
  assert.throws(
    () => validateRiskRegister(policy, { today: "2026-07-14" }),
    /ownerRole/u,
  );

  const wrongOwner = register();
  wrongOwner.acceptedRisks[0].ownerRole = "Product Engineering";
  assert.throws(
    () => validateRiskRegister(wrongOwner, { today: "2026-07-14" }),
    /ownerRole must be Security Engineering/u,
  );
});

test("forbids pnpm auditConfig ignores", () => {
  assert.throws(
    () => assertNoHiddenAuditConfiguration(manifest({ auditConfig: {} })),
    /auditConfig is forbidden/u,
  );
});

test("parses the workspace manifest and forbids pnpm 11 GHSA suppressions", () => {
  const workspace = parseYamlDocument(
    'packages:\n  - "apps/*"\n',
    "fixture workspace",
  );
  assert.doesNotThrow(() =>
    assertNoHiddenWorkspaceAuditConfiguration(workspace),
  );
  assert.throws(
    () =>
      assertNoHiddenWorkspaceAuditConfiguration({
        packages: ["apps/*"],
        auditConfig: { ignoreGhsas: ["GHSA-aaaa-bbbb-cccc"] },
      }),
    /pnpm-workspace\.yaml contains forbidden audit suppression/u,
  );
  assert.throws(
    () => parseYamlDocument("packages: []\npackages: []\n", "workspace"),
    /is not valid YAML/u,
  );
});

test("fails closed on invalid audit JSON", () => {
  const invalid = readFileSync(resolve(FIXTURES, "invalid-json.txt"), "utf8");
  assert.throws(
    () => parseJsonDocument(invalid, "fixture"),
    /is not valid JSON/u,
  );
});

test("fails closed on registry or infrastructure stderr", () => {
  assert.throws(
    () =>
      parseAuditCommandResult({
        status: 1,
        signal: null,
        stdout: JSON.stringify(fixture("clean.json")),
        stderr: "ERR_PNPM_AUDIT_BAD_RESPONSE registry unavailable",
      }),
    /wrote unexpected stderr/u,
  );
});

test("uses an integrity-pinned pnpm 11.4 bulk audit without a shell", () => {
  const calls = [];
  const warning =
    '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides", "pnpm.patchedDependencies". See https://pnpm.io/settings for the new home of each setting.\n';
  const result = runPnpmAudit((command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(fixture("clean.json")),
      stderr: warning,
    };
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "corepack");
  assert.deepEqual(calls[0].args, [
    "pnpm@11.4.0+sha512.f0febc7e37552ab485494a914241b338e0b3580b93d54ce31f00933015880863129038a1b4ae4e414a0ee63ac35bf21197e990172c4a68256450b5636310968f",
    "--pm-on-fail=ignore",
    "audit",
    "--prod",
    "--audit-level",
    "moderate",
    "--registry=https://registry.npmjs.org/",
    "--json",
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("fails closed on report schema drift", () => {
  const report = fixture("clean.json");
  report.vulnerabilities = {};
  assert.throws(() => validateAuditReport(report), /unsupported field/u);
});

test("keeps the checked-in JSON schema aligned with the runtime contract", () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(ROOT, "config/schemas/dependency-risk-register.schema.json"),
      "utf8",
    ),
  );
  assert.equal(validateRiskRegisterSchema(schema), schema);

  const drifted = structuredClone(schema);
  drifted.$defs.risk.required.pop();
  assert.throws(
    () => validateRiskRegisterSchema(drifted),
    /risk schema\.required mismatch/u,
  );
});

test("requires the canonical risk-register schema reference", () => {
  const policy = register();
  policy.$schema = "./wrong-schema.json";
  assert.throws(
    () => validateRiskRegister(policy, { today: "2026-07-14" }),
    /register\.\$schema/u,
  );
});

test("forbids weakening the production threshold above moderate", () => {
  const policy = register();
  policy.policy.minimumSeverity = "high";
  assert.throws(
    () => validateRiskRegister(policy, { today: "2026-07-14" }),
    /minimumSeverity must be moderate/u,
  );
});

test("forbids weakening the 45-day acceptance and 30-day review limits", () => {
  const acceptance = register();
  acceptance.policy.maximumAcceptanceDays = 46;
  assert.throws(
    () => validateRiskRegister(acceptance, { today: "2026-07-14" }),
    /maximumAcceptanceDays must be 45/u,
  );

  const review = register();
  review.policy.maximumReviewAgeDays = 31;
  assert.throws(
    () => validateRiskRegister(review, { today: "2026-07-14" }),
    /maximumReviewAgeDays must be 30/u,
  );
});

test("rejects a stale accepted-risk review before expiry", () => {
  const policy = register();
  const risk = policy.acceptedRisks[0];
  risk.acceptedOn = "2026-06-30";
  risk.lastReviewedOn = "2026-06-30";
  risk.expiresOn = "2026-08-14";
  assert.throws(
    () => validateRiskRegister(policy, { today: "2026-08-01" }),
    /has not been reviewed in 30 days/u,
  );
});

test("rejects future reviews and overlong acceptance windows", () => {
  const future = register();
  future.acceptedRisks[0].lastReviewedOn = "2026-07-15";
  assert.throws(
    () => validateRiskRegister(future, { today: "2026-07-14" }),
    /lastReviewedOn is in the future/u,
  );

  const overlong = register();
  overlong.acceptedRisks[0].expiresOn = "2026-08-29";
  assert.throws(
    () => validateRiskRegister(overlong, { today: "2026-07-14" }),
    /45-day acceptance limit/u,
  );
});

test("rejects changed advisory identity and malformed documentary aliases", () => {
  const changedIdentity = fixture("accepted-mjml-bulk.json");
  changedIdentity.advisories["1121799"].github_advisory_id =
    "GHSA-aaaa-bbbb-cccc";
  changedIdentity.advisories["1121799"].url =
    "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";
  assert.throws(
    () =>
      evaluateAuditReport(changedIdentity, register(), {
        today: "2026-07-14",
      }),
    /identity changed/u,
  );

  const changedAliases = register();
  changedAliases.acceptedRisks[0].aliases = ["GHSA-aaaa-bbbb-cccc"];
  assert.throws(
    () => validateRiskRegister(changedAliases, { today: "2026-07-14" }),
    /aliases\[0\] has an invalid format/u,
  );
});

test("rejects finding-version, dependency-path, and importer drift", () => {
  const changedVersion = fixture("accepted-mjml-bulk.json");
  changedVersion.advisories["1121799"].findings[0].version = "4.17.0";
  assert.throws(
    () =>
      evaluateAuditReport(changedVersion, register(), {
        today: "2026-07-14",
      }),
    /finding versions mismatch/u,
  );

  const changedPath = fixture("accepted-mjml-bulk.json");
  changedPath.advisories["1121799"].findings[0].paths[0] = "apps__other>mjml";
  assert.throws(
    () =>
      evaluateAuditReport(changedPath, register(), {
        today: "2026-07-14",
      }),
    /finding paths mismatch/u,
  );

  const changedImporterPolicy = register();
  changedImporterPolicy.acceptedRisks[0].affectedImporters.pop();
  assert.throws(
    () =>
      evaluateAuditReport(
        fixture("accepted-mjml-bulk.json"),
        changedImporterPolicy,
        { today: "2026-07-14" },
      ),
    /affected importers mismatch/u,
  );
});

test("rejects a stale exception after its advisory disappears", () => {
  assert.throws(
    () =>
      evaluateAuditReport(fixture("clean.json"), register(), {
        today: "2026-07-14",
      }),
    /no longer matches the raw audit/u,
  );
});

test("proves compensating-control evidence is repository-bound and pinned", () => {
  assert.doesNotThrow(() => validateRiskEvidence(register(), ROOT));

  const escaping = register();
  escaping.acceptedRisks[0].compensatingControls[0].evidenceFiles = [
    "../outside.txt",
  ];
  assert.throws(
    () => validateRiskEvidence(escaping, ROOT),
    /escapes the repository/u,
  );

  const unpinned = register();
  unpinned.acceptedRisks[0].compensatingControls[0].verificationCommands = [
    "npm test",
  ];
  assert.throws(
    () => validateRiskEvidence(unpinned, ROOT),
    /must be one exact pnpm package script/u,
  );
});

test("executes every accepted-risk compensating script without a shell", () => {
  const calls = [];
  const rootManifest = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf8"),
  );
  runRiskVerificationCommands(
    register(),
    rootManifest,
    (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, signal: null };
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, ["run", "test:audit-js"]);
  assert.equal(calls[0].options.shell, false);

  assert.throws(
    () =>
      runRiskVerificationCommands(register(), rootManifest, () => ({
        status: 1,
        signal: null,
      })),
    /risk verification test:audit-js failed with exit code 1/u,
  );
});

test("rejects empty rationale and compensating controls", () => {
  const shortRationale = register();
  shortRationale.acceptedRisks[0].rationale = "too short";
  assert.throws(
    () => validateRiskRegister(shortRationale, { today: "2026-07-14" }),
    /rationale/u,
  );

  const noControls = register();
  noControls.acceptedRisks[0].compensatingControls = [];
  assert.throws(
    () => validateRiskRegister(noControls, { today: "2026-07-14" }),
    /at least one control/u,
  );
});

test("detects a stable release inside an accepted advisory's patched range", () => {
  const noStableFix = new Map([
    ["mjml", ["4.18.0", "5.0.0-alpha.9", "5.0.0-beta.1"]],
  ]);
  assert.doesNotThrow(() =>
    validateNoStablePatchedVersions(register(), noStableFix),
  );

  noStableFix.get("mjml").push("5.0.0");
  assert.throws(
    () => validateNoStablePatchedVersions(register(), noStableFix),
    /has stable version\(s\) matching the patched range/u,
  );
});

test("parses exact registry release metadata without network access", () => {
  const metadata = runPnpmViewReleaseMetadata("mjml", () =>
    successfulCommand(
      JSON.stringify({
        version: "4.18.0",
        versions: ["4.18.0", "5.0.0-alpha.9"],
      }),
    ),
  );
  assert.deepEqual(metadata, {
    version: "4.18.0",
    versions: ["4.18.0", "5.0.0-alpha.9"],
  });
});

test("fails closed on empty or drifted registry release metadata", () => {
  assert.throws(
    () => runPnpmViewReleaseMetadata("mjml", () => successfulCommand("")),
    /returned empty output/u,
  );
  assert.throws(
    () =>
      runPnpmViewReleaseMetadata("mjml", () =>
        successfulCommand(
          JSON.stringify({ version: "4.18.0", versions: [], distTags: {} }),
        ),
      ),
    /unsupported field/u,
  );
});

test("pins the pnpm parser contract to 9.12.0", () => {
  assert.equal(
    runPnpmVersion(() => successfulCommand("9.12.0\n")),
    "9.12.0",
  );
  assert.throws(
    () => runPnpmVersion(() => successfulCommand("10.0.0\n")),
    /pnpm 9\.12\.0 is required/u,
  );
  assert.throws(
    () => assertNoHiddenAuditConfiguration({ packageManager: "pnpm@9" }),
    /must pin pnpm@9\.12\.0/u,
  );
});

test("pins the advisory source to the canonical npm registry", () => {
  assert.throws(
    () =>
      validateEffectivePnpmConfiguration({
        registry: "https://registry.example.invalid/",
      }),
    /pnpm audit registry must be https:\/\/registry\.npmjs\.org\//u,
  );
});

test("rejects hidden effective config and scoped registry overrides", () => {
  assert.deepEqual(
    runPnpmConfiguration(() =>
      successfulCommand(
        JSON.stringify({ registry: "https://registry.npmjs.org/" }),
      ),
    ),
    { registry: "https://registry.npmjs.org/" },
  );
  assert.throws(
    () =>
      validateEffectivePnpmConfiguration({
        registry: "https://registry.npmjs.org/",
        "ignore-ghsas": ["GHSA-aaaa-bbbb-cccc"],
      }),
    /forbidden audit suppression/u,
  );
  assert.throws(
    () =>
      validateEffectivePnpmConfiguration({
        registry: "https://registry.npmjs.org/",
        "@postwave:registry": "https://registry.example.invalid/",
      }),
    /alternate registry source/u,
  );
});

test("forbids root, npmrc, and environment CVE suppression", () => {
  assert.throws(
    () =>
      assertNoHiddenAuditConfiguration({
        ...manifest(),
        auditConfig: { ignoreCves: ["CVE-1"] },
      }),
    /auditConfig is forbidden/u,
  );
  assert.throws(
    () =>
      assertNoHiddenAuditConfiguration(
        manifest(),
        "audit-config.ignore-cves[]=CVE-2025-1",
      ),
    /forbidden audit suppression/u,
  );
  assert.throws(
    () => assertNoHiddenAuditConfiguration(manifest(), "audit=false"),
    /forbidden audit suppression/u,
  );
  assert.throws(
    () =>
      assertNoHiddenAuditEnvironment({
        NPM_CONFIG_IGNORE_CVES: "CVE-2025-1",
      }),
    /forbidden audit suppression variable/u,
  );
  assert.throws(
    () =>
      assertNoHiddenAuditEnvironment({
        PNPM_CONFIG_IGNORE_GHSAS: "GHSA-aaaa-bbbb-cccc",
      }),
    /forbidden audit suppression variable/u,
  );
  assert.throws(
    () =>
      assertNoHiddenAuditEnvironment({
        PNPM_CONFIG_IGNORE_REGISTRY_ERRORS: "true",
      }),
    /forbidden audit suppression variable/u,
  );
});

test("honors the moderate threshold when only low findings exist", () => {
  const report = fixture("accepted-mjml-bulk.json");
  report.advisories["1121799"].severity = "low";
  report.metadata.vulnerabilities.low = 1;
  report.metadata.vulnerabilities.moderate = 0;
  const policy = register();
  policy.acceptedRisks = [];
  const result = evaluateAuditReport(report, policy, {
    today: "2026-07-14",
  });
  assert.equal(result.belowThreshold.length, 1);
  assert.doesNotThrow(() =>
    validateAuditExitCode(0, result.vulnerabilities, "moderate"),
  );
});

test("rejects audit exit codes that disagree with threshold counts", () => {
  const clean = fixture("clean.json").metadata.vulnerabilities;
  assert.throws(
    () => validateAuditExitCode(1, clean, "moderate"),
    /disagrees with its moderate\+ vulnerability total 0/u,
  );
  const vulnerable = { ...clean, moderate: 1 };
  assert.throws(
    () => validateAuditExitCode(0, vulnerable, "moderate"),
    /disagrees with its moderate\+ vulnerability total 1/u,
  );
});

test("fails closed on empty output, invalid command status, spawn error, or signal", () => {
  assert.throws(
    () =>
      parseAuditCommandResult({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
      }),
    /did not return JSON output/u,
  );
  assert.throws(
    () =>
      parseAuditCommandResult({
        status: 2,
        signal: null,
        stdout: "{}",
        stderr: "",
      }),
    /infrastructure\/registry exit code 2/u,
  );
  assert.throws(
    () =>
      parseAuditCommandResult({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: new Error("ENOENT"),
      }),
    /could not execute pnpm audit/u,
  );
  assert.throws(
    () =>
      parseAuditCommandResult({
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      }),
    /terminated by signal SIGTERM/u,
  );
});

test("fails closed on nested bulk schema drift, legacy fields, and bad totals", () => {
  const advisoryDrift = fixture("accepted-mjml-bulk.json");
  advisoryDrift.advisories["1121799"].new_registry_field = true;
  assert.throws(() => validateAuditReport(advisoryDrift), /unsupported field/u);

  const findingDrift = fixture("accepted-mjml-bulk.json");
  findingDrift.advisories["1121799"].findings[0].extra = true;
  assert.throws(() => validateAuditReport(findingDrift), /unsupported field/u);

  const muted = fixture("clean.json");
  muted.muted = [{ id: 1121799 }];
  assert.throws(() => validateAuditReport(muted), /unsupported field/u);

  const badTotal = fixture("clean.json");
  badTotal.metadata.totalDependencies += 1;
  assert.throws(
    () => validateAuditReport(badTotal),
    /dependency totals are internally inconsistent/u,
  );
});

test("fails closed on empty graphs and malformed production findings", () => {
  const emptyGraph = fixture("clean.json");
  emptyGraph.metadata.dependencies = 0;
  emptyGraph.metadata.totalDependencies = 0;
  assert.throws(
    () => validateAuditReport(emptyGraph),
    /reported an empty dependency graph/u,
  );

  const devFinding = fixture("accepted-mjml-bulk.json");
  devFinding.advisories["1121799"].findings[0].dev = true;
  assert.throws(
    () => validateAuditReport(devFinding),
    /development finding in a production audit/u,
  );

  const badPath = fixture("accepted-mjml-bulk.json");
  badPath.advisories["1121799"].findings[0].paths[0] = "../outside>mjml";
  assert.throws(
    () => validateAuditReport(badPath),
    /importer escapes the workspace/u,
  );

  const changedCweShape = fixture("accepted-mjml-bulk.json");
  changedCweShape.advisories["1121799"].cwe = ["CWE-22"];
  assert.throws(
    () => validateAuditReport(changedCweShape),
    /\.cwe must be a non-empty string/u,
  );
});
