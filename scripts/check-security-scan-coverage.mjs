#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".claude",
  ".git",
  ".next",
  ".serena",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function discoverGoModules(repositoryRoot = root) {
  const modules = [];

  function walk(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(absolute);
        continue;
      }
      if (entry.isFile() && entry.name === "go.mod") {
        const relative = toPosix(path.relative(repositoryRoot, directory));
        modules.push(relative || ".");
      }
    }
  }

  walk(repositoryRoot);
  return modules.sort();
}

export function discoverDeployableGoServices(
  repositoryRoot = root,
  modules = discoverGoModules(repositoryRoot),
) {
  const containsMainPackage = (moduleDirectory) => {
    const pending = [path.join(repositoryRoot, moduleDirectory)];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) pending.push(absolute);
          continue;
        }
        if (
          entry.isFile() &&
          entry.name.endsWith(".go") &&
          !entry.name.endsWith("_test.go") &&
          /^package\s+main\s*$/mu.test(fs.readFileSync(absolute, "utf8"))
        ) {
          return true;
        }
      }
    }
    return false;
  };

  return modules
    .filter((moduleDirectory) => {
      if (!/^(apps|services)\/[^/]+$/.test(moduleDirectory)) return false;
      return containsMainPackage(moduleDirectory);
    })
    .map((moduleDirectory) => ({
      name: path.posix.basename(moduleDirectory),
      moduleDirectory,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// Images that Trivy scans but docker-push deliberately does not publish. Both
// are shipped app images with their own runtime and dependency tree; neither
// has an ECR repository or an ecr-bridge entry, so requiring a publish entry
// for them would be a lie. Everything else scanned must still be published.
const SCAN_ONLY_IMAGES = new Set(["audit-portal", "ops"]);

/**
 * Every `apps/<name>/Dockerfile` in the tree. discoverDeployableGoServices only
 * ever finds Go modules, so an app image built from a Node/nginx runtime — the
 * ops console, the audit portal — could sit outside the Trivy matrix without
 * any check noticing. This is the discovery that closes that hole.
 */
export function discoverAppImages(repositoryRoot = root) {
  const appsDirectory = path.join(repositoryRoot, "apps");
  if (!fs.existsSync(appsDirectory)) return [];
  return fs
    .readdirSync(appsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name),
    )
    .map((entry) => ({
      name: entry.name,
      directory: `apps/${entry.name}`,
      dockerfile: `apps/${entry.name}/Dockerfile`,
    }))
    .filter((image) =>
      fs.existsSync(path.join(repositoryRoot, image.dockerfile)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseDependabotGoDirectories(source) {
  const directories = [];
  let update = null;

  const finish = () => {
    if (update?.ecosystem === "gomod" && update.directory) {
      const normalized = update.directory.replace(/^\/+|\/+$/g, "");
      directories.push(normalized || ".");
    }
    update = null;
  };

  for (const line of source.split(/\r?\n/u)) {
    const ecosystem = line.match(
      /^  - package-ecosystem:\s*(["']?[^\s"']+["']?)\s*(?:#.*)?$/u,
    );
    if (ecosystem) {
      finish();
      update = { ecosystem: unquote(ecosystem[1]), directory: null };
      continue;
    }
    if (!update) continue;
    const directory = line.match(
      /^    directory:\s*(["']?[^\s"']+["']?)\s*(?:#.*)?$/u,
    );
    if (directory) update.directory = unquote(directory[1]);
  }
  finish();
  return directories.sort();
}

function extractStrategyMatrix(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s{6}matrix:\s*$/u.test(line));
  if (start < 0) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^\s{4}steps:\s*$/u.test(line),
  );
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

export function parseImageMatrix(source, identityKey) {
  const entries = [];
  const lines = extractStrategyMatrix(source);
  let current = null;

  const finish = () => {
    if (current) entries.push(current);
    current = null;
  };

  const identityPattern = new RegExp(
    `^\\s+- ${identityKey}:\\s*([^\\s#]+)\\s*(?:#.*)?$`,
    "u",
  );
  for (const line of lines) {
    const identity = line.match(identityPattern);
    if (identity) {
      finish();
      current = {
        name: unquote(identity[1]),
        dockerfile: null,
        servicePath: null,
      };
      continue;
    }
    if (!current) continue;
    const dockerfile = line.match(/^\s+dockerfile:\s*([^\s#]+).*$/u);
    if (dockerfile) current.dockerfile = unquote(dockerfile[1]);
    const servicePath = line.match(/^\s+service_path:\s*([^\s#]+).*$/u);
    if (servicePath) current.servicePath = unquote(servicePath[1]);
    const buildArgPath = line.match(/^\s+SERVICE_PATH=([^\s#]+).*$/u);
    if (buildArgPath) current.servicePath = unquote(buildArgPath[1]);
  }
  finish();

  return entries.map((entry) => ({
    ...entry,
    servicePath: entry.servicePath?.replace(/^\.\//u, "") ?? null,
  }));
}

export function parseCodeQLPaths(source) {
  const paths = [];
  let inPaths = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^paths:\s*$/u.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z][A-Za-z-]*:\s*$/u.test(line)) break;
    const entry = line.match(/^  -\s+(.+?)\s*$/u);
    if (entry) paths.push(unquote(entry[1]));
  }
  return paths;
}

export function parsePullRequestPaths(source) {
  const paths = [];
  let inPullRequest = false;
  let inPaths = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^  pull_request:\s*$/u.test(line)) {
      inPullRequest = true;
      continue;
    }
    if (!inPullRequest) continue;
    if (/^  [A-Za-z][A-Za-z_-]*:/u.test(line)) break;
    if (/^    paths:\s*$/u.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^    [A-Za-z][A-Za-z_-]*:/u.test(line)) break;
    const entry = line.match(/^      -\s+(.+?)\s*$/u);
    if (entry) paths.push(unquote(entry[1]));
  }
  return paths;
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function duplicates(values) {
  const seen = new Set();
  const duplicateSet = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicateSet.add(value);
    seen.add(value);
  }
  return [...duplicateSet].sort();
}

function isCoveredByCodeQL(moduleDirectory, configuredPaths) {
  return configuredPaths.some(
    (configuredPath) =>
      moduleDirectory === configuredPath ||
      moduleDirectory.startsWith(`${configuredPath}/`),
  );
}

function isCoveredByTriggerPath(moduleDirectory, triggerPaths) {
  const [topLevel] = moduleDirectory.split("/");
  return triggerPaths.some(
    (triggerPath) =>
      triggerPath === "**" ||
      triggerPath === `${topLevel}/**` ||
      triggerPath === `${moduleDirectory}/**`,
  );
}

export function collectSecurityScanCoverageIssues({
  modules,
  deployableServices,
  appImages,
  dependabot,
  codeqlWorkflow,
  codeqlConfig,
  trivyWorkflow,
  dockerPushWorkflow,
}) {
  const issues = [];
  const add = (id, message) => issues.push({ id, message });

  const dependabotDirectories = parseDependabotGoDirectories(dependabot);
  const missingDependabot = setDifference(modules, dependabotDirectories);
  const staleDependabot = setDifference(dependabotDirectories, modules);
  const duplicateDependabot = duplicates(dependabotDirectories);
  if (missingDependabot.length) {
    add(
      "SEC-GOMOD-DEPENDABOT-MISSING",
      `Dependabot does not cover Go module(s): ${missingDependabot.join(", ")}`,
    );
  }
  if (staleDependabot.length) {
    add(
      "SEC-GOMOD-DEPENDABOT-STALE",
      `Dependabot has stale Go module directorie(s): ${staleDependabot.join(", ")}`,
    );
  }
  if (duplicateDependabot.length) {
    add(
      "SEC-GOMOD-DEPENDABOT-DUPLICATE",
      `Dependabot repeats Go module directorie(s): ${duplicateDependabot.join(", ")}`,
    );
  }

  if (!/- language:\s*go\s*\n\s+build-mode:\s*manual\b/u.test(codeqlWorkflow)) {
    add(
      "SEC-CODEQL-BUILD-MODE",
      "CodeQL Go analysis must use manual mode so every module build is traced",
    );
  }
  if (
    !codeqlWorkflow.includes(
      "node scripts/check-security-scan-coverage.mjs --build-go-modules",
    )
  ) {
    add(
      "SEC-CODEQL-DYNAMIC-BUILD",
      "CodeQL must invoke the dynamic all-module Go build",
    );
  }
  const configuredCodeQLPaths = parseCodeQLPaths(codeqlConfig);
  const uncoveredCodeQLModules = modules.filter(
    (moduleDirectory) =>
      !isCoveredByCodeQL(moduleDirectory, configuredCodeQLPaths),
  );
  if (uncoveredCodeQLModules.length) {
    add(
      "SEC-CODEQL-PATHS",
      `CodeQL paths do not cover Go module(s): ${uncoveredCodeQLModules.join(", ")}`,
    );
  }

  const publishedImages = parseImageMatrix(dockerPushWorkflow, "service");
  const scannedImages = parseImageMatrix(trivyWorkflow, "name");
  const publishedNames = publishedImages.map((image) => image.name);
  const scannedNames = scannedImages.map((image) => image.name);
  const missingPublishedScans = setDifference(publishedNames, scannedNames);
  const staleScans = setDifference(scannedNames, publishedNames).filter(
    (name) => !SCAN_ONLY_IMAGES.has(name),
  );
  if (missingPublishedScans.length) {
    add(
      "SEC-TRIVY-PUBLISHED-MISSING",
      `Trivy does not scan published image(s): ${missingPublishedScans.join(", ")}`,
    );
  }
  if (staleScans.length) {
    add(
      "SEC-TRIVY-STALE",
      `Trivy scans image name(s) absent from the publish matrix: ${staleScans.join(", ")}`,
    );
  }
  for (const duplicate of duplicates(scannedNames)) {
    add("SEC-TRIVY-DUPLICATE", `Trivy repeats image: ${duplicate}`);
  }

  const publishedForServicePath = (servicePath) =>
    publishedImages.filter(
      (image) =>
        image.dockerfile === "Dockerfile.go" &&
        image.servicePath === servicePath,
    );
  const scannedForServicePath = (servicePath) =>
    scannedImages.filter(
      (image) =>
        image.dockerfile === "Dockerfile.go" &&
        image.servicePath === servicePath,
    );
  const trivyTriggerPaths = parsePullRequestPaths(trivyWorkflow);
  const uncoveredTrivyTriggers = [];
  for (const service of deployableServices) {
    const published = publishedForServicePath(service.moduleDirectory).find(
      (image) => image.name === service.name,
    );
    if (!published) {
      add(
        "SEC-DEPLOYABLE-PUBLISH-MISSING",
        `${service.moduleDirectory} is a deployable Go service but lacks the expected ${service.name} publish entry`,
      );
    }
    const scanned = scannedForServicePath(service.moduleDirectory).find(
      (image) => image.name === service.name,
    );
    if (!scanned) {
      add(
        "SEC-DEPLOYABLE-TRIVY-MISSING",
        `${service.moduleDirectory} is a deployable Go service but lacks the expected ${service.name} Trivy entry`,
      );
    }
    if (!isCoveredByTriggerPath(service.moduleDirectory, trivyTriggerPaths)) {
      uncoveredTrivyTriggers.push(service.moduleDirectory);
    }
  }

  if (uncoveredTrivyTriggers.length) {
    add(
      "SEC-TRIVY-TRIGGER",
      `Trivy pull-request paths do not cover deployable service source: ${uncoveredTrivyTriggers.join(", ")}`,
    );
  }

  // The checks above reach an image only through a Go module or the publish
  // matrix, so a non-Go app image absent from BOTH matrices is self-consistent
  // and invisible. Anchor on the Dockerfile that exists on disk instead.
  const scannedDockerfiles = new Set(
    scannedImages.map((image) => image.dockerfile).filter(Boolean),
  );
  const unscannedAppImages = appImages
    .filter((image) => !scannedDockerfiles.has(image.dockerfile))
    .map((image) => image.dockerfile);
  if (unscannedAppImages.length) {
    add(
      "SEC-TRIVY-APP-IMAGE-MISSING",
      `Trivy does not scan app image(s): ${unscannedAppImages.join(", ")}`,
    );
  }
  const uncoveredAppTriggers = appImages
    .filter(
      (image) => !isCoveredByTriggerPath(image.directory, trivyTriggerPaths),
    )
    .map((image) => image.directory);
  if (uncoveredAppTriggers.length) {
    add(
      "SEC-TRIVY-APP-TRIGGER",
      `Trivy pull-request paths do not cover app image source: ${uncoveredAppTriggers.join(", ")}`,
    );
  }
  if (
    !trivyWorkflow.includes("node scripts/check-security-scan-coverage.mjs")
  ) {
    add(
      "SEC-TRIVY-CONTRACT",
      "Trivy must validate scan coverage before building its image matrix",
    );
  }

  return issues;
}

function loadInputs(repositoryRoot = root) {
  const read = (relativePath) =>
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  const modules = discoverGoModules(repositoryRoot);
  return {
    modules,
    deployableServices: discoverDeployableGoServices(repositoryRoot, modules),
    appImages: discoverAppImages(repositoryRoot),
    dependabot: read(".github/dependabot.yml"),
    codeqlWorkflow: read(".github/workflows/codeql.yml"),
    codeqlConfig: read(".github/codeql/codeql-config.yml"),
    trivyWorkflow: read(".github/workflows/trivy.yml"),
    dockerPushWorkflow: read(".github/workflows/docker-push.yml"),
  };
}

function assertClean(inputs) {
  const issues = collectSecurityScanCoverageIssues(inputs);
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.id}: ${issue.message}`);
    throw new Error(
      `${issues.length} security scan coverage contract(s) failed`,
    );
  }
}

function assertMutationFails(base, name, expectedID, mutate) {
  const mutated = {
    ...base,
    modules: [...base.modules],
    deployableServices: base.deployableServices.map((entry) => ({ ...entry })),
    appImages: base.appImages.map((entry) => ({ ...entry })),
  };
  mutate(mutated);
  const ids = new Set(
    collectSecurityScanCoverageIssues(mutated).map((issue) => issue.id),
  );
  if (!ids.has(expectedID)) {
    throw new Error(`${name}: mutation did not trigger ${expectedID}`);
  }
}

function runSelfTests(base) {
  const firstModule = base.modules[0];
  assertMutationFails(
    base,
    "new Go module without dependency updates",
    "SEC-GOMOD-DEPENDABOT-MISSING",
    (value) => value.modules.push("future/uncovered-module"),
  );
  assertMutationFails(
    base,
    "removed Dependabot module",
    "SEC-GOMOD-DEPENDABOT-MISSING",
    (value) => {
      value.dependabot = value.dependabot.replace(
        new RegExp(
          `  - package-ecosystem: ["']gomod["'][\\s\\S]*?    directory: ["']/${firstModule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][\\s\\S]*?(?=\\n  - package-ecosystem:|$)`,
          "u",
        ),
        "",
      );
    },
  );
  assertMutationFails(
    base,
    "CodeQL autobuild regression",
    "SEC-CODEQL-BUILD-MODE",
    (value) => {
      value.codeqlWorkflow = value.codeqlWorkflow.replace(
        "build-mode: manual",
        "build-mode: autobuild",
      );
    },
  );
  assertMutationFails(
    base,
    "CodeQL path omission",
    "SEC-CODEQL-PATHS",
    (value) => {
      value.codeqlConfig = value.codeqlConfig.replace("  - tests/e2e\n", "");
    },
  );
  assertMutationFails(
    base,
    "unscanned published image",
    "SEC-TRIVY-PUBLISHED-MISSING",
    (value) => {
      value.trivyWorkflow = value.trivyWorkflow.replace(
        /          - name: automation[\s\S]*?(?=          - name:)/u,
        "",
      );
    },
  );
  assertMutationFails(
    base,
    "new deployable service without image automation",
    "SEC-DEPLOYABLE-PUBLISH-MISSING",
    (value) => {
      value.deployableServices.push({
        name: "future-service",
        moduleDirectory: "services/future-service",
      });
    },
  );
  assertMutationFails(
    base,
    "deployable service omitted from Trivy triggers",
    "SEC-TRIVY-TRIGGER",
    (value) => {
      value.trivyWorkflow = value.trivyWorkflow.replace(
        '      - "services/**"\n',
        "",
      );
    },
  );
  assertMutationFails(
    base,
    "new app image outside the Trivy matrix",
    "SEC-TRIVY-APP-IMAGE-MISSING",
    (value) => {
      value.appImages.push({
        name: "future-app",
        directory: "apps/future-app",
        dockerfile: "apps/future-app/Dockerfile",
      });
    },
  );
  assertMutationFails(
    base,
    "app image omitted from Trivy triggers",
    "SEC-TRIVY-APP-TRIGGER",
    (value) => {
      value.trivyWorkflow = value.trivyWorkflow.replace(
        '      - "apps/ops/**"\n',
        "",
      );
    },
  );
  assertMutationFails(
    base,
    "scanned image that is neither published nor declared scan-only",
    "SEC-TRIVY-STALE",
    (value) => {
      value.trivyWorkflow = value.trivyWorkflow.replace(
        "          - name: ops\n",
        "          - name: ops-console\n",
      );
    },
  );
  console.log(
    "Security scan coverage self-tests passed (10 fail-closed mutations).",
  );
}

function buildAllGoModules(inputs) {
  assertClean(inputs);
  for (const moduleDirectory of inputs.modules) {
    const cwd = path.join(root, moduleDirectory);
    console.log(`::group::Build and extract Go module ${moduleDirectory}`);
    for (const args of [
      ["build", "./..."],
      ["test", "-run", "^$", "./..."],
    ]) {
      const result = spawnSync("go", args, {
        cwd,
        env: { ...process.env, GOWORK: "off" },
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          `go ${args.join(" ")} failed in ${moduleDirectory} with exit code ${result.status}`,
        );
      }
    }
    console.log("::endgroup::");
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const inputs = loadInputs();
    if (process.argv.includes("--build-go-modules")) {
      buildAllGoModules(inputs);
    } else {
      assertClean(inputs);
      console.log(
        `Security scan coverage passed (${inputs.modules.length} Go modules, ${inputs.deployableServices.length} deployable Go services).`,
      );
      if (process.argv.includes("--self-test")) runSelfTests(inputs);
    }
  } catch (error) {
    console.error(`Security scan coverage failed: ${error.message}`);
    process.exitCode = 1;
  }
}
