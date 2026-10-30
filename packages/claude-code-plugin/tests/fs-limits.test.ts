// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readUtf8FileLimited } from "../src/fs-limits.js";

describe("readUtf8FileLimited", () => {
  it("reads files within the configured byte limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "postwave-cc-fs-"));
    try {
      const path = join(dir, "CLAUDE.md");
      writeFileSync(path, "hello", "utf8");

      expect(readUtf8FileLimited(path, 8)).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses UTF-8 bytes instead of character count", () => {
    const dir = mkdtempSync(join(tmpdir(), "postwave-cc-fs-"));
    try {
      const path = join(dir, "CLAUDE.md");
      writeFileSync(path, "ééé", "utf8");

      expect(() => readUtf8FileLimited(path, 3)).toThrow("too large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
