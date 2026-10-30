#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".env",
  ".example",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const skippedSourceDirectories = new Set([
  ".expo",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

async function activeSourceFiles(relativeDirectory) {
  const files = [];
  async function walk(relativePath) {
    const entries = await readdir(path.join(root, relativePath), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        // Audits and E2E runs use custom Next output directories such as
        // `.next-audit-final`; they are generated artifacts just like `.next`.
        const generatedNextDirectory = entry.name.startsWith(".next-");
        if (
          !skippedSourceDirectories.has(entry.name) &&
          !generatedNextDirectory
        ) {
          await walk(child);
        }
      } else if (
        entry.isFile() &&
        (sourceExtensions.has(path.extname(entry.name)) ||
          entry.name === "Dockerfile")
      ) {
        files.push(child);
      }
    }
  }
  await walk(relativeDirectory);
  return files;
}

const contract = JSON.parse(await read("config/production-platform.json"));
const expected = {
  cloud: "aws",
  region: "us-west-2",
  domain: "moosewave.com",
  infrastructureAsCode: "cloudformation",
  deploymentState: "not-certified",
};
for (const [field, value] of Object.entries(expected)) {
  if (contract[field] !== value) failures.push(`${field} must be ${value}`);
}

const expectedHosts = [
  "moosewave.com",
  "app.moosewave.com",
  "api.moosewave.com",
  "docs.moosewave.com",
  "status.moosewave.com",
  "forms.moosewave.com",
];
if (
  JSON.stringify(Object.values(contract.publicHosts)) !==
  JSON.stringify(expectedHosts)
) {
  failures.push(
    "public host matrix does not match the reviewed production domain contract",
  );
}

if (
  contract.canonicalTemplates.length !== 8 ||
  new Set(contract.canonicalTemplates).size !== 8
) {
  failures.push(
    "canonical template inventory must contain eight unique templates",
  );
}
for (const template of contract.canonicalTemplates) {
  const source = await read(template);
  if (!source.includes("AWSTemplateFormatVersion")) {
    failures.push(`${template} is not a CloudFormation template`);
  }
}

const canonicalDocs = [
  "README.md",
  "infra/RUNBOOK_STATUS.md",
  "infra/aws/README.md",
  "infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md",
  "infra/aws/WEB_DEPLOY_RUNBOOK.md",
  "infra/aws/OBSERVABILITY_RUNBOOK.md",
  "infra/cloudflare/PRODUCTION_DEPLOY_RUNBOOK.md",
];
const retiredMvpDomain = ["smeltsec", "com"].join(".");
const retiredAwsAccount = ["7008", "4511", "8150"].join("");
const retiredAwsAccessKey = ["AKIA2GLM", "72LDL62J", "LSSH"].join("");
const forbiddenProductionIdentifiers = [
  retiredMvpDomain,
  "eu-west-1",
  retiredAwsAccount,
  retiredAwsAccessKey,
];
for (const document of canonicalDocs) {
  const source = await read(document);
  for (const identifier of forbiddenProductionIdentifiers) {
    if (source.includes(identifier)) {
      failures.push(
        `${document} contains retired production identifier ${identifier}`,
      );
    }
  }
}

// DNS and native application identifiers look deceptively similar. Native
// IDs such as com.moosewave.app, group.com.moosewave.app, and
// TEAMID.com.moosewave.app are permanent store identities and must remain.
// Every active DNS reference, however, must use the reviewed moosewave.com
// production suffix. Keeping this as a source-wide gate prevents SDK/client
// defaults and universal-link hosts from silently drifting back to a retired
// domain while preserving the native IDs byte-for-byte.
const retiredDNSDomains = [
  ["postwave", "app"].join("."),
  ["postwave", "email"].join("."),
];
const nativeIdentifierPattern =
  /\b(?:group\.|[A-Z0-9]{5,}\.)?com\.postwave\.app\b/gu;
// A signed macOS application bundle is conventionally named `Moosewave.app`.
// Its case-sensitive filesystem suffix is not a DNS reference and must remain
// valid in packaging docs, scripts, tests and release workflows.
const macOSBundleArtifactPattern = /\bPostwave\.app\b/gu;
// The VS Code command identifier is a public extension API, not a network
// destination. Changing it would break existing keybindings and extensions.
const vscodeCommandIdentifierPattern = /\bpostwave\.email\.sendTest\b/gu;
const activeRoots = [
  "apps",
  "packages",
  "services",
  "docs-site",
  "infra",
  "scripts",
  ".github",
];
const activeFiles = (
  await Promise.all(
    activeRoots.map((directory) => activeSourceFiles(directory)),
  )
).flat();
for (const relativePath of activeFiles) {
  const source = await read(relativePath);
  const withoutNativeIdentifiers = source
    .replace(nativeIdentifierPattern, "")
    .replace(macOSBundleArtifactPattern, "")
    .replace(vscodeCommandIdentifierPattern, "");
  for (const retiredDNSDomain of retiredDNSDomains) {
    const retiredDNSPattern = new RegExp(
      `\\b(?:[a-z0-9-]+\\.)*${retiredDNSDomain.replaceAll(".", "\\.")}\\b`,
      "giu",
    );
    if (retiredDNSPattern.test(withoutNativeIdentifiers)) {
      failures.push(
        `${relativePath} contains retired DNS domain ${retiredDNSDomain} (native application and stable extension identifiers are the only exceptions)`,
      );
    }
  }
}

const rootReadme = await read("README.md");
const normalizedRootReadme = rootReadme.replace(/\s+/gu, " ");
if (
  !rootReadme.includes("infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md") ||
  !rootReadme.includes("AWS ECS Fargate") ||
  !normalizedRootReadme.includes(
    "not evidence that a live production environment exists",
  )
) {
  failures.push(
    "README.md must identify the canonical AWS runbook without claiming deployment",
  );
}

for (const legacyPath of contract.nonProductionDeploymentPaths.slice(0, 2)) {
  const source = await read(legacyPath);
  if (!source.slice(0, 600).includes("NON-PRODUCTION")) {
    failures.push(`${legacyPath} must be visibly classified NON-PRODUCTION`);
  }
}
const compose = await read("infra/docker-compose.full.yml");
if (!compose.slice(0, 800).includes("NON-PRODUCTION")) {
  failures.push(
    "infra/docker-compose.full.yml must be visibly classified NON-PRODUCTION",
  );
}

const awsReadme = await read("infra/aws/README.md");
for (const template of contract.canonicalTemplates) {
  const relativeFromAws = path.relative(
    path.join(root, "infra/aws"),
    path.join(root, template),
  );
  const basename = path.basename(relativeFromAws);
  if (!awsReadme.includes(basename)) {
    failures.push(`infra/aws/README.md does not inventory ${template}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Production platform contract failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Production platform contract OK: ${contract.cloud}/${contract.region}, ${contract.domain}, ${contract.canonicalTemplates.length} templates; live certification remains explicit.\n`,
  );
}
