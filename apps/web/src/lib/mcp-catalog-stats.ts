// SPDX-License-Identifier: AGPL-3.0-only
import toolsData from "@/lib/mcp-tools.json";

export const MCP_TOOL_COUNT = toolsData.length;
export const MCP_CATEGORY_COUNT = new Set(
  toolsData.map((tool) => tool.category),
).size;

/**
 * How many catalog tools fall in the given category slugs.
 *
 * /forge published a per-category breakdown as nineteen hardcoded numbers
 * under a heading that already derived the totals from this same file. Seven
 * had drifted — campaigns read 13 against 44, migration 6 against 23, admin 10
 * against 22 — so the headline was right and every line under it was not.
 *
 * Takes a list because some rows are deliberate groupings ("commerce reads" is
 * discounts + gift-subscriptions) and some are display renames ("domains" is
 * custom-domains). Throws on an unknown slug: a row silently counting zero
 * would restore the original failure in a quieter form.
 */
export function mcpToolsInCategories(slugs: readonly string[]): number {
  const known = new Set(toolsData.map((tool) => tool.category));
  const missing = slugs.filter((slug) => !known.has(slug));
  if (missing.length > 0) {
    throw new Error(`mcp-catalog-stats: unknown category ${missing.join(", ")}`);
  }
  return toolsData.filter((tool) => slugs.includes(tool.category)).length;
}

/**
 * Size of the in-app agent-native tool registry — a different, governed surface
 * from the MCP catalog above.
 *
 * It cannot be derived here: the source of truth is
 * apps/api/internal/agenttools/native_manifest.json, outside this app's build.
 * So it lives here as the single literal, checked against that manifest by
 * __tests__/tool-catalog-claims.test.ts. It was previously written out
 * separately on /developers (prose), /mcp (a constant), and in the developer
 * product shot (a data row) — each fixed one at a time, because each guard was
 * shaped to the copy in front of it.
 */
export const NATIVE_TOOL_COUNT = 60;

/**
 * A few real tool names from the given categories, for "e.g." copy.
 *
 * /forge hand-wrote these: 25 of its 53 example names were wrong, 18 of which
 * named no tool at all (campaign_pause, inbox_predict, migrate_mailchimp,
 * approval_request, sandbox_session_start …) and 7 more sat in a different
 * category than the card claiming them. Unlike the counts beside them, these
 * ARE rendered, so every card showed a reader tool names they could not call.
 *
 * Sorted for determinism — being real matters more than being interesting,
 * and derived names cannot drift out of the catalog again.
 */
export function mcpExampleTools(
  slugs: readonly string[],
  limit = 4,
): string[] {
  const names = toolsData
    .filter((tool) => slugs.includes(tool.category))
    .map((tool) => tool.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`mcp-catalog-stats: no tools for ${slugs.join(", ")}`);
  }
  return names.slice(0, limit);
}
