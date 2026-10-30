#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const REPOSITORY = "harsh2929/postwave";
const TYPESCRIPT_VERSION = "5.9.3";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(`${command} exited ${result.status}${detail}`);
  }
  return result;
}

function releasePlan() {
  const result = run(
    process.execPath,
    [
      "scripts/release/npm-release-plan.mjs",
      "--event",
      "dispatch",
      "--tag",
      "",
      "--package",
      "",
      "--repository",
      REPOSITORY,
    ],
    { capture: true },
  );
  return JSON.parse(result.stdout).include;
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("verify-npm-package-set.mjs does not accept arguments");
  }
  const plan = releasePlan();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "postwave-npm-package-set-"),
  );
  try {
    const tarballs = [];
    for (const entry of plan) {
      const artifactDir = path.join(
        temporaryRoot,
        "artifacts",
        entry.directory,
      );
      const unpackDir = path.join(
        temporaryRoot,
        "unpacked",
        entry.directory,
      );
      await mkdir(artifactDir, { recursive: true });
      await mkdir(unpackDir, { recursive: true });
      run(pnpm, [
        "--dir",
        `packages/${entry.directory}`,
        "pack",
        "--pack-destination",
        artifactDir,
      ]);
      const packed = (await readdir(artifactDir)).filter((file) =>
        file.endsWith(".tgz"),
      );
      if (packed.length !== 1) {
        throw new Error(
          `${entry.name} produced ${packed.length} tarballs; expected exactly one`,
        );
      }
      const tarball = path.join(artifactDir, packed[0]);
      tarballs.push(tarball);
      run("tar", ["-xzf", tarball, "-C", unpackDir]);
      run(process.execPath, [
        "scripts/release/verify-packed-npm-package.mjs",
        "--package-dir",
        path.join(unpackDir, "package"),
        "--name",
        entry.name,
        "--version",
        entry.version,
        "--repository",
        REPOSITORY,
        "--directory",
        `packages/${entry.directory}`,
      ]);
    }

    const consumerDir = path.join(temporaryRoot, "consumer");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify({ name: "postwave-package-consumer", private: true }, null, 2)}\n`,
      "utf8",
    );
    run(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...tarballs,
        `typescript@${TYPESCRIPT_VERSION}`,
      ],
      { cwd: consumerDir },
    );
    run(process.execPath, [
      "scripts/release/verify-public-package-consumers.mjs",
      "--consumer-dir",
      consumerDir,
    ]);

    const identities = [];
    for (const tarball of tarballs) {
      const packageJson = run(
        "tar",
        ["-xOf", tarball, "package/package.json"],
        { capture: true },
      );
      const pkg = JSON.parse(packageJson.stdout);
      identities.push(`${pkg.name}@${pkg.version}`);
    }
    if (new Set(identities).size !== plan.length) {
      throw new Error("packed release set contains duplicate package identities");
    }
    process.stdout.write(
      `verified ${plan.length} packed npm artifacts and the clean public-library consumer\n`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`npm package-set verification: ${error.message}\n`);
  process.exitCode = 1;
});
