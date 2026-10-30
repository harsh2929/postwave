import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(mobileRoot, "scripts", "validate-release-version.mjs");
const { version } = JSON.parse(
  readFileSync(join(mobileRoot, "app.json"), "utf8"),
).expo;

function run(env) {
  return spawnSync(process.execPath, [script], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      // This suite runs inside GitHub Actions too, and the runner's own ref
      // must not leak into a case that describes a different one.
      GITHUB_REF: "",
      GITHUB_REF_NAME: "",
      GITHUB_REF_TYPE: "",
      SUBMIT_AFTER_BUILD: "",
      ...env,
    },
    encoding: "utf8",
  });
}

/**
 * PO-8. runtimeVersion is {policy: "appVersion"}, so every binary built at
 * expo.version X takes every OTA update published for runtime X. Nothing bumps
 * expo.version when the native surface changes: the bump is a manual step, and
 * a mobile-v<version> tag is the only thing that enforces it. A store
 * submission dispatched from a branch skipped the check entirely, and Play
 * accepts a second binary with the same versionName and a higher versionCode.
 * That is how two binaries with different native modules end up sharing one
 * runtime, and an update meant for the newer one reaches the older one.
 */
describe("validate-release-version.mjs", () => {
  it("refuses a store submission built from a branch", () => {
    const result = run({
      GITHUB_REF_NAME: "main",
      GITHUB_REF_TYPE: "branch",
      SUBMIT_AFTER_BUILD: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`mobile-v${version}`);
    expect(result.stderr).toContain("runtimeVersion");
  });

  it("refuses a store submission with no ref at all", () => {
    const result = run({ SUBMIT_AFTER_BUILD: "true" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`mobile-v${version}`);
  });

  it("refuses a store submission from a branch that is merely NAMED like a release tag", () => {
    // A branch moves; a tag does not. Two commits on one branch called
    // mobile-v<version> would still be two native surfaces on one runtime.
    const result = run({
      GITHUB_REF_NAME: `mobile-v${version}`,
      GITHUB_REF_TYPE: "branch",
      SUBMIT_AFTER_BUILD: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tag");
  });

  it("still lets a branch build that submits nothing through", () => {
    const result = run({ GITHUB_REF_NAME: "main", GITHUB_REF_TYPE: "branch" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skipping version check");
  });

  it.each([
    ["GITHUB_REF_NAME + GITHUB_REF_TYPE", { GITHUB_REF_NAME: `mobile-v${version}`, GITHUB_REF_TYPE: "tag" }],
    ["GITHUB_REF only", { GITHUB_REF: `refs/tags/mobile-v${version}` }],
  ])("accepts a store submission from the matching mobile-v tag (%s)", (_label, ref) => {
    const result = run({ ...ref, SUBMIT_AFTER_BUILD: "true" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`matches version ${version}`);
  });

  it("refuses a mobile-v tag that does not match app.json, submitting or not", () => {
    for (const submit of ["true", ""]) {
      const result = run({
        GITHUB_REF_NAME: "mobile-v999.0.0",
        GITHUB_REF_TYPE: "tag",
        SUBMIT_AFTER_BUILD: submit,
      });
      expect(result.status, `SUBMIT_AFTER_BUILD=${submit || "<unset>"}`).toBe(1);
      expect(result.stderr).toContain(`app.json expo.version is ${version}`);
    }
  });
});

describe("mobile-release.yml hands the submit decision to the version check", () => {
  // Without this wiring the check above is dead code in CI: the script only
  // refuses a branch submission when it is told the run will submit.
  const workflow = readFileSync(
    join(mobileRoot, "..", "..", ".github", "workflows", "mobile-release.yml"),
    "utf8",
  );
  /** One step's lines, with YAML comments dropped so prose cannot satisfy it. */
  function stepBlock(name) {
    const start = workflow.indexOf(`- name: ${name}\n`);
    expect(start, `no "${name}" step`).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start);
    const next = rest.indexOf("\n      - name: ", 1);
    return (next === -1 ? rest : rest.slice(0, next))
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  }

  it("passes the planned submit flag to the step that runs the check", () => {
    const check = stepBlock("Validate mobile tag version");
    expect(check).toContain("release:version-check");
    expect(check).toMatch(
      /^\s+SUBMIT_AFTER_BUILD: \$\{\{ steps\.plan\.outputs\.submit_after_build \}\}$/m,
    );

    // `steps.plan` only resolves for an EARLIER step of the same job, and it
    // is the same output the submit job's `if:` reads.
    const plan = stepBlock("Resolve release plan");
    expect(plan).toMatch(/^\s+id: plan$/m);
    expect(plan).toContain('echo "submit_after_build=$SUBMIT_AFTER_BUILD"');
    expect(workflow.indexOf("- name: Resolve release plan")).toBeLessThan(
      workflow.indexOf("- name: Validate mobile tag version"),
    );
    expect(workflow).toContain(
      "needs.quality.outputs.submit_after_build == 'true'",
    );
  });
});
