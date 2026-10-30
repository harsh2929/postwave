import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { countSourceLines } from "./source-size-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const SRC_DIR = join(PROJECT_DIR, "src");
const ENTRY_PATH = join(SRC_DIR, "styles.css");
const STYLES_DIR = join(SRC_DIR, "styles");
const MAIN_PATH = join(SRC_DIR, "main.tsx");

const PRE_SPLIT_IMPORTS = [
  "./styles/foundation.css",
  "./styles/shell-components.css",
  "./styles/shared-overlays.css",
  "./styles/content-surfaces.css",
  "./styles/auth.css",
  "./styles/collaboration-tour.css",
];

// New product foundations are appended deliberately so they can evolve
// without invalidating the immutable byte-for-byte proof for the mechanical
// six-file split above. This list still makes cascade order and completeness
// explicit; unreviewed imports or orphaned CSS files fail the contract.
const EXTENSION_IMPORTS = [
  "./styles/lookalike-workflow.css",
  "./styles/auth-showcase.css",
  "./styles/desktop-diagnostics.css",
  "./styles/desktop-shortcuts.css",
  "./styles/chart-accessibility.css",
  "./styles/data-table.css",
  "./styles/large-data.css",
  "./styles/design-system.css",
  "./styles/contextual-help.css",
  "./styles/overlay-layers.css",
  "./styles/subscriber-addresses.css",
  "./styles/subscriber-status-consent.css",
];

const EXPECTED_IMPORTS = [...PRE_SPLIT_IMPORTS, ...EXTENSION_IMPORTS];

// Reviewed base-cascade hash after the mechanical split. Feature foundations
// live in EXTENSION_IMPORTS, so their normal evolution does not silently
// rewrite this baseline. Intentional edits to the six base layers require an
// explicit hash review here.
const BASE_CONTENT_SHA256 =
  "64184ecc1e4068d33e9f367b16340e326089ed9ab15475710e3a4a3d002d6de5";

function readEntryImports() {
  const entry = readFileSync(ENTRY_PATH, "utf8");
  assert.ok(entry.endsWith("\n"), "styles.css must end with a newline");
  return entry
    .trimEnd()
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const match = /^@import "([^"\r\n]+)";$/.exec(line);
      assert.ok(match, `styles.css contains a non-import line: ${line}`);
      return match[1];
    });
}

describe("desktop global stylesheet entry contract", () => {
  it("keeps one complete, unique, and ordered module import sequence", () => {
    const imports = readEntryImports();
    assert.deepEqual(imports, EXPECTED_IMPORTS);
    assert.equal(new Set(imports).size, imports.length);

    const importedBasenames = imports
      .map((entry) => entry.replace("./styles/", ""))
      .sort();
    const splitSources = readdirSync(STYLES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(splitSources, importedBasenames);
  });

  it("keeps every split source under the default line limit", () => {
    for (const importPath of readEntryImports()) {
      const source = readFileSync(
        join(SRC_DIR, importPath.replace(/^\.\//, "")),
        "utf8",
      );
      assert.ok(
        countSourceLines(source) <= 2_000,
        `${importPath} exceeds the 2,000-line default`,
      );
      assert.doesNotMatch(source, /^@import\s/m);
    }
  });

  it("keeps the reviewed base rule bytes in cascade order", () => {
    const concatenated = PRE_SPLIT_IMPORTS.map((importPath) =>
      readFileSync(join(SRC_DIR, importPath.replace(/^\.\//, "")), "utf8"),
    ).join("");
    const hash = createHash("sha256").update(concatenated).digest("hex");
    assert.equal(hash, BASE_CONTENT_SHA256);
  });

  it("keeps both production screen-reader-only class names layout-hidden", () => {
    const foundation = readFileSync(join(STYLES_DIR, "foundation.css"), "utf8");
    assert.match(foundation, /\.sr-only,\s*\.visually-hidden\s*\{/);
    assert.match(foundation, /clip-path:\s*inset\(50%\)\s*!important/);
    assert.match(foundation, /white-space:\s*nowrap\s*!important/);
  });

  it("keeps styles.css as the single application entry import", () => {
    const main = readFileSync(MAIN_PATH, "utf8");
    assert.equal(main.match(/^import "\.\/styles\.css";$/gm)?.length, 1);
    for (const importPath of EXPECTED_IMPORTS) {
      assert.doesNotMatch(main, new RegExp(importPath.replaceAll(".", "\\.")));
    }
  });
});
