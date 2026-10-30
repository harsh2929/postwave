/**
 * `scripts/upload-sourcemaps.sh` runs with SENTRY_AUTH_TOKEN exported into the
 * environment of everything it spawns. That token is org-scoped: it can read
 * and write releases across every Sentry project the org owns.
 *
 * The script used to reach sentry-cli through npm's install-and-execute
 * runner, with no version and no integrity constraint. That is a supply-chain
 * hole of the worst shape — it resolves `latest` at run time, downloads a
 * tarball nobody has reviewed, and executes it with the token already in reach.
 * A single compromised publish (or a name that resolves somewhere unexpected
 * on a mirror) exfiltrates the token from a release runner, silently, on a
 * green build.
 *
 * The fix is to run the binary the lockfile already pins. These tests hold both
 * halves of that:
 *
 *  - BEHAVIOURAL. The script is executed for real against a throwaway bundle,
 *    with a poisoned `npx` first on PATH. If anything still routes through it,
 *    the poison leaves a marker file. The debug-id that sentry-cli injects into
 *    the bundle is the positive proof that the pinned binary — not a stub —
 *    did the work.
 *  - STRUCTURAL. Nothing in the executable body may install-and-execute at all.
 *    A future edit that adds `pnpm dlx` or `npm exec` instead of `npx` is the
 *    same hole under a different name.
 *
 * The upload itself is pointed at an unroutable local port so no test ever
 * talks to sentry.io; the script exits non-zero at that step by design, and
 * everything asserted here happens before it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = process.cwd();
const scriptPath = join(appRoot, "scripts", "upload-sourcemaps.sh");
const scriptSource = readFileSync(scriptPath, "utf8");

/** Shell comments removed, so prose describing the old hole is not the hole. */
function executableLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

/**
 * Every way npm-family tooling will fetch-then-run a package. Kept as one
 * pattern because they are one behaviour: `npx` was simply the spelling that
 * shipped.
 */
const INSTALL_AND_EXECUTE =
  /\b(npx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec|pnpm\s+exec\s+--)\b/u;

const sentryRnPkg = JSON.parse(
  readFileSync(
    resolve(appRoot, "node_modules/@sentry/react-native/package.json"),
    "utf8",
  ),
) as { dependencies?: Record<string, string> };

const pinnedCliVersion = sentryRnPkg.dependencies?.["@sentry/cli"] ?? "";

describe("source-map upload never installs-and-executes", () => {
  it("resolves sentry-cli from a dependency pinned to an exact version", () => {
    // The whole claim rests on this: `^2.58.4` would put us back to running
    // whatever the registry serves, only one indirection further away.
    expect(pinnedCliVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("contains no fetch-then-run invocation in its executable body", () => {
    expect(executableLines(scriptSource)).not.toMatch(INSTALL_AND_EXECUTE);
  });

  it("can fail — the detector recognises the pattern it is guarding against", () => {
    // Vacuity floor. Without this, deleting the regex body or stripping the
    // whole file to comments would leave the test above passing.
    expect(executableLines('npx --yes @sentry/cli releases finalize "$R"')).toMatch(
      INSTALL_AND_EXECUTE,
    );
    expect(executableLines('pnpm dlx @sentry/cli sourcemaps upload .')).toMatch(
      INSTALL_AND_EXECUTE,
    );
    // ...and it must not be so broad that a comment about the old hole trips it.
    expect(executableLines("# never use npx here\nsentry-cli --version")).not.toMatch(
      INSTALL_AND_EXECUTE,
    );
  });

  it("refuses rather than falling back to the network when nothing is installed", () => {
    // A fallback is the failure mode this fix exists to prevent, so the error
    // path has to be a hard exit, and it has to say why.
    expect(scriptSource).toContain("exit 1");
    expect(scriptSource).toMatch(/does NOT fall/u);
  });
});

describe("the uploader executed for real", () => {
  let work = "";
  let bundleDir = "";
  let bundlePath = "";
  let npxMarker = "";
  let run: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "postwave-sourcemaps-"));
    bundleDir = join(work, "dist", "_expo", "static", "js", "ios");
    mkdirSync(bundleDir, { recursive: true });
    bundlePath = join(bundleDir, "index.js");
    writeFileSync(
      bundlePath,
      'console.log("bundle");\n//# sourceMappingURL=index.js.map\n',
    );
    writeFileSync(
      join(bundleDir, "index.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["a.js"],
        names: [],
        mappings: "AAAA",
        sourcesContent: ["console.log('bundle');"],
      }),
    );

    // A `npx` that records the fact it was called and then fails. Under
    // `set -e` a call means the script dies before injecting anything, so
    // either assertion below is enough on its own — together they distinguish
    // "did not shell out" from "shelled out to something inert".
    npxMarker = join(work, "npx-was-invoked");
    const fakeBin = join(work, "bin");
    mkdirSync(fakeBin);
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(fakeNpx, `#!/bin/sh\necho "$@" > "${npxMarker}"\nexit 91\n`);
    chmodSync(fakeNpx, 0o755);

    run = spawnSync("bash", [scriptPath], {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        DIST_DIR: join(work, "dist"),
        POSTWAVE_RELEASE: "supply-chain-test",
        SENTRY_AUTH_TOKEN: "not-a-real-token",
        SENTRY_ORG: "postwave-test",
        SENTRY_PROJECT: "postwave-mobile",
        // Nothing here may reach sentry.io. The upload step fails fast on a
        // refused connection; everything asserted happens before it.
        SENTRY_URL: "http://127.0.0.1:1",
      },
    });
  }, 60_000);

  afterAll(() => {
    if (work) rmSync(work, { force: true, recursive: true });
  });

  it("did not invoke npx", () => {
    expect(
      existsSync(npxMarker),
      `npx was invoked: ${existsSync(npxMarker) ? readFileSync(npxMarker, "utf8") : ""}`,
    ).toBe(false);
  });

  it("ran the exact sentry-cli the lockfile pins", () => {
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(output).toContain(`Using sentry-cli ${pinnedCliVersion}`);
    // Logged, not merely used: months later the only record of which CLI
    // produced a mis-symbolicated release is this line.
    expect(output).toMatch(/at \/.*sentry-cli/u);
  });

  it("got far enough to do real work — the debug id landed in the bundle", () => {
    // Positive proof. A stubbed or missing binary would leave the bundle
    // exactly as written above, and every assertion here would still be
    // technically true about a script that did nothing.
    expect(readFileSync(bundlePath, "utf8")).toMatch(/\/\/# debugId=[0-9a-f-]{36}/u);
  });

  it("stopped at the upload rather than reporting success", () => {
    // The refused connection to the unroutable port must be what ended it —
    // not a silent skip, which would make the debug-id assertion above the
    // only thing standing between this suite and proving nothing.
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(run.status).not.toBe(0);
    expect(output).toContain("Could not connect to server");
    expect(output).not.toContain("Source-map upload complete");
  });
});

/**
 * The resolver the script uses, exercised directly: the shell only ever sees a
 * path, so a broken resolution shows up as "sentry-cli is not installed" long
 * after the reason is visible.
 */
describe("sentry-cli resolution", () => {
  it("finds the CLI through @sentry/react-native's own dependency graph", () => {
    const resolved = execFileSync(
      process.execPath,
      [
        "-e",
        `const { createRequire } = require("node:module");
         const path = require("node:path");
         const fromApp = createRequire(path.join(process.argv[1], "package.json"));
         const fromSdk = createRequire(fromApp.resolve("@sentry/react-native/package.json"));
         process.stdout.write(fromSdk.resolve("@sentry/cli/bin/sentry-cli"));`,
        appRoot,
      ],
      { encoding: "utf8" },
    );
    expect(existsSync(resolved)).toBe(true);
    expect(
      execFileSync(resolved, ["--version"], { encoding: "utf8" }).trim(),
    ).toBe(`sentry-cli ${pinnedCliVersion}`);
  });
});
