/**
 * lib/mcpCatalog.ts — the server-bundled MCP tool catalogue, validated and
 * searched.
 *
 * WHAT THE PAYLOAD IS. `GET /api/v1/mcp/catalog` writes the bytes of a JSON
 * file embedded into the API binary at build time
 * (apps/api/internal/apikeycalls/handlers.go: `//go:embed tool-catalog.json`,
 * `GetCatalog`). It is an array of `{name, category, description}` and nothing
 * else. The handler's own comment is the whole caveat: it is a CANDIDATE
 * snapshot — "no equality is guaranteed with an installed @postwave/mcp-server
 * registry artifact, a running proxy, or the independent native Go registry".
 * Presence in this list is build evidence, not proof that an installed client
 * can discover or execute the tool, and not authorization.
 *
 * WHY VALIDATE A STATIC FILE. The desktop's McpToolCatalog refuses the whole
 * response when any entry is malformed, oversize, duplicated, or carries
 * control / bidi / zero-width characters — because these identifiers are
 * rendered as `code` and copied to the clipboard as exact tokens, and an
 * invisible character inside one would produce a token that LOOKS right and
 * never matches. The same rules apply here, ported one for one.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export interface McpCatalogEntry {
  name: string;
  category: string;
  description: string;
}

/** Desktop's ceiling; a larger payload is treated as malformed, not paged. */
export const MCP_CATALOG_MAX_TOOLS = 2_000;

/**
 * Rows revealed per "Show more". Desktop pages at 200; a phone reading a
 * 289-tool list at arm's length gets a page it can actually finish.
 */
export const MCP_CATALOG_PAGE_SIZE = 40;

export const MCP_CATALOG_MAX_SEARCH_CHARS = 256;

/** Control, DEL/C1, zero-width, bidi-override and BOM characters. */
const UNSAFE_CATALOGUE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

/** Same grammar the desktop's `safeMcpToolName` accepts. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

const SECRET_MATERIAL =
  /(?:pw_[A-Za-z0-9_-]{6,}|Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|[^\s@]+@[^\s@]+\.[^\s@]+)/iu;

export const MCP_CATALOG_MALFORMED = "The tool catalogue was malformed.";
export const MCP_CATALOG_INVALID_ENTRY =
  "The tool catalogue contained an invalid entry.";

export type McpCatalogParse =
  | { entries: McpCatalogEntry[]; error: null }
  | { entries: null; error: string };

function validEntry(value: unknown): value is McpCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const { name, category, description } = entry;
  return (
    typeof name === "string" &&
    TOOL_NAME.test(name) &&
    !SECRET_MATERIAL.test(name) &&
    typeof category === "string" &&
    category.trim() !== "" &&
    category.trim() === category &&
    category.length <= 128 &&
    !UNSAFE_CATALOGUE_TEXT.test(category) &&
    typeof description === "string" &&
    description.trim() !== "" &&
    description.length <= 2_000 &&
    !UNSAFE_CATALOGUE_TEXT.test(description)
  );
}

/**
 * The whole response is accepted or the whole response is refused. A partial
 * catalogue that silently dropped the bad rows would read as complete.
 */
export function normalizeMcpCatalog(raw: unknown): McpCatalogParse {
  if (!Array.isArray(raw) || raw.length > MCP_CATALOG_MAX_TOOLS) {
    return { entries: null, error: MCP_CATALOG_MALFORMED };
  }
  const seen = new Set<string>();
  const entries: McpCatalogEntry[] = [];
  for (const value of raw) {
    if (!validEntry(value) || seen.has(value.name)) {
      return { entries: null, error: MCP_CATALOG_INVALID_ENTRY };
    }
    seen.add(value.name);
    entries.push({
      name: value.name,
      category: value.category,
      description: value.description.trim(),
    });
  }
  entries.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.name.localeCompare(right.name),
  );
  return { entries, error: null };
}

export interface McpCatalogCategory {
  category: string;
  count: number;
}

export function mcpCatalogCategories(
  entries: readonly McpCatalogEntry[],
): McpCatalogCategory[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => left.category.localeCompare(right.category));
}

/** Bound and normalise what the search field hands over. */
export function mcpCatalogSearchTerm(search: string): string {
  return search
    .slice(0, MCP_CATALOG_MAX_SEARCH_CHARS)
    .trim()
    .toLocaleLowerCase();
}

/**
 * Case-insensitive substring over name, description and category — the
 * desktop's rule. `category` of "" means every category.
 */
export function filterMcpCatalog(
  entries: readonly McpCatalogEntry[],
  search: string,
  category: string,
): McpCatalogEntry[] {
  const query = mcpCatalogSearchTerm(search);
  return entries.filter(
    (tool) =>
      (!category || tool.category === category) &&
      (!query ||
        [tool.name, tool.description, tool.category].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
}

/** The first `limit` matches, grouped by category in list order. */
export function groupMcpCatalog(
  entries: readonly McpCatalogEntry[],
  limit: number,
): Array<[string, McpCatalogEntry[]]> {
  const groups = new Map<string, McpCatalogEntry[]>();
  for (const tool of entries.slice(0, Math.max(0, limit))) {
    const bucket = groups.get(tool.category);
    if (bucket) bucket.push(tool);
    else groups.set(tool.category, [tool]);
  }
  return Array.from(groups.entries());
}

/** The one sentence under the search field. Desktop's wording. */
export function mcpCatalogResultSentence(
  total: number,
  matched: number,
  categories: number,
  filtered: boolean,
): string {
  return filtered
    ? `${matched} of ${total} tools match the active filters.`
    : `${total} tools across ${categories} categories.`;
}
