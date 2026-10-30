#!/usr/bin/env node

import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) {
      throw new Error("arguments must be --key value pairs");
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function collectEntryTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEntryTargets(item, targets);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectEntryTargets(item, targets);
  }
  return targets;
}

async function assertPathInsidePackage(packageDir, target, label) {
  if (typeof target !== "string" || target.includes("*")) return;
  const clean = target.replace(/^\.\//, "");
  const resolved = path.resolve(packageDir, clean);
  const root = `${path.resolve(packageDir)}${path.sep}`;
  if (!resolved.startsWith(root)) {
    throw new Error(`${label} escapes the package root: ${target}`);
  }
  await access(resolved).catch(() => {
    throw new Error(`${label} target is missing from the packed artifact: ${target}`);
  });
}

async function assertExternalSourceMap(packageDir, target, label) {
  if (typeof target !== "string" || !/\.(?:c|m)?js$/u.test(target)) return;
  const clean = target.replace(/^\.\//, "");
  const mapPath = path.resolve(packageDir, `${clean}.map`);
  const raw = await readFile(mapPath, "utf8").catch(() => {
    throw new Error(`${label} is missing an external source map: ${target}.map`);
  });
  let sourceMap;
  try {
    sourceMap = JSON.parse(raw);
  } catch {
    throw new Error(`${label} source map is not valid JSON: ${target}.map`);
  }
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    throw new Error(`${label} source map has no sources: ${target}.map`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageDirArg = args["package-dir"];
  const expectedName = args.name;
  const expectedVersion = args.version;
  const expectedRepository = args.repository;
  const expectedDirectory = args.directory;
  if (!packageDirArg || !expectedName || !expectedVersion || !expectedRepository || !expectedDirectory) {
    throw new Error("--package-dir, --name, --version, --repository, and --directory are required");
  }
  const packageDir = path.resolve(packageDirArg);

  const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (pkg.name !== expectedName || pkg.version !== expectedVersion) {
    throw new Error(`installed identity is ${pkg.name}@${pkg.version}; expected ${expectedName}@${expectedVersion}`);
  }
  if (pkg.private === true) {
    throw new Error("packed artifact is marked private");
  }
  if (pkg.publishConfig?.access !== "public") {
    throw new Error("packed artifact is not configured for public access");
  }
  const expectedRepositoryURL = `git+https://github.com/${expectedRepository}.git`;
  if (pkg.repository?.url !== expectedRepositoryURL || pkg.repository?.directory !== expectedDirectory) {
    throw new Error(
      `packed repository metadata must be ${expectedRepositoryURL} (${expectedDirectory})`,
    );
  }
  if (pkg.bugs?.url !== `https://github.com/${expectedRepository}/issues`) {
    throw new Error("packed bugs.url does not match the publishing repository");
  }

  for (const file of ["README.md", "LICENSE"]) {
    await access(path.join(packageDir, file)).catch(() => {
      throw new Error(`${file} is missing from the packed artifact`);
    });
  }

  const dependencyGroups = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies];
  for (const group of dependencyGroups) {
    for (const [name, version] of Object.entries(group ?? {})) {
      if (String(version).startsWith("workspace:")) {
        throw new Error(`unresolved workspace protocol in ${name}: ${version}`);
      }
    }
  }

  const directEntries = [pkg.main, pkg.module, pkg.types, pkg.typings];
  for (const target of directEntries) {
    if (target) {
      await assertPathInsidePackage(packageDir, target, "entrypoint");
      await assertExternalSourceMap(packageDir, target, "entrypoint");
    }
  }
  for (const target of collectEntryTargets(pkg.exports)) {
    await assertPathInsidePackage(packageDir, target, "exports");
    await assertExternalSourceMap(packageDir, target, "exports");
  }
  for (const target of Object.values(typeof pkg.bin === "string" ? { bin: pkg.bin } : (pkg.bin ?? {}))) {
    await assertPathInsidePackage(packageDir, target, "bin");
    await assertExternalSourceMap(packageDir, target, "bin");
    const mode = (await stat(path.resolve(packageDir, String(target).replace(/^\.\//, "")))).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`bin target is not executable: ${target}`);
    }
  }

  const allEntries = [
    ...directEntries,
    ...collectEntryTargets(pkg.exports),
  ].filter((target) => typeof target === "string");
  for (const target of allEntries) {
    if (/(?:^|\/)src\/.*\.(?:ts|tsx)$/u.test(target)) {
      throw new Error(`packed artifact exposes raw TypeScript source: ${target}`);
    }
  }
  if ((pkg.files ?? []).some((entry) => entry === "src" || entry === "./src")) {
    throw new Error("packed artifact includes raw src instead of compiled output");
  }
  for (const target of [pkg.types, pkg.typings]) {
    if (target && !/\.d\.(?:ts|cts|mts)$/u.test(target)) {
      throw new Error(`types entrypoint is not a declaration file: ${target}`);
    }
  }

  process.stdout.write(`verified packed consumer artifact: ${expectedName}@${expectedVersion}\n`);
}

main().catch((error) => {
  process.stderr.write(`packed npm verification: ${error.message}\n`);
  process.exitCode = 1;
});
