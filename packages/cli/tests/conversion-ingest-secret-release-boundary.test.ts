// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(__dirname, "../src");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("conversion signing-key CLI release boundary", () => {
  it("has no command or raw route capable of minting/retrying a reveal-once key", () => {
    const files = sourceFiles(SOURCE_ROOT);
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

    // The SDK deliberately exposes issuance to an admin program, but a CLI
    // command would make terminal history/log capture and habitual retry much
    // too easy. A future CLI design needs an explicit reveal/discard ceremony;
    // until then it must not call the SDK method or bypass it with the raw path.
    expect(files.length).toBeGreaterThan(20);
    expect(source).not.toMatch(/conversionIngestSecrets\s*\.\s*issue/u);
    expect(source).not.toContain("/api/v1/conversions/ingest-secrets");
    expect(source).not.toMatch(/issueConversionIngestSecret/u);
  });
});
