#!/usr/bin/env node
//
// codegen.mjs — wrapper around `openapi-typescript` that:
//   1. Generates `packages/openapi/dist/types.ts` from
//      `packages/openapi/surfaces/openapi.yaml`.
//   2. Supports `--check` mode for CI: regenerates into a temp file and
//      exits 1 if the committed `dist/types.ts` is out of date.
//
// Run from anywhere; the script resolves paths relative to itself.
//
//   node packages/openapi/scripts/codegen.mjs          # write
//   node packages/openapi/scripts/codegen.mjs --check  # CI drift gate
//
// Why a wrapper and not just `openapi-typescript ... -o ...` in
// package.json: the `--check` mode is a custom drift guard that
// `openapi-typescript` doesn't ship out of the box. Keeping it here
// means CI uses the *exact* same code path as local dev, which
// eliminates a class of "works on my machine" drift bugs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const specPath = join(pkgRoot, "surfaces", "openapi.yaml");
const outPath = join(pkgRoot, "dist", "types.ts");

function runCodegen(target) {
  // Pinned major + minor for reproducibility. Update intentionally
  // during dependency maintenance, then re-run `pnpm openapi:codegen`
  // and commit the regenerated dist.
  const args = ["-y", "openapi-typescript@7.13.0", specPath, "-o", target];
  execFileSync("npx", args, { stdio: "inherit" });
}

const check = process.argv.includes("--check");

if (check) {
  if (!existsSync(outPath)) {
    process.stderr.write(
      "openapi:codegen --check: dist/types.ts is missing. " +
        "Run `pnpm openapi:codegen` and commit the output.\n",
    );
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), "postwave-openapi-codegen-"));
  const tmpOut = join(tmp, "types.ts");
  try {
    runCodegen(tmpOut);
    const committed = readFileSync(outPath, "utf8");
    const regenerated = readFileSync(tmpOut, "utf8");
    if (committed !== regenerated) {
      process.stderr.write(
        "openapi:codegen --check: dist/types.ts is out of sync with " +
          "surfaces/openapi.yaml.\nRun `pnpm openapi:codegen` and commit " +
          "the regenerated file.\n",
      );
      process.exit(1);
    }
    process.stdout.write("openapi:codegen --check: dist/types.ts is in sync.\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  runCodegen(outPath);
}
