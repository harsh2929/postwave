import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../", import.meta.url).pathname;

function productionSources(directory = SOURCE_ROOT): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = relative(SOURCE_ROOT, path);
    if (
      rel.startsWith("__tests__/") ||
      rel.includes("/stories/") ||
      /\.stories\.[jt]sx?$/.test(rel)
    ) {
      continue;
    }
    if (statSync(path).isDirectory()) files.push(...productionSources(path));
    else if (/\.[jt]sx?$/.test(path)) files.push(path);
  }
  return files;
}

function offenders(pattern: RegExp, allow: readonly string[] = []): string[] {
  return productionSources()
    .filter((path) => !allow.some((suffix) => path.endsWith(suffix)))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SOURCE_ROOT, path));
}

describe("central file-transfer source boundary", () => {
  it("owns every renderer save, picker, FileReader, and external-target primitive", () => {
    expect(
      offenders(/URL\.createObjectURL\s*\(/, [
        "lib/file-transfer.ts",
        "lib/asset-display.ts",
      ]),
    ).toEqual([]);
    expect(offenders(/\.download\s*=/, ["lib/file-transfer.ts"])).toEqual([]);
    expect(offenders(/type=["']file["']/)).toEqual([]);
    expect(offenders(/new\s+FileReader\s*\(/)).toEqual([]);
    expect(
      offenders(/target=["']_blank["']/, ["components/ExternalLink.tsx"]),
    ).toEqual([]);
  });

  it("grants picker-scoped read/stat only and keeps writes in guarded Rust", () => {
    const capability = JSON.parse(
      readFileSync(
        new URL("../../src-tauri/capabilities/main.json", import.meta.url),
        "utf8",
      ),
    ) as { permissions: Array<string | { identifier: string }> };
    const permissionIds = capability.permissions.map((permission) =>
      typeof permission === "string" ? permission : permission.identifier,
    );
    expect(permissionIds).toContain("dialog:allow-open");
    expect(permissionIds).toContain("dialog:allow-save");
    expect(permissionIds).toContain("fs:allow-read-file");
    expect(permissionIds).toContain("fs:allow-stat");
    expect(permissionIds.some((id) => id.includes("fs:allow-write"))).toBe(
      false,
    );

    const rust = readFileSync(
      new URL("../../src-tauri/src/file_transfer.rs", import.meta.url),
      "utf8",
    );
    expect(rust).toContain("ensure_main_bundled_window");
    expect(rust).toContain("fs_scope().is_allowed");
    expect(rust).toContain("create_new(true)");
    expect(rust).toContain("replace_file_atomically");
    expect(rust).toContain("forbid_file");
    expect(rust).toContain("getrandom::fill");
    expect(rust).toContain("cleanup_stale");
  });
});
