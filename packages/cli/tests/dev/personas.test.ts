// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersonas, parsePersonasYaml } from "../../src/dev/personas.js";

describe("personas", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "postwave-personas-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns one default persona when no file is present", () => {
    const list = loadPersonas(dir);
    expect(list).toHaveLength(1);
    expect(list[0]?.email).toContain("@");
  });

  it("parses the documented schema", () => {
    const yaml = `personas:
  - name: VC Marc
    email: marc@example.com
    custom_fields:
      first_name: Marc
      tier: premium
      vip: true
  - name: Free user
    email: free@example.com
    custom_fields:
      first_name: Pat
`;
    const list = parsePersonasYaml(yaml);
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe("VC Marc");
    expect(list[0]?.email).toBe("marc@example.com");
    expect(list[0]?.custom_fields.first_name).toBe("Marc");
    expect(list[0]?.custom_fields.tier).toBe("premium");
    expect(list[0]?.custom_fields.vip).toBe(true);
    expect(list[1]?.email).toBe("free@example.com");
  });

  it("loads personas from a project file", () => {
    const yaml = `personas:
  - name: Test
    email: t@example.com
    custom_fields:
      n: 7
`;
    writeFileSync(join(dir, "postwave.test-personas.yaml"), yaml, "utf8");
    const list = loadPersonas(dir);
    expect(list).toHaveLength(1);
    expect(list[0]?.custom_fields.n).toBe(7);
  });

  it("rejects oversized persona files before parsing", () => {
    const huge = `personas:\n  - name: A\n    email: a@example.com\n    custom_fields:\n      k: ${"x".repeat(70 * 1024)}\n`;
    writeFileSync(join(dir, "postwave.test-personas.yaml"), huge, "utf8");

    expect(() => loadPersonas(dir)).toThrow("too large");
    expect(() => parsePersonasYaml(huge)).toThrow("too large");
  });

  it("rejects unreasonable persona and field counts", () => {
    const tooManyPersonas = `personas:\n${Array.from(
      { length: 101 },
      (_, i) => `  - name: P${i}\n    email: p${i}@example.com`,
    ).join("\n")}\n`;
    expect(() => parsePersonasYaml(tooManyPersonas)).toThrow("more than 100 personas");

    const tooManyFields = `personas:
  - name: A
    email: a@example.com
    custom_fields:
${Array.from({ length: 101 }, (_, i) => `      f${i}: v`).join("\n")}
`;
    expect(() => parsePersonasYaml(tooManyFields)).toThrow("too many custom fields");
  });

  it("caps very long scalar values", () => {
    const yaml = `personas:
  - name: ${"x".repeat(5_000)}
    email: a@example.com
    custom_fields:
      note: ${"y".repeat(5_000)}
`;
    const list = parsePersonasYaml(yaml);
    expect(list[0]?.name.length).toBe(4_096);
    expect(String(list[0]?.custom_fields.note).length).toBe(4_096);
  });

  it("ignores comments and blank lines", () => {
    const yaml = `# top comment
personas:
  # the first one
  - name: A
    email: a@example.com
    custom_fields:
      k: v # trailing
`;
    const list = parsePersonasYaml(yaml);
    expect(list).toHaveLength(1);
    expect(list[0]?.custom_fields.k).toBe("v");
  });
});
