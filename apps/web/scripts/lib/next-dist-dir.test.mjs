// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureIsolatedNextTsconfig,
  resolveNextDistDir,
  resolveNextDistDirName,
} from "./next-dist-dir.mjs";

const appDir = path.resolve("/workspace/apps/web");

test("defaults to the canonical .next directory", () => {
  assert.equal(resolveNextDistDir(appDir), path.join(appDir, ".next"));
});

test("accepts one simple app-local isolated directory name", () => {
  assert.equal(resolveNextDistDirName(".next-audit"), ".next-audit");
  assert.equal(
    resolveNextDistDir(appDir, ".next-audit"),
    path.join(appDir, ".next-audit"),
  );
  assert.equal(
    resolveNextDistDir(appDir, ".next-route-budget.2"),
    path.join(appDir, ".next-route-budget.2"),
  );
});

test("rejects absolute, temporary, nested, traversal and arbitrary paths", () => {
  assert.throws(() => resolveNextDistDir(appDir, ".."));
  assert.throws(() => resolveNextDistDir(appDir, "/"));
  assert.throws(() => resolveNextDistDir(appDir, "/tmp/postwave-web-audit"));
  assert.throws(() => resolveNextDistDir(appDir, "../.next-audit"));
  assert.throws(() => resolveNextDistDir(appDir, "tmp/.next-audit"));
  assert.throws(() => resolveNextDistDir(appDir, ".next-audit/child"));
  assert.throws(() => resolveNextDistDir(appDir, ".next-"));
  assert.throws(() => resolveNextDistDir(appDir, "public"));
});

test("isolated builds use an ephemeral extending tsconfig", () => {
  const temporaryApp = fs.mkdtempSync(path.join(os.tmpdir(), "next-dist-dir-"));
  let generated;
  try {
    const distDir = path.join(temporaryApp, ".next-dist-dir-test");
    const relative = ensureIsolatedNextTsconfig(
      temporaryApp,
      distDir,
      ".next-dist-dir-test",
    );
    generated = path.resolve(temporaryApp, relative);
    assert.ok(generated.startsWith(`${os.tmpdir()}${path.sep}`));
    assert.ok(!generated.startsWith(`${temporaryApp}${path.sep}`));
    const config = JSON.parse(fs.readFileSync(generated, "utf8"));
    assert.equal(config.extends, path.join(temporaryApp, "tsconfig.json"));
    assert.equal(config.compilerOptions.strict, true);
    assert.deepEqual(config.compilerOptions.plugins, [{ name: "next" }]);
    assert.ok(config.include.includes(path.join(distDir, "types/**/*.ts")));
    assert.ok(config.include.includes(".next-dist-dir-test/types/**/*.ts"));
    assert.equal(
      ensureIsolatedNextTsconfig(temporaryApp, distDir),
      "tsconfig.json",
    );
  } finally {
    if (generated) fs.rmSync(generated, { force: true });
    fs.rmSync(temporaryApp, { recursive: true, force: true });
  }
});
