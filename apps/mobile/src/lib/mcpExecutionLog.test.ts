import { describe, expect, it } from "vitest";

import { normalizeMcpExecutions, type McpExecution } from "@/lib/mcpActivity";
import {
  appendMcpExecutionPage,
  MCP_ALL_TOOLS_LABEL,
  MCP_EXECUTIONS_MAX_LOADED,
  mcpExecutionsQuery,
  mcpFirstPageCursor,
  mcpNextCursorSentence,
  mcpRetentionCapSentence,
  mcpToolChipLabel,
  mcpToolChipNames,
  mcpToolFilterSentence,
  parseMcpExecutionPage,
  validMcpToolFilter,
} from "@/lib/mcpExecutionLog";

/**
 * The traversal is the place this screen could invent a row (a duplicate),
 * skip one (a cursor that moved the wrong way), or loop (a server that ignored
 * before_id). Each rule is asserted from the failing side.
 */

function row(id: number, toolName = "subscribers_list"): McpExecution {
  return normalizeMcpExecutions({
    rows: [
      {
        id,
        toolName,
        method: "GET",
        path: "/api/v1/subscribers",
        statusCode: 200,
        latencyMs: 12,
        calledAt: "2026-07-25T03:00:00Z",
      },
    ],
  })[0]!;
}

function rows(ids: number[], toolName?: string): McpExecution[] {
  return ids.map((id) => row(id, toolName));
}

describe("validMcpToolFilter — the server's safeToolLabel, mirrored", () => {
  it("accepts no filter and a canonical token", () => {
    expect(validMcpToolFilter("")).toBe(true);
    expect(validMcpToolFilter("subscribers_list")).toBe(true);
    expect(validMcpToolFilter("campaign.send:v2-beta")).toBe(true);
  });

  it("refuses what the server would 400", () => {
    // Leading character must be a letter.
    expect(validMcpToolFilter("1subscribers")).toBe(false);
    expect(validMcpToolFilter("_list")).toBe(false);
    // Grammar: no spaces or slashes.
    expect(validMcpToolFilter("subscribers list")).toBe(false);
    expect(validMcpToolFilter("subscribers/list")).toBe(false);
    // UUID-shaped identifiers are refused outright.
    expect(validMcpToolFilter("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
    // More digits than half the length: 4 of 5.
    expect(validMcpToolFilter("a1234")).toBe(false);
    // Exactly half is allowed (Go: digits > len/2 refuses, 2 > 2 is false).
    expect(validMcpToolFilter("ab12")).toBe(true);
    // 96 characters is the ceiling; 97 is not.
    expect(validMcpToolFilter(`a${"b".repeat(95)}`)).toBe(true);
    expect(validMcpToolFilter(`a${"b".repeat(96)}`)).toBe(false);
  });

  it("refuses secret-shaped material even when the grammar allows it", () => {
    expect(validMcpToolFilter("pw_live_abcdef123")).toBe(false);
  });
});

describe("mcpExecutionsQuery", () => {
  it("builds exactly the paths the screen already sent, then adds the two new parameters", () => {
    expect(
      mcpExecutionsQuery({ includeAll: false, limit: 50, tool: "", beforeId: null }),
    ).toBe("/api/v1/mcp/executions?limit=50");
    expect(
      mcpExecutionsQuery({ includeAll: true, limit: 50, tool: "", beforeId: null }),
    ).toBe("/api/v1/mcp/executions?limit=50&include=all");
    expect(
      mcpExecutionsQuery({
        includeAll: true,
        limit: 50,
        tool: "campaign.send:v2",
        beforeId: 51,
      }),
    ).toBe(
      "/api/v1/mcp/executions?limit=50&include=all&tool=campaign.send%3Av2&before_id=51",
    );
  });

  it("throws the server's own sentences rather than sending a request it would 400", () => {
    expect(() =>
      mcpExecutionsQuery({ includeAll: false, limit: 0, tool: "", beforeId: null }),
    ).toThrow("limit must be an integer from 1 to 500");
    expect(() =>
      mcpExecutionsQuery({ includeAll: false, limit: 501, tool: "", beforeId: null }),
    ).toThrow("limit must be an integer from 1 to 500");
    expect(() =>
      mcpExecutionsQuery({ includeAll: false, limit: 50, tool: "1bad", beforeId: null }),
    ).toThrow("tool must be a bounded canonical tool token");
    expect(() =>
      mcpExecutionsQuery({ includeAll: false, limit: 50, tool: "", beforeId: 0 }),
    ).toThrow("before_id must be a positive integer");
    expect(() =>
      mcpExecutionsQuery({ includeAll: false, limit: 50, tool: "", beforeId: 1.5 }),
    ).toThrow("before_id must be a positive integer");
  });
});

describe("parseMcpExecutionPage", () => {
  it("keeps the server cursor only when it is a positive integer", () => {
    const wire = { rows: [{ id: 9, toolName: "t", statusCode: 200 }] };
    expect(parseMcpExecutionPage({ ...wire, nextBeforeId: 9 })).toEqual({
      rows: [expect.objectContaining({ id: 9, toolName: "t" })],
      nextBeforeId: 9,
    });
    for (const absent of [undefined, null, 0, -3, "9", 2.5]) {
      expect(parseMcpExecutionPage({ ...wire, nextBeforeId: absent }).nextBeforeId).toBeNull();
    }
  });

  it("reads a non-object payload as an empty page with no cursor", () => {
    expect(parseMcpExecutionPage("<html>")).toEqual({ rows: [], nextBeforeId: null });
    expect(parseMcpExecutionPage(null)).toEqual({ rows: [], nextBeforeId: null });
  });
});

describe("mcpFirstPageCursor — inferred from the count", () => {
  it("offers nothing older after a short page", () => {
    expect(mcpFirstPageCursor(rows([100, 99]), 50)).toBeNull();
    expect(mcpFirstPageCursor([], 50)).toBeNull();
  });

  it("uses the oldest id of a full page, whatever order it arrived in", () => {
    const ids = Array.from({ length: 50 }, (_, index) => 100 - index);
    expect(mcpFirstPageCursor(rows(ids), 50)).toBe(51);
    expect(mcpFirstPageCursor(rows([...ids].reverse()), 50)).toBe(51);
  });

  it("offers nothing when a full page carries no usable ids", () => {
    expect(mcpFirstPageCursor(rows(Array(50).fill(0)), 50)).toBeNull();
  });
});

describe("appendMcpExecutionPage", () => {
  const known = rows([100, 99, 98]);

  it("appends only unseen rows strictly older than the cursor, newest first", () => {
    const page = {
      rows: [row(99, "dup"), row(120, "future"), row(96), row(97), row(97, "dup")],
      nextBeforeId: 96,
    };
    const result = appendMcpExecutionPage(known, page, 98, 5);
    expect(result.added.map((entry) => entry.id)).toEqual([97, 96]);
    expect(result.added.some((entry) => entry.toolName === "dup")).toBe(false);
    expect(result.added.some((entry) => entry.toolName === "future")).toBe(false);
  });

  it("drops the row AT the cursor even when it is not already on screen", () => {
    // `before_id` is exclusive. The row at the cursor is normally already
    // loaded — the cursor is its id — so the dedupe set hides this rule; but
    // the first page is re-read between taps and can have moved on, and then
    // exclusivity is the only thing keeping a repeat off the screen.
    const page = { rows: [row(98, "at_cursor"), row(97)], nextBeforeId: 97 };
    const result = appendMcpExecutionPage(rows([100, 99]), page, 98, 2);
    expect(result.added.map((entry) => entry.id)).toEqual([97]);
  });

  it("continues from the oldest id below the cursor when the page was full and the server offered a cursor", () => {
    const page = { rows: rows([97, 96, 95]), nextBeforeId: 95 };
    expect(appendMcpExecutionPage(known, page, 98, 3).cursor).toBe(95);
  });

  it("stops after a short page, an empty page, or a page without a server cursor", () => {
    expect(
      appendMcpExecutionPage(known, { rows: rows([97, 96]), nextBeforeId: 96 }, 98, 3).cursor,
    ).toBeNull();
    expect(appendMcpExecutionPage(known, { rows: [], nextBeforeId: null }, 98, 3).cursor).toBeNull();
    expect(
      appendMcpExecutionPage(known, { rows: rows([97, 96, 95]), nextBeforeId: null }, 98, 3).cursor,
    ).toBeNull();
  });

  it("stops rather than loops when a server ignored before_id", () => {
    // Every row is at or above the cursor: nothing is added and no cursor
    // is offered, so the same page cannot be requested forever.
    const page = { rows: rows([100, 99, 98]), nextBeforeId: 98 };
    const result = appendMcpExecutionPage(known, page, 98, 3);
    expect(result.added).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it("caps the traversal and says so only when more existed", () => {
    const many = rows(
      Array.from({ length: MCP_EXECUTIONS_MAX_LOADED - 1 }, (_, index) => 1_000 - index),
    );
    const full = { rows: rows([700, 699, 698]), nextBeforeId: 698 };
    const capped = appendMcpExecutionPage(many, full, 702, 3);
    expect(capped.capped).toBe(true);
    expect(capped.cursor).toBeNull();
    expect(capped.added).toHaveLength(3);

    const short = { rows: rows([700]), nextBeforeId: null };
    const finished = appendMcpExecutionPage(many, short, 702, 3);
    expect(finished.capped).toBe(false);
    expect(finished.cursor).toBeNull();
  });
});

describe("mcpToolChipNames", () => {
  it("unions what was seen with what is loaded and the active filter, sorted, sendable only", () => {
    const loaded = [
      row(3, "subscribers_list"),
      row(2, ""),
      row(1, "1not-sendable"),
      row(4, "subscribers_list"),
    ];
    expect(mcpToolChipNames(["campaign_send"], loaded, "flows_list")).toEqual([
      "campaign_send",
      "flows_list",
      "subscribers_list",
    ]);
  });

  it("keeps a chip after it is chosen and the rows narrow to it", () => {
    const seen = mcpToolChipNames([], [row(1, "a_tool"), row(2, "b_tool")], "");
    expect(mcpToolChipNames(seen, [row(2, "b_tool")], "b_tool")).toEqual([
      "a_tool",
      "b_tool",
    ]);
  });
});

describe("mcpToolChipLabel", () => {
  it("never renders the bare identifier the rows already show", () => {
    expect(mcpToolChipLabel("subscribers_list")).toBe("Only subscribers_list");
    expect(mcpToolChipLabel("subscribers_list")).not.toBe("subscribers_list");
    expect(MCP_ALL_TOOLS_LABEL).toBe("All tools");
  });
});

describe("sentences", () => {
  it("state the cursor, the cap, and the filter without inventing counts", () => {
    expect(mcpNextCursorSentence(51)).toBe("Next cursor begins before execution 51.");
    expect(mcpRetentionCapSentence(300)).toBe(
      "300 loaded rows are retained in this view. Older rows are not requested again; narrow the filter or refresh to start a new bounded traversal.",
    );
    expect(mcpToolFilterSentence("", 12)).toBe("All recorded identifiers.");
    expect(mcpToolFilterSentence("subscribers_list", 1)).toBe(
      "Only rows recorded under subscribers_list. The server applies this filter; 1 row loaded so far.",
    );
    expect(mcpToolFilterSentence("subscribers_list", 2)).toBe(
      "Only rows recorded under subscribers_list. The server applies this filter; 2 rows loaded so far.",
    );
  });
});
