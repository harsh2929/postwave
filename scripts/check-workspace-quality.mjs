#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const NOOP_SCRIPT =
  /(?:^|(?:&&|\|\||;)\s*)(?::|true|exit\s+0)(?:\s|$)|\b(?:echo|printf)\b[^\n]*(?:skip(?:ped)?|no[- ]?op|no\s+(?:build|lint|typecheck)\s+step|not\s+implemented|todo)/iu;
const RAW_SOURCE_ENTRY = /(?:^|\/)src\/.*\.(?:ts|tsx)$/u;

function requireScript(pkg, name, directory) {
  const command = pkg.scripts?.[name];
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error(`${directory} must define a non-empty ${name} script`);
  }
  if (NOOP_SCRIPT.test(command)) {
    throw new Error(`${directory} ${name} script is a skip/no-op: ${command}`);
  }
  return command.trim();
}

function expandScript(pkg, name, directory, seen = new Set()) {
  if (seen.has(name)) {
    throw new Error(`${directory} scripts contain a cycle through ${name}`);
  }
  seen.add(name);
  const command = requireScript(pkg, name, directory);
  const expanded = [command];
  const referencePattern = /\bpnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)/gu;
  for (const match of command.matchAll(referencePattern)) {
    const referencedName = match[1];
    if (referencedName && pkg.scripts?.[referencedName]) {
      expanded.push(
        expandScript(pkg, referencedName, directory, new Set(seen)),
      );
    }
  }
  return expanded.join("\n");
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

function validatePackageManifest(pkg, directory) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error(`${directory}/package.json must contain an object`);
  }
  if (typeof pkg.name !== "string" || pkg.name.trim() === "") {
    throw new Error(`${directory} must have a package name`);
  }

  const lint = expandScript(pkg, "lint", directory);
  const typecheck = expandScript(pkg, "typecheck", directory);
  if (!/(?:^|\s)(?:eslint|stylelint)(?:\s|$)|\b(?:expo|next)\s+lint\b/u.test(lint)) {
    throw new Error(
      `${directory} lint must execute ESLint or Stylelint; typechecking alone is not linting`,
    );
  }
  if (!/(?:^|\s)tsc(?:\s|$)/u.test(typecheck)) {
    throw new Error(`${directory} typecheck must execute the TypeScript compiler`);
  }
  if (lint === typecheck) {
    throw new Error(`${directory} lint and typecheck scripts must be distinct gates`);
  }

  if (pkg.private !== true) {
    const entries = [
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.typings,
      ...collectEntryTargets(pkg.exports),
    ].filter((target) => typeof target === "string");
    for (const target of entries) {
      if (RAW_SOURCE_ENTRY.test(target)) {
        throw new Error(
          `${directory} exposes raw TypeScript source at ${target}; publish compiled dist output`,
        );
      }
    }
    if ((pkg.files ?? []).some((entry) => entry === "src" || entry === "./src")) {
      throw new Error(`${directory} publishes its src directory instead of built output`);
    }
    if (pkg.publishConfig?.access === "public") {
      requireScript(pkg, "build", directory);
      if (!Array.isArray(pkg.files) || !pkg.files.includes("README.md") || !pkg.files.includes("LICENSE")) {
        throw new Error(
          `${directory} public npm artifact must explicitly include README.md and LICENSE`,
        );
      }
    }
  }
}

async function expandWorkspacePattern(pattern) {
  if (path.isAbsolute(pattern) || pattern.split("/").includes("..")) {
    throw new Error(`workspace pattern escapes the repository: ${pattern}`);
  }
  const segments = pattern.split("/").filter(Boolean);
  if (segments.some((segment) => segment !== "*" && /[*?\[\]]/u.test(segment))) {
    throw new Error(`unsupported workspace glob; use path segments or *: ${pattern}`);
  }

  let candidates = [ROOT];
  for (const segment of segments) {
    const next = [];
    for (const candidate of candidates) {
      if (segment === "*") {
        const entries = await readdir(candidate, { withFileTypes: true });
        next.push(
          ...entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => path.join(candidate, entry.name)),
        );
      } else {
        next.push(path.join(candidate, segment));
      }
    }
    candidates = next;
  }

  const packageDirectories = [];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "package.json"));
      packageDirectories.push(path.relative(ROOT, candidate));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return packageDirectories;
}

async function discoverWorkspaces() {
  const workspace = parseYaml(
    await readFile(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"),
  );
  if (!Array.isArray(workspace?.packages) || workspace.packages.length === 0) {
    throw new Error("pnpm-workspace.yaml must define a non-empty packages array");
  }
  if (new Set(workspace.packages).size !== workspace.packages.length) {
    throw new Error("pnpm-workspace.yaml contains duplicate package patterns");
  }

  const directories = [];
  for (const pattern of workspace.packages) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error("every workspace package pattern must be a non-empty string");
    }
    directories.push(...(await expandWorkspacePattern(pattern)));
  }
  const duplicates = directories.filter(
    (directory, index) => directories.indexOf(directory) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `workspace package matched more than once: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
  return directories.sort();
}

async function validateRepository() {
  const directories = await discoverWorkspaces();
  const names = new Map();
  const errors = [];
  for (const directory of directories) {
    try {
      const pkg = JSON.parse(
        await readFile(path.join(ROOT, directory, "package.json"), "utf8"),
      );
      validatePackageManifest(pkg, directory);
      if (names.has(pkg.name)) {
        throw new Error(
          `${directory} duplicates package name ${pkg.name} from ${names.get(pkg.name)}`,
        );
      }
      names.set(pkg.name, directory);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const rootPackage = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  if (rootPackage.scripts?.["audit:workspace-quality"] !== "node scripts/check-workspace-quality.mjs") {
    errors.push("root audit:workspace-quality script is missing or changed");
  }
  if (rootPackage.scripts?.["test:workspace-quality"] !== "node scripts/check-workspace-quality.mjs --self-test") {
    errors.push("root test:workspace-quality script is missing or changed");
  }
  const ci = await readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const command of [
    "run: pnpm audit:workspace-quality",
    "run: pnpm test:workspace-quality",
  ]) {
    if (!ci.includes(command)) errors.push(`CI is missing blocking command: ${command}`);
  }

  if (errors.length > 0) {
    throw new Error(`workspace quality contract failed:\n- ${errors.join("\n- ")}`);
  }
  process.stdout.write(
    `workspace quality contract passed: ${directories.length} packages, ${names.size} unique names\n`,
  );
}

function runSelfTests() {
  const valid = {
    name: "@postwave/example",
    scripts: {
      build: "tsc -p tsconfig.build.json",
      lint: "eslint src --max-warnings 0",
      typecheck: "tsc --noEmit",
    },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    files: ["dist", "README.md", "LICENSE"],
    publishConfig: { access: "public" },
  };
  assert.doesNotThrow(() => validatePackageManifest(valid, "packages/example"));

  const failures = [
    [{ ...valid, scripts: { ...valid.scripts, lint: undefined } }, /must define a non-empty lint/u],
    [{ ...valid, scripts: { ...valid.scripts, typecheck: "echo skipped" } }, /skip\/no-op/u],
    [{ ...valid, scripts: { ...valid.scripts, lint: "tsc --noEmit" } }, /typechecking alone/u],
    [{ ...valid, main: "src/index.ts" }, /exposes raw TypeScript source/u],
    [{ ...valid, files: ["src", "README.md", "LICENSE"] }, /publishes its src directory/u],
  ];
  for (const [fixture, expected] of failures) {
    assert.throws(
      () => validatePackageManifest(fixture, "packages/example"),
      expected,
    );
  }
  process.stdout.write(`workspace quality self-tests passed: ${failures.length} fail-closed cases\n`);
}

if (process.argv.length === 2) {
  await validateRepository();
} else if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTests();
} else {
  process.stderr.write("usage: node scripts/check-workspace-quality.mjs [--self-test]\n");
  process.exitCode = 2;
}
