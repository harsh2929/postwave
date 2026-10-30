// SPDX-License-Identifier: AGPL-3.0-only
//
// /docs/changelog lists per-package release notes.
//
// It labelled each section `@postwave/${directory}`, but the directory and the
// published package name differ for two of the nine: packages/sdk-ts publishes
// as @postwave/sdk, and packages/vscode-extension as postwave-vscode. Both
// rendered as install targets that do not exist.
//
// It also read the files with fs at request time, and the standalone release
// image carries no packages/ tree: production rendered "No CHANGELOG.md files
// found." The notes are now bundled at build time
// (lib/docs/package-changelogs), and these tests read what the page renders —
// not the page's source — against the files in the repository.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ChangelogPage from "@/app/(docs)/docs/changelog/page";
import {
  MAX_CHANGELOG_BYTES,
  packageChangelogs,
} from "@/lib/docs/package-changelogs";

const REPO = resolve(process.cwd(), "../..");

describe("docs changelog package notes", () => {
  const entries = packageChangelogs();

  it("enumerates packages", () => {
    // Guard the guard: an empty list would make everything below vacuous.
    expect(entries.length).toBeGreaterThan(5);
  });

  it("renders the text of each package's CHANGELOG.md, not a copy of it", () => {
    for (const entry of entries) {
      const file = join(REPO, "packages", entry.directory, "CHANGELOG.md");
      expect(existsSync(file), entry.directory).toBe(true);
      expect(entry.body, entry.directory).toBe(readFileSync(file, "utf8"));
      expect(entry.body.length, entry.directory).toBeGreaterThan(0);
    }
  });

  it("labels each package with the name it is published under", () => {
    for (const entry of entries) {
      const manifest = join(REPO, "packages", entry.directory, "package.json");
      const want = existsSync(manifest)
        ? (JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name
        : `@postwave/${entry.directory}`; // Go module — brand-name fallback
      expect(entry.name, entry.directory).toBe(want);
    }
    const byDirectory = new Map(entries.map((entry) => [entry.directory, entry.name]));
    expect(byDirectory.get("sdk-ts")).toBe("@postwave/sdk");
    expect(byDirectory.get("vscode-extension")).toBe("postwave-vscode");
  });

  it("publishes every package that has release notes", () => {
    // Deliberately an equality, not a subset: publishing release notes is a
    // decision, so a package that gains a CHANGELOG.md should fail here and be
    // added on purpose rather than appear automatically.
    const withNotes = readdirSync(join(REPO, "packages"))
      .filter((dir) => {
        const p = join(REPO, "packages", dir);
        return statSync(p).isDirectory() && existsSync(join(p, "CHANGELOG.md"));
      })
      .sort();
    expect(withNotes.length).toBeGreaterThan(5); // guard the guard
    expect(entries.map((entry) => entry.directory).sort()).toEqual(withNotes);
  });

  it("keeps every package's notes small enough to bundle", () => {
    for (const entry of entries) {
      expect(
        Buffer.byteLength(entry.body, "utf8"),
        entry.directory,
      ).toBeLessThanOrEqual(MAX_CHANGELOG_BYTES);
    }
  });

  it("renders every package's notes on a server with no packages/ tree", () => {
    // The standalone image runs the server from a directory with no packages/
    // tree above it. Render the page from such a directory: the notes must come
    // from the build, not from the filesystem around the running server.
    const standalone = mkdtempSync(join(tmpdir(), "docs-changelog-standalone-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(standalone);
    try {
      const html = renderToStaticMarkup(ChangelogPage());
      expect(html).not.toContain("No CHANGELOG.md files found.");
      for (const entry of entries) {
        expect(html, entry.directory).toContain(`>${entry.name}</h2>`);
      }
      // Every release heading in the files on disk, rendered as markdown (the
      // page nests each `## ` release under the package's own heading).
      const releases = entries
        .map((entry) =>
          readFileSync(join(REPO, "packages", entry.directory, "CHANGELOG.md"), "utf8"),
        )
        .reduce((sum, text) => sum + (text.match(/^## /gm)?.length ?? 0), 0);
      expect(releases).toBeGreaterThan(entries.length); // guard the guard
      expect(html.match(/<h3>/g)?.length ?? 0).toBe(releases);
    } finally {
      cwd.mockRestore();
      rmSync(standalone, { recursive: true, force: true });
    }
  });

  it("gives every section a distinct anchor", () => {
    // The page uses id={name.replace(/[@/]/g, "-")}; two sections sharing an
    // id would leave one unreachable by anchor.
    const ids = entries.map((entry) => entry.name.replace(/[@/]/g, "-"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
