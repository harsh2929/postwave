// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const ISOLATED_DIST_DIR = /^\.next-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve the optional isolated Next build directory without allowing an env
 * typo to make `next build` clean an arbitrary workspace/system directory.
 * Next treats distDir as app-relative even when an absolute path is supplied,
 * so accepting `/tmp/foo` is both misleading and unsafe: Next writes to
 * `<app>/tmp/foo` while companion scripts inspect `/tmp/foo`. Normal builds
 * remain on `<app>/.next`; isolated jobs must use one simple app-local
 * `.next-*` directory name, consumed by both Next and the bundle checker.
 */
export function resolveNextDistDirName(rawValue) {
  const raw = rawValue?.trim() || ".next";
  if (raw.includes("\0")) {
    throw new Error("POSTWAVE_NEXT_DIST_DIR contains a NUL byte");
  }

  if (raw !== ".next" && !ISOLATED_DIST_DIR.test(raw)) {
    throw new Error(
      "POSTWAVE_NEXT_DIST_DIR must be .next or a simple app-local .next-* directory name",
    );
  }
  return raw;
}

export function resolveNextDistDir(appDir, rawValue) {
  return path.join(appDir, resolveNextDistDirName(rawValue));
}

/**
 * Next 15 otherwise appends an absolute isolated `distDir/types` glob to the
 * repository tsconfig during `next build`. Point isolated builds at an
 * ephemeral extending config outside the repository so verification is
 * side-effect-free and source hashes remain meaningful.
 */
export function ensureIsolatedNextTsconfig(appDir, distDir, rawValue) {
  if (!rawValue?.trim()) return "tsconfig.json";

  const identity = createHash("sha256")
    .update(`${appDir}\0${distDir}`)
    .digest("hex")
    .slice(0, 16);
  const tsconfigPath = path.join(
    os.tmpdir(),
    `postwave-next-${identity}.tsconfig.json`,
  );
  const config = {
    extends: path.join(appDir, "tsconfig.json"),
    compilerOptions: {
      plugins: [{ name: "next" }],
      strict: true,
    },
    include: [
      path.join(appDir, "next-env.d.ts"),
      path.join(appDir, "**/*.ts"),
      path.join(appDir, "**/*.tsx"),
      path.join(distDir, "types/**/*.ts"),
      path.relative(appDir, path.join(distDir, "types/**/*.ts")),
    ],
    exclude: [path.join(appDir, "node_modules")],
  };
  fs.mkdirSync(path.dirname(tsconfigPath), { recursive: true });
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (
    !fs.existsSync(tsconfigPath) ||
    fs.readFileSync(tsconfigPath, "utf8") !== content
  ) {
    fs.writeFileSync(tsconfigPath, content);
  }
  return path.relative(appDir, tsconfigPath);
}
