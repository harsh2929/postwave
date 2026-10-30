import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/release/npm-release-plan.mjs");
const REPOSITORY = "harsh2929/postwave";

function plan(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("full dispatch excludes release-held MCP distributions", () => {
  const result = plan(
    "--event",
    "dispatch",
    "--tag",
    "",
    "--package",
    "",
    "--repository",
    REPOSITORY,
  );
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout);
  assert.equal(matrix.include.length, 15);
  assert.equal(
    matrix.include.some(({ directory }) =>
      ["mcp-server", "claude-code-plugin"].includes(directory),
    ),
    false,
  );
  assert.deepEqual(
    matrix.include.slice(0, 7).map(({ directory, build_mode }) => ({
      directory,
      build_mode,
    })),
    [
      "design-tokens",
      "nav",
      "onboarding-schema",
      "query-contract",
      "route-map",
      "telemetry",
      "schema",
    ].map((directory) => ({ directory, build_mode: "build" })),
  );
  assert.equal(
    matrix.include.find(({ directory }) => directory === "notifications")
      ?.build_mode,
    "build",
  );
});

test("manual dispatch refuses every release-held MCP distribution", () => {
  for (const directory of ["mcp-server", "claude-code-plugin"]) {
    const result = plan(
      "--event",
      "dispatch",
      "--tag",
      "",
      "--package",
      directory,
      "--repository",
      REPOSITORY,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mcp_distribution_release_held/u);
  }
});

test("tag releases exclude release-held MCP distributions", () => {
  const result = plan(
    "--event",
    "tag",
    "--tag",
    "packages-v0.1.0",
    "--package",
    "",
    "--repository",
    REPOSITORY,
  );
  assert.equal(result.status, 0, result.stderr);
  const directories = JSON.parse(result.stdout).include.map(
    ({ directory }) => directory,
  );
  assert.equal(directories.includes("mcp-server"), false);
  assert.equal(directories.includes("claude-code-plugin"), false);
});

test("single-package dispatch selects exactly the requested package", () => {
  const result = plan(
    "--event",
    "dispatch",
    "--tag",
    "",
    "--package",
    "route-map",
    "--repository",
    REPOSITORY,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).include, [
    {
      directory: "route-map",
      name: "@postwave/route-map",
      version: "0.1.0",
      build_mode: "build",
    },
  ]);
});

// A planned package that is not a pnpm workspace member is published by a
// pipeline that cannot build it. `packages/track` sat in this state: every CI
// packages step is `pnpm -r --filter './packages/**'`, which enumerates
// workspace members, so its build, typecheck and tests were all silently
// skipped; publish-packages' `pnpm --filter "./packages/track" run build`
// printed "No projects matched the filters" and exited 0; and because dist/ is
// gitignored, the packed tarball on a clean runner contained no entrypoint at
// all. It failed closed at verify-packed-npm-package.mjs rather than shipping
// an empty package — but nothing failed until then, and nothing said why.
//
// pnpm is the authority here on purpose: re-deriving workspace membership from
// pnpm-workspace.yaml's globs would be a second implementation of the rule,
// free to drift from the one that actually selects the packages.
test("every package the release plan publishes is a pnpm workspace member", () => {
  const result = plan(
    "--event",
    "dispatch",
    "--tag",
    "",
    "--package",
    "",
    "--repository",
    REPOSITORY,
  );
  assert.equal(result.status, 0, result.stderr);
  const planned = JSON.parse(result.stdout).include;

  const listed = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["ls", "-r", "--depth", "-1", "--json"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(
    listed.status,
    0,
    `pnpm ls failed, so workspace membership could not be established: ${listed.stderr}`,
  );
  const members = new Set(
    JSON.parse(listed.stdout).map((project) => project.name),
  );
  assert.ok(members.size > 0, "pnpm reported no workspace projects");

  const orphaned = planned
    .filter(({ name }) => !members.has(name))
    .map(({ name, directory }) => `${name} (packages/${directory})`);
  assert.deepEqual(
    orphaned,
    [],
    `these packages are in the npm release plan but are not pnpm workspace ` +
      `members, so every 'pnpm -r --filter ./packages/**' step skips them and ` +
      `their build never runs before pack: ${orphaned.join(", ")}`,
  );
});

test("unknown package, malformed repository, and invalid tag fail closed", () => {
  const cases = [
    [
      "--event",
      "dispatch",
      "--tag",
      "",
      "--package",
      "missing",
      "--repository",
      REPOSITORY,
    ],
    [
      "--event",
      "dispatch",
      "--tag",
      "",
      "--package",
      "route-map",
      "--repository",
      "not-a-repository",
    ],
    [
      "--event",
      "tag",
      "--tag",
      "packages-vlatest",
      "--package",
      "",
      "--repository",
      REPOSITORY,
    ],
  ];
  for (const args of cases) {
    const result = plan(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^npm release plan:/u);
  }
});
