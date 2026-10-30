import { describe, expect, it } from "vitest";

import {
  MCP_CATALOG_INVALID_ENTRY,
  MCP_CATALOG_MALFORMED,
  MCP_CATALOG_MAX_SEARCH_CHARS,
  MCP_CATALOG_MAX_TOOLS,
  filterMcpCatalog,
  groupMcpCatalog,
  mcpCatalogCategories,
  mcpCatalogResultSentence,
  mcpCatalogSearchTerm,
  normalizeMcpCatalog,
} from "@/lib/mcpCatalog";

/**
 * The catalogue is a static document, but its identifiers are rendered as
 * exact tokens and copied to the clipboard, so these tests are written from
 * the leaking side: a bad row must refuse the WHOLE response (a partial list
 * reads as complete), and the search must never widen past what it says.
 */

function wire() {
  return [
    { name: "subscribers_list", category: "subscribers", description: "List subscribers." },
    { name: "campaign_send", category: "campaigns", description: "Send a campaign now." },
    { name: "campaign_create", category: "campaigns", description: "Create a draft campaign." },
    { name: "migrate_start", category: "migration", description: "Begin OAuth authorization." },
  ];
}

describe("normalizeMcpCatalog", () => {
  it("sorts by category then name and trims descriptions", () => {
    const parsed = normalizeMcpCatalog([
      ...wire(),
      { name: "z_tool", category: "campaigns", description: "  padded  " },
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.entries?.map((entry) => entry.name)).toEqual([
      "campaign_create",
      "campaign_send",
      "z_tool",
      "migrate_start",
      "subscribers_list",
    ]);
    expect(parsed.entries?.[2]?.description).toBe("padded");
  });

  it("refuses the whole response on one invalid entry", () => {
    const bad: unknown[] = [
      { name: "", category: "c", description: "d" },
      { name: "_x", category: "c", description: "d" },
      { name: "pw_live_abcdef123456", category: "c", description: "d" },
      { name: "ok", category: "", description: "d" },
      { name: "ok", category: " padded", description: "d" },
      { name: "ok", category: "c\u200b", description: "d" },
      { name: "ok", category: "c", description: "" },
      { name: "ok", category: "c", description: "d\u202e" },
      { name: "ok", category: "c", description: "d".repeat(2_001) },
      "string",
    ];
    for (const entry of bad) {
      expect(normalizeMcpCatalog([...wire(), entry])).toEqual({
        entries: null,
        error: MCP_CATALOG_INVALID_ENTRY,
      });
    }
  });

  it("refuses a duplicated identifier", () => {
    expect(normalizeMcpCatalog([...wire(), wire()[0]]).error).toBe(
      MCP_CATALOG_INVALID_ENTRY,
    );
  });

  it("refuses a non-array or an oversize payload rather than paging it", () => {
    expect(normalizeMcpCatalog({ tools: [] })).toEqual({
      entries: null,
      error: MCP_CATALOG_MALFORMED,
    });
    const huge = Array.from({ length: MCP_CATALOG_MAX_TOOLS + 1 }, (_, i) => ({
      name: `t${i}`,
      category: "c",
      description: "d",
    }));
    expect(normalizeMcpCatalog(huge).error).toBe(MCP_CATALOG_MALFORMED);
  });

  it("accepts an empty list as a real answer", () => {
    expect(normalizeMcpCatalog([])).toEqual({ entries: [], error: null });
  });
});

describe("search and filter", () => {
  const entries = normalizeMcpCatalog(wire()).entries!;

  it("bounds and lower-cases the term", () => {
    expect(mcpCatalogSearchTerm("  Send ")).toBe("send");
    expect(mcpCatalogSearchTerm("a".repeat(MCP_CATALOG_MAX_SEARCH_CHARS + 50))).toHaveLength(
      MCP_CATALOG_MAX_SEARCH_CHARS,
    );
  });

  it("matches case-insensitively over name, description and category", () => {
    expect(filterMcpCatalog(entries, "SEND", "").map((e) => e.name)).toEqual([
      "campaign_send",
    ]);
    expect(filterMcpCatalog(entries, "oauth", "").map((e) => e.name)).toEqual([
      "migrate_start",
    ]);
    expect(filterMcpCatalog(entries, "migr", "").map((e) => e.name)).toEqual([
      "migrate_start",
    ]);
  });

  it("intersects the category filter with the search", () => {
    expect(filterMcpCatalog(entries, "", "campaigns")).toHaveLength(2);
    expect(filterMcpCatalog(entries, "create", "campaigns").map((e) => e.name)).toEqual([
      "campaign_create",
    ]);
    expect(filterMcpCatalog(entries, "create", "subscribers")).toEqual([]);
  });

  it("returns everything for an empty term and empty category", () => {
    expect(filterMcpCatalog(entries, "   ", "")).toHaveLength(4);
  });

  it("counts categories in sorted order", () => {
    expect(mcpCatalogCategories(entries)).toEqual([
      { category: "campaigns", count: 2 },
      { category: "migration", count: 1 },
      { category: "subscribers", count: 1 },
    ]);
  });

  it("groups only the first `limit` rows, in list order", () => {
    const grouped = groupMcpCatalog(entries, 3);
    expect(grouped.map(([category, rows]) => [category, rows.length])).toEqual([
      ["campaigns", 2],
      ["migration", 1],
    ]);
    expect(groupMcpCatalog(entries, 0)).toEqual([]);
    expect(groupMcpCatalog(entries, -1)).toEqual([]);
  });

  it("words the result sentence by whether a filter is active", () => {
    expect(mcpCatalogResultSentence(289, 289, 31, false)).toBe(
      "289 tools across 31 categories.",
    );
    expect(mcpCatalogResultSentence(289, 4, 31, true)).toBe(
      "4 of 289 tools match the active filters.",
    );
  });
});
