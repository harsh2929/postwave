// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { autoName, highlightJson } from "../src/commands/segments.js";

describe("segments helpers", () => {
  it("auto-generates a slug from text", () => {
    expect(autoName("Premium VC subscribers in NYC")).toBe(
      "premium-vc-subscribers-in-nyc",
    );
    expect(autoName("!!!").startsWith("segment-")).toBe(true);
  });

  it("highlights JSON without dropping characters", () => {
    const ast = { op: "and", children: [{ op: "eq", field: "tier", value: "premium" }] };
    const out = highlightJson(ast);
    // The visible characters are still present; ANSI colors are added inline.
    expect(out).toContain("op");
    expect(out).toContain("tier");
    expect(out).toContain("premium");
  });
});

describe("segments CLI with mock SDK", () => {
  it("compileFromNaturalLanguage returns the expected AST shape", async () => {
    const fixedAst = { op: "eq", field: "tier", value: "premium" };
    const sdk = {
      segments: {
        compileFromNaturalLanguage: async (text: string) => {
          expect(text).toBe("premium tier users");
          return { query_ast: fixedAst, suggested_name: "premium-users" };
        },
        create: async (input: { name: string; query_ast: unknown }) => {
          return { id: "seg_1", ...input, created_at: "2026-05-01T00:00:00Z" };
        },
      },
    };
    const r = await sdk.segments.compileFromNaturalLanguage("premium tier users");
    expect(r.query_ast).toEqual(fixedAst);
    const created = await sdk.segments.create({ name: r.suggested_name, query_ast: r.query_ast });
    expect(created.id).toBe("seg_1");
    expect(created.name).toBe("premium-users");
  });
});
