// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace packages that publish `./dist/*` are consumed as BUILD ARTIFACTS.
// Every app resolves the compiled file, never the TypeScript source. So editing
// src without rebuilding changes nothing that runs — and nothing says so.
//
// This is not a hypothetical failure mode; it has happened twice in this
// codebase, both times silently:
//
//   - @postwave/errors: a parity test validated dist while a source-only edit
//     sat unbuilt, so the test passed against code that was never shipped.
//   - Three packages at once — @postwave/mcp-server (an SSRF fix folding
//     ::ffff:a.b.c.d to IPv4), @postwave/cli (confirmation gating on three
//     destructive commands), and @postwave/query-contract — all carried fixes
//     in src only. The security fixes were real, reviewed, tested, and not in
//     the artifact anybody actually ran.
//
// What makes it invisible is that the package's OWN tests import from src and
// pass, while consumers import dist and get the old behaviour. Both sides look
// healthy. Only comparing them reveals the gap.
//
// FIXING A FAILURE: run `npm run build` in the named package (or the workspace
// build). This test does not check that dist is CORRECT, only that it is not
// older than the source it was built from — the cheap check that catches the
// forgotten rebuild.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

interface Pkg {
  name: string;
  dir: string;
  src: string;
  dist: string;
}

/** Packages whose published entrypoint is a build artifact. */
function distPublishingPackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const group of ["packages", "apps"]) {
    const root = join(REPO, group);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;

      let manifest: { name?: string; main?: string; exports?: unknown };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        continue;
      }
      const entrypoints = `${manifest.main ?? ""}${JSON.stringify(manifest.exports ?? {})}`;
      if (!entrypoints.includes("dist")) continue;

      const src = join(dir, "src");
      const dist = join(dir, "dist");
      // A package that has never been built has no stale artifact to ship.
      // Consumers fail loudly on a missing module, which is the good failure.
      if (!existsSync(src) || !existsSync(dist)) continue;

      out.push({ name: manifest.name ?? entry.name, dir, src, dist });
    }
  }
  return out;
}

/** Newest mtime under `root` among files with these extensions. */
function newestMtime(root: string, exts: readonly string[]): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(abs);
        continue;
      }
      if (!exts.some((e) => entry.name.endsWith(e))) continue;
      // Tests are not compiled into dist, so they must not count as staleness.
      if (/\.(test|spec)\.[cm]?[tj]sx?$/.test(entry.name)) continue;
      const mtime = statSync(abs).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  };
  walk(root);
  return newest;
}

describe("published dist is not behind src", () => {
  const packages = distPublishingPackages();

  it("finds the workspace packages that ship a build artifact", () => {
    // Guard the guard: a walk that finds nothing reports every package healthy.
    // These three are known dist-publishers and each has shipped a stale
    // artifact before, so their absence means the discovery is broken.
    const names = packages.map((p) => p.name);
    expect(names.length).toBeGreaterThan(3);
    for (const required of [
      "@postwave/offline-outbox",
      "@postwave/mcp-server",
      "@postwave/cli",
    ]) {
      expect(names, `${required} publishes dist and must be discovered`).toContain(
        required,
      );
    }
  });

  it("has no package whose source is newer than its build output", () => {
    // One second of slack: some tools copy files with coarse timestamps, and a
    // sub-second difference is not evidence of a forgotten rebuild.
    const SLACK_MS = 1000;

    const stale = packages
      .map((pkg) => {
        const srcAt = newestMtime(pkg.src, [".ts", ".tsx"]);
        const distAt = newestMtime(pkg.dist, [".js", ".mjs", ".cjs"]);
        return { pkg, srcAt, distAt };
      })
      .filter(({ srcAt, distAt }) => srcAt > distAt + SLACK_MS)
      .map(
        ({ pkg, srcAt, distAt }) =>
          `${pkg.name}: src is ${Math.round((srcAt - distAt) / 60000)} min newer than dist ` +
          `— run \`npm run build\` in ${relative(REPO, pkg.dir)}`,
      );

    expect(
      stale,
      "these packages would ship code that does not match their source",
    ).toEqual([]);
  });
});
