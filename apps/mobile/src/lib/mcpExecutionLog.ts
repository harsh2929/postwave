/**
 * lib/mcpExecutionLog.ts — the execution log's tool filter and before-id
 * cursor, kept pure.
 *
 * WHAT THE SERVER OFFERS. `GET /api/v1/mcp/executions`
 * (apps/api/internal/apikeycalls/handlers.go, `parseExecutionListFilter`)
 * takes exactly `include`, `tool`, `api_key_id`, `limit`, `before_id`,
 * `since`, `until` — any other key is a 400. Two of them matter here:
 *
 *  - `tool` is an EXACT match (`c.tool_name = $n`, apikeycalls.go Repo.List)
 *    and must survive `safeToolLabel` unchanged: a leading letter, then up to
 *    95 of `[A-Za-z0-9._:-]`, not UUID-shaped, and never more digits than half
 *    its length. Anything else is refused as "tool must be a bounded canonical
 *    tool token". `validMcpToolFilter` mirrors that rule so a chip can never
 *    send a value the server will 400 — and adds the desktop's
 *    `validMcpToolFilter` ceiling of 96 characters plus its secret-material
 *    rule, because the chip label is rendered as an exact token.
 *  - `before_id` is an EXCLUSIVE cursor (`c.id < $n`), rows come back in
 *    descending id order, and the server asks for `limit + 1` rows so it can
 *    set `nextBeforeId` (the last row's id) only when a further row exists.
 *
 * TWO CURSOR RULES, STATED SEPARATELY. The first page arrives through the
 * array-shaped hook the rest of the screen already reads, so its cursor is
 * INFERRED from the count: a full page may have more, a short page cannot.
 * Older pages come through `parseMcpExecutionPage` and carry the server's own
 * `nextBeforeId`; traversal continues only while the page is full AND the
 * server offered a cursor. The cursor itself is always computed locally as the
 * smallest id below the one requested — identical to the server's number when
 * the page is well-ordered, and the one value that guarantees progress when
 * it is not.
 *
 * DEDUPE BY ID. `before_id` is exclusive, so a well-behaved server never
 * repeats a row; but the recorder is live, the first page can be re-read
 * between "Load older" taps, and a proxy that ignored the cursor would hand
 * back the first page again forever. Every appended row must be unseen and
 * strictly older than the cursor that was sent.
 *
 * DELIBERATELY FREE of react-native imports so it runs under node vitest.
 */
import { normalizeMcpExecutions, type McpExecution } from "@/lib/mcpActivity";
import { safeMcpToolName } from "@/lib/mcpExecutionDetail";

/** Desktop's ceiling on a typed tool filter (mcp-route-state.ts). */
export const MCP_TOOL_FILTER_MAX_CHARS = 96;

/** Server ceiling on `limit` (handlers.go: "from 1 to 500"). */
export const MCP_EXECUTIONS_MAX_LIMIT = 500;

/**
 * Rows this view will hold before it stops asking for older ones. Desktop
 * retains 500; a phone reading at arm's length gets six pages, and the footer
 * says so rather than paging silently into a list nobody can finish.
 */
export const MCP_EXECUTIONS_MAX_LOADED = 300;

/** `toolLabelPattern` and `uuidLikeToolPattern`, apikeycalls.go:1048-1049. */
const SERVER_TOOL_LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u;
const UUID_LIKE_TOOL = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu;

/**
 * True when `value` is "" (no filter) or a token the server's `safeToolLabel`
 * returns unchanged AND the desktop's display rules accept.
 */
export function validMcpToolFilter(value: string): boolean {
  if (value === "") return true;
  if (value.length > MCP_TOOL_FILTER_MAX_CHARS) return false;
  if (!SERVER_TOOL_LABEL.test(value) || UUID_LIKE_TOOL.test(value)) return false;
  // Go: `digits > len(tool)/2` refuses; integer division floors.
  const digits = value.replace(/[^0-9]/gu, "").length;
  if (digits > Math.floor(value.length / 2)) return false;
  return safeMcpToolName(value) === value;
}

export interface McpExecutionsQuery {
  includeAll: boolean;
  limit: number;
  /** "" for every tool; otherwise an exact identifier. */
  tool: string;
  /** Exclusive cursor, or null for the newest page. */
  beforeId: number | null;
}

/**
 * The request path, with the server's own refusal sentences thrown for an
 * input it would 400 — the screen only offers values that pass, so a throw
 * here is a programming error surfacing as a query error, never a silent
 * unfiltered page under a filter label.
 */
export function mcpExecutionsQuery(query: McpExecutionsQuery): string {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MCP_EXECUTIONS_MAX_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 to ${MCP_EXECUTIONS_MAX_LIMIT}`,
    );
  }
  if (!validMcpToolFilter(query.tool)) {
    throw new Error("tool must be a bounded canonical tool token");
  }
  if (
    query.beforeId !== null &&
    (!Number.isSafeInteger(query.beforeId) || query.beforeId <= 0)
  ) {
    throw new Error("before_id must be a positive integer");
  }
  let path = `/api/v1/mcp/executions?limit=${query.limit}`;
  // Only ever SENT when widening: the server tests `include != "all"`, so
  // `include=mcp` would be indistinguishable from nothing (api/mcpActivity).
  if (query.includeAll) path += "&include=all";
  if (query.tool !== "") path += `&tool=${encodeURIComponent(query.tool)}`;
  if (query.beforeId !== null) path += `&before_id=${query.beforeId}`;
  return path;
}

export interface McpExecutionPage {
  rows: McpExecution[];
  /**
   * The server's cursor, or null when it offered none — which it does only
   * when no older matching row exists (handlers.go ListExecutions).
   */
  nextBeforeId: number | null;
}

export function parseMcpExecutionPage(raw: unknown): McpExecutionPage {
  const rows = normalizeMcpExecutions(raw);
  const next =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).nextBeforeId
      : undefined;
  return {
    rows,
    nextBeforeId:
      typeof next === "number" && Number.isSafeInteger(next) && next > 0
        ? next
        : null,
  };
}

/** The smallest positive id strictly below `below`, or null. */
function oldestIdBelow(
  rows: readonly McpExecution[],
  below: number,
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.id >= below) {
      continue;
    }
    if (oldest === null || row.id < oldest) oldest = row.id;
  }
  return oldest;
}

/**
 * The `before_id` the first "Load older" should send, inferred from the
 * count: a page shorter than `limit` has nothing older; a full page might.
 */
export function mcpFirstPageCursor(
  rows: readonly McpExecution[],
  limit: number,
): number | null {
  if (rows.length < limit) return null;
  return oldestIdBelow(rows, Number.MAX_SAFE_INTEGER);
}

export interface McpOlderPageResult {
  /** Rows to append, newest first — unseen and strictly older than the cursor. */
  added: McpExecution[];
  /** The next `before_id`, or null when traversal stops. */
  cursor: number | null;
  /** True when more exists but this view will not ask for it. */
  capped: boolean;
}

/**
 * Fold one older page into what is already on screen.
 *
 * `known` is every row currently shown (first page plus older pages), so the
 * dedupe covers a first page that was re-read since the last tap. Traversal
 * continues only while the page was full, the server offered a cursor, and
 * some row was strictly older than the one requested; it stops early — with
 * `capped` — once the view holds `MCP_EXECUTIONS_MAX_LOADED` rows.
 */
export function appendMcpExecutionPage(
  known: readonly McpExecution[],
  page: McpExecutionPage,
  requestedBeforeId: number,
  limit: number,
): McpOlderPageResult {
  const seen = new Set<number>();
  for (const row of known) seen.add(row.id);
  const added: McpExecution[] = [];
  for (const row of page.rows) {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      row.id >= requestedBeforeId ||
      seen.has(row.id)
    ) {
      continue;
    }
    seen.add(row.id);
    added.push(row);
  }
  added.sort((left, right) => right.id - left.id);
  const next = oldestIdBelow(page.rows, requestedBeforeId);
  const more =
    page.rows.length >= limit && page.nextBeforeId !== null && next !== null;
  const capped = more && known.length + added.length >= MCP_EXECUTIONS_MAX_LOADED;
  return { added, cursor: more && !capped ? next : null, capped };
}

/**
 * Chip identifiers: every tool seen in this session's loaded rows, kept
 * across filter changes (a chip must not vanish the moment it is chosen, or
 * there is no way back to the others), plus the active one so a filter that
 * matched nothing can still be cleared. Only server-sendable names are
 * offered.
 */
export function mcpToolChipNames(
  seen: readonly string[],
  rows: readonly McpExecution[],
  active: string,
): string[] {
  const names = new Set<string>();
  for (const name of seen) {
    if (name !== "" && validMcpToolFilter(name)) names.add(name);
  }
  for (const row of rows) {
    if (row.toolName !== "" && validMcpToolFilter(row.toolName)) {
      names.add(row.toolName);
    }
  }
  if (active !== "" && validMcpToolFilter(active)) names.add(active);
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

/** The chip that removes the filter. */
export const MCP_ALL_TOOLS_LABEL = "All tools";

/**
 * A tool chip's label — and it is NEVER the bare identifier.
 *
 * The rows below the chips already render that exact string. Repeating it as a
 * chip puts two identical strings on one screen meaning two different things
 * (a filter you may choose, and a call that happened), which a screen reader
 * reads as the same word twice and a reader scanning the list cannot tell
 * apart. "Only X" also states what choosing it DOES, matching the caption
 * (`mcpToolFilterSentence`) and the empty state.
 */
export function mcpToolChipLabel(tool: string): string {
  return `Only ${tool}`;
}

/* Desktop's sentences (McpExecutionLog.tsx), verbatim where they exist. */
export const MCP_LOAD_OLDER_LABEL = "Load older";
export const MCP_LOADING_OLDER_LABEL = "Loading older executions…";
export const MCP_LOAD_OLDER_BUSY = "One page request is already in progress.";
export const MCP_OLDER_EXHAUSTED =
  "No older matching rows were returned in this traversal. The recorder may still be incomplete.";
export const MCP_OLDER_NOT_ADDED = "Older executions were not added";
export const MCP_OLDER_OFFLINE =
  "Older calls need a connection. Reconnect to keep paging.";
export const MCP_RETENTION_CAP_TITLE = "Local inspection limit reached";

export function mcpNextCursorSentence(cursor: number): string {
  return `Next cursor begins before execution ${cursor}.`;
}

export function mcpRetentionCapSentence(loaded: number): string {
  return `${loaded} loaded rows are retained in this view. Older rows are not requested again; narrow the filter or refresh to start a new bounded traversal.`;
}

/** The caption under the chips: what the log is currently a list OF. */
export function mcpToolFilterSentence(tool: string, loaded: number): string {
  if (tool === "") return "All recorded identifiers.";
  return `Only rows recorded under ${tool}. The server applies this filter; ${loaded} ${loaded === 1 ? "row" : "rows"} loaded so far.`;
}
