// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJsonObject,
  readTextFileLimited,
} from "../../src/lib/input.js";

describe("CLI input helpers", () => {
  it("reads text files within the configured byte limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "postwave-cli-input-"));
    try {
      const path = join(dir, "payload.json");
      writeFileSync(path, '{"ok":true}', "utf8");
      expect(readTextFileLimited(path, 64)).toBe('{"ok":true}');
      expect(() => readTextFileLimited(path, 4)).toThrow("too large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses only JSON objects", () => {
    expect(parseJsonObject('{"ok":true}', "spec")).toEqual({ ok: true });
    expect(() => parseJsonObject("[1,2]", "spec")).toThrow("must be an object");
    expect(() => parseJsonObject("{bad", "spec")).toThrow("Failed to parse spec JSON");
  });

  it("enforces JSON byte, depth, key, and string limits", () => {
    expect(() => parseJsonObject('{"ok":"é"}', "spec", { maxBytes: 10 })).toThrow(
      "too large",
    );
    expect(() => parseJsonObject('{"a":{"b":true}}', "spec", { maxDepth: 2 })).toThrow(
      "maximum depth",
    );
    expect(() => parseJsonObject('{"a":1,"b":2}', "spec", { maxKeys: 1 })).toThrow(
      "object keys",
    );
    expect(() =>
      parseJsonObject('{"a":"abcdef"}', "spec", { maxStringChars: 3 }),
    ).toThrow("string longer");
  });
});
