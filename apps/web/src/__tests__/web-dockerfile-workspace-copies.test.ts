// SPDX-License-Identifier: AGPL-3.0-only
//
// The web image copies workspace packages by hand, in two places: package.json
// files before `pnpm install`, and sources before `next build`. When the web
// app gains a workspace dependency (directly or through another package) and
// the Dockerfile is not updated, the container build fails with "Module not
// found" while the regular CI build, which has the whole repository, passes.
// That happened with @postwave/ai-disclosure, errors, offline-outbox and
// step-up. This test derives the web app's workspace closure and requires both
// copies for every package in it.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");

type PackageJson = { name?: string } & Record<string, Record<string, string> | string | undefined>;

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

function workspacePackages(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const parent of ["packages", "apps"]) {
    for (const entry of readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(repoRoot, parent, entry.name, "package.json");
      if (!existsSync(file)) continue;
      const name = readJson(file).name;
      if (typeof name === "string") byName.set(name, `${parent}/${entry.name}`);
    }
  }
  return byName;
}

function workspaceDeps(dir: string, byName: Map<string, string>): string[] {
  const pkg = readJson(path.join(repoRoot, dir, "package.json"));
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[section];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) if (byName.has(name)) names.add(name);
    }
  }
  return [...names];
}

describe("apps/web/Dockerfile copies every workspace package the web app builds from", () => {
  const byName = workspacePackages();
  const closure = new Set<string>();
  const queue = ["@postwave/web"];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dep of workspaceDeps(byName.get(current) as string, byName)) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }
  const dirs = [...closure].map((name) => byName.get(name) as string).filter((dir) => dir.startsWith("packages/")).sort();
  const dockerfile = readFileSync(path.join(repoRoot, "apps/web/Dockerfile"), "utf8");
  const lines = new Set(dockerfile.split("\n").map((line) => line.trim()));

  it("finds the web app's workspace dependencies", () => {
    expect(dirs).toContain("packages/ai-disclosure");
    expect(dirs.length).toBeGreaterThan(5);
  });

  it.each(dirs)("%s: package.json before install and sources before build", (dir) => {
    expect(lines.has(`COPY ${dir}/package.json ${dir}/package.json`)).toBe(true);
    expect(lines.has(`COPY ${dir} ${dir}`)).toBe(true);
  });
});
