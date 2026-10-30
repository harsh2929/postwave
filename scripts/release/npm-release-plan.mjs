#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const packageRules = new Map([
  // Insertion order is the deterministic publish order. Keep dependencies
  // before their consumers so an initial release never exposes a package
  // whose internal @postwave dependency is not published yet.
  ["design-tokens", "build"],
  ["nav", "build"],
  ["onboarding-schema", "build"],
  ["query-contract", "build"],
  ["route-map", "build"],
  ["telemetry", "build"],
  ["schema", "build"],
  ["ai-disclosure", "build"],
  ["openapi", "openapi-check"],
  ["sdk-ts", "build"],
  ["audit-portal-react", "build"],
  ["email-react", "build"],
  ["track", "build"],
  ["notifications", "build"],
  ["cli", "build"],
]);

const RELEASE_HOLD_CODE = "mcp_distribution_release_held";
const releaseHeldPackages = new Set(["mcp-server", "claude-code-plugin"]);

const nonNpmPackages = new Map([
  ["vscode-extension", "VS Code Marketplace extension, not an npm package"],
]);

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument list near ${key ?? "<end>"}`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const event = args.event;
  const inputPackage = (args.package ?? "").trim();
  const tag = (args.tag ?? "").trim();
  const repository = (args.repository ?? "").trim();

  if (event !== "tag" && event !== "dispatch") {
    throw new Error(
      `--event must be tag or dispatch, got ${event ?? "<empty>"}`,
    );
  }
  if (releaseHeldPackages.has(inputPackage)) {
    throw new Error(
      `${RELEASE_HOLD_CODE}: package ${JSON.stringify(inputPackage)} is private and excluded from every npm release plan`,
    );
  }
  if (inputPackage && !packageRules.has(inputPackage)) {
    throw new Error(
      `package ${JSON.stringify(inputPackage)} is not in the publish allowlist`,
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      `--repository must be the case-sensitive GitHub owner/repository, got ${JSON.stringify(repository)}`,
    );
  }

  // Refuse silent omissions when another public package is added to the
  // workspace. A maintainer must either add an explicit build rule here or
  // document its separate release workflow.
  const packageEntries = await readdir(path.join(process.cwd(), "packages"), {
    withFileTypes: true,
  });
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(
        await readFile(
          path.join(process.cwd(), "packages", entry.name, "package.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (pkg.private === true) continue;
    if (!packageRules.has(entry.name) && !nonNpmPackages.has(entry.name)) {
      throw new Error(
        `${entry.name} is public but has no npm release rule or documented non-npm channel`,
      );
    }
  }

  let tagVersion = "";
  if (event === "tag") {
    const match = /^packages-v(.+)$/.exec(tag);
    if (!match || !semverPattern.test(match[1])) {
      throw new Error(`tag ${JSON.stringify(tag)} must be packages-v<semver>`);
    }
    if (inputPackage) {
      throw new Error("tag releases cannot select only one package");
    }
    tagVersion = match[1];
  }

  const directories = inputPackage ? [inputPackage] : [...packageRules.keys()];
  const include = [];
  const names = new Set();
  for (const directory of directories) {
    const packagePath = path.join(
      process.cwd(),
      "packages",
      directory,
      "package.json",
    );
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    if (pkg.private === true) {
      throw new Error(`${directory} is private and cannot be published`);
    }
    if (typeof pkg.name !== "string" || !pkg.name.startsWith("@postwave/")) {
      throw new Error(`${directory} has an invalid public package name`);
    }
    if (pkg.publishConfig?.access !== "public") {
      throw new Error(`${directory} must set publishConfig.access to public`);
    }
    const expectedRepositoryURL = `git+https://github.com/${repository}.git`;
    const expectedDirectory = `packages/${directory}`;
    if (
      pkg.repository?.url !== expectedRepositoryURL ||
      pkg.repository?.directory !== expectedDirectory
    ) {
      throw new Error(
        `${directory} repository must be ${expectedRepositoryURL} with directory ${expectedDirectory} for npm provenance`,
      );
    }
    if (pkg.bugs?.url !== `https://github.com/${repository}/issues`) {
      throw new Error(
        `${directory} bugs.url must point at the publishing monorepo issue tracker`,
      );
    }
    if (names.has(pkg.name)) {
      throw new Error(`duplicate package name in release plan: ${pkg.name}`);
    }
    names.add(pkg.name);
    if (typeof pkg.version !== "string" || !semverPattern.test(pkg.version)) {
      throw new Error(
        `${directory} has invalid semver ${JSON.stringify(pkg.version)}`,
      );
    }
    if (tagVersion && pkg.version !== tagVersion) {
      throw new Error(
        `${directory} version ${pkg.version} does not match tag version ${tagVersion}`,
      );
    }

    const buildMode = packageRules.get(directory);
    if (buildMode === "build" && typeof pkg.scripts?.build !== "string") {
      throw new Error(`${directory} must define a build script`);
    }
    if (buildMode === "openapi-check") {
      for (const script of ["sync-json:check", "codegen:check"]) {
        if (typeof pkg.scripts?.[script] !== "string") {
          throw new Error(`${directory} must define ${script}`);
        }
      }
    }
    if (
      buildMode === "typecheck" &&
      typeof pkg.scripts?.typecheck !== "string"
    ) {
      throw new Error(`${directory} must define a typecheck script`);
    }

    include.push({
      directory,
      name: pkg.name,
      version: pkg.version,
      build_mode: buildMode,
    });
  }

  process.stdout.write(`${JSON.stringify({ include })}\n`);
}

main().catch((error) => {
  process.stderr.write(`npm release plan: ${error.message}\n`);
  process.exitCode = 1;
});
