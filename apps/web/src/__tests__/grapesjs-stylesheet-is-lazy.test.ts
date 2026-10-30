// SPDX-License-Identifier: AGPL-3.0-only
//
// GrapesJS' stylesheet (57 KB raw / 12 KB gzip, 1,012 selectors plus a bundled
// CodeMirror theme) used to be imported by the sequence-editor route LAYOUT.
// A layout-level CSS import becomes an eager <link> in that route's document,
// so every visit to /app/sequences/[id] blocked first paint on styles for an
// editor mode most sessions never open — and the OTHER route that mounts the
// same editor (/app/templates/[id]/edit, through EditorShell) never got the
// stylesheet at all, so its Blocks tab rendered unstyled.
//
// Owning the import inside block-editor.tsx fixes both at once: the module is
// only reachable through `dynamic(() => import("./block-editor"))`, so the CSS
// travels in that async chunk and arrives exactly when the editor mounts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");
const CSS_IMPORT = 'import "grapesjs/dist/css/grapes.min.css";';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("grapesjs stylesheet ownership", () => {
  // This file names the import string too; it is not shipped code.
  const files = walk(SRC).filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));

  it("is imported by the block editor itself", () => {
    const source = readFileSync(
      path.join(SRC, "components/editor/block-editor.tsx"),
      "utf8",
    );
    expect(source).toContain(CSS_IMPORT);
  });

  it("is imported nowhere else — a layout or page import makes it eager", () => {
    const importers = files
      .filter((file) => readFileSync(file, "utf8").includes(CSS_IMPORT))
      .map((file) => path.relative(SRC, file));

    expect(importers).toEqual(["components/editor/block-editor.tsx"]);
  });

  it("reaches the block editor only through a dynamic import", () => {
    const shell = readFileSync(
      path.join(SRC, "components/editor/editor-shell.tsx"),
      "utf8",
    );
    expect(shell).toContain('import("./block-editor")');
    expect(shell).not.toMatch(/^import .*from "\.\/block-editor";$/m);
  });
});
