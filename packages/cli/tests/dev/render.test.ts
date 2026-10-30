// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderEmailFile } from "../../src/dev/render.js";

describe("renderEmailFile", () => {
  it("rejects oversized source files before loading the renderer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "postwave-render-"));
    try {
      const path = join(dir, "huge.mjml");
      writeFileSync(path, "x".repeat(2 * 1024 * 1024 + 1), "utf8");

      await expect(renderEmailFile(path)).rejects.toThrow("Email source is too large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
