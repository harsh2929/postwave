#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PUBLIC_LIBRARY_SMOKES = new Map([
  ["@postwave/design-tokens", "tokens"],
  ["@postwave/nav", "NAV_ENTRIES"],
  ["@postwave/notifications", "NOTIFICATIONS"],
  ["@postwave/onboarding-schema", "CHECKLIST_GOALS"],
  ["@postwave/query-contract", "qk"],
  ["@postwave/route-map", "ENTITIES"],
  ["@postwave/schema", null],
  ["@postwave/telemetry", "EVENTS"],
]);

const TYPE_SMOKE = `
import { tokens } from "@postwave/design-tokens";
import { NAV_ENTRIES } from "@postwave/nav";
import { NOTIFICATIONS } from "@postwave/notifications";
import { CHECKLIST_GOALS } from "@postwave/onboarding-schema";
import { qk } from "@postwave/query-contract";
import { ENTITIES } from "@postwave/route-map";
import type { Subscriber } from "@postwave/schema";
import { EVENTS } from "@postwave/telemetry";

const subscriber = {} as Subscriber;
void [
  tokens.light,
  NAV_ENTRIES,
  NOTIFICATIONS,
  CHECKLIST_GOALS,
  qk,
  ENTITIES,
  subscriber,
  EVENTS,
];
`;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument list near ${key ?? "<end>"}`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

function importTarget(exportsEntry) {
  if (typeof exportsEntry === "string") return exportsEntry;
  if (!exportsEntry || typeof exportsEntry !== "object") return null;
  if (typeof exportsEntry.import === "string") return exportsEntry.import;
  if (exportsEntry.import && typeof exportsEntry.import === "object") {
    return exportsEntry.import.default ?? null;
  }
  return exportsEntry.default ?? null;
}

async function verifyRuntimeImports(consumerDir) {
  for (const [name, expectedExport] of PUBLIC_LIBRARY_SMOKES) {
    const packageDir = path.join(consumerDir, "node_modules", ...name.split("/"));
    const pkg = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    );
    const target = importTarget(pkg.exports?.["."] ?? pkg.exports) ?? pkg.module ?? pkg.main;
    if (typeof target !== "string") {
      throw new Error(`${name} has no importable ESM entrypoint`);
    }
    const entry = path.resolve(packageDir, target.replace(/^\.\//u, ""));
    const packageRoot = `${path.resolve(packageDir)}${path.sep}`;
    if (!entry.startsWith(packageRoot)) {
      throw new Error(`${name} import entrypoint escapes its package`);
    }
    const imported = await import(pathToFileURL(entry).href);
    if (expectedExport && !(expectedExport in imported)) {
      throw new Error(`${name} runtime import is missing ${expectedExport}`);
    }
  }
}

async function verifyTypeImports(consumerDir) {
  const typescript = path.join(
    consumerDir,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  await access(typescript).catch(() => {
    throw new Error("clean consumer must install the pinned TypeScript compiler");
  });
  const fixtureDir = await mkdtemp(
    path.join(consumerDir, ".postwave-package-smoke-"),
  );
  try {
    await writeFile(path.join(fixtureDir, "consumer.mts"), TYPE_SMOKE, "utf8");
    await writeFile(
      path.join(fixtureDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2022",
          },
          files: ["consumer.mts"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [typescript, "--project", path.join(fixtureDir, "tsconfig.json")],
      { cwd: consumerDir, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `clean TypeScript consumer failed:\n${result.stdout}${result.stderr}`,
      );
    }
  } finally {
    await rm(fixtureDir, { force: true, recursive: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["consumer-dir"]) {
    throw new Error("--consumer-dir is required");
  }
  const consumerDir = path.resolve(args["consumer-dir"]);
  await access(path.join(consumerDir, "package.json"));
  await verifyRuntimeImports(consumerDir);
  await verifyTypeImports(consumerDir);
  process.stdout.write(
    `verified clean runtime and TypeScript consumers for ${PUBLIC_LIBRARY_SMOKES.size} public libraries\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`public package consumer verification: ${error.message}\n`);
  process.exitCode = 1;
});
