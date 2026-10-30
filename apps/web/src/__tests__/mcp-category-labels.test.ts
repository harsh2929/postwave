// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import toolsData from "@/lib/mcp-tools.json";
import { MCP_CATEGORY_LABELS } from "@/lib/mcp-category-labels";

interface ToolEntry {
  name: string;
  category: string;
  description: string;
}

const categories = Array.from(
  new Set((toolsData as ToolEntry[]).map((t) => t.category)),
);

describe("MCP category labels", () => {
  it("has a human label for every category present in mcp-tools.json", () => {
    const missing = categories.filter(
      (c) => !MCP_CATEGORY_LABELS[c] || MCP_CATEGORY_LABELS[c]?.trim() === "",
    );
    expect(missing).toEqual([]);
  });

  it("renders no raw kebab-case slug as a heading (labels have no hyphen-slug leakage)", () => {
    for (const c of categories) {
      const label = MCP_CATEGORY_LABELS[c];
      // A label that is byte-identical to a hyphenated slug means the heading
      // would still read as a machine slug (e.g. "developer-marketplace").
      if (c.includes("-")) {
        expect(label).not.toBe(c);
      }
    }
  });

  it("contains no dead label keys that map to no real category", () => {
    const real = new Set(categories);
    const dead = Object.keys(MCP_CATEGORY_LABELS).filter((k) => !real.has(k));
    expect(dead).toEqual([]);
  });
});
