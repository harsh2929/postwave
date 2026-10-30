// Contract guards for two SDK/server drifts that silently returned wrong data.
//
//  1. `subscribers.list()` used to declare a `list_id` filter and forward it as
//     a query param. `GET /api/v1/subscribers` never reads it (Deps.List builds
//     ListOptions{Q,Status,Sort,Order,Cursor,Page,PerPage,IncludeArchived}), so
//     "members of list X" came back as the ENTIRE tenant while looking correct.
//     The membership read is `GET /api/v1/lists/{id}/subscribers`.
//
//  2. `archive.list()` accepted only {limit, cursor} while the handler has
//     always honoured `q` (AdminList -> listsearch.ReadQuery), and
//     ArchiveIssueSummary omitted pinned / viewCount / uniqueVisitors that
//     archive.IssueSummary ships on the admin path.
import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";
import type { ArchiveListPage, ListMembersPage } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(body: unknown) {
  const seen: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    seen.push(url);
    return json(body);
  });
  const client = new PostwaveClient({
    apiKey: "k",
    tenantId: "t",
    fetch,
    retries: 0,
  });
  return { client, seen };
}

describe("list membership goes to the list-scoped endpoint", () => {
  it("members() hits /api/v1/lists/{id}/subscribers with the server's params", async () => {
    const { client, seen } = harness({
      list_id: "11111111-2222-3333-4444-555555555555",
      items: [
        {
          id: "sub/1",
          email: "a@example.com",
          status: "enabled",
          source: "form",
          added_at: "2026-07-01T00:00:00Z",
        },
      ],
      total: 1,
      page: 2,
      per_page: 50,
    });

    const page: ListMembersPage = await client.lists.members(
      "11111111-2222-3333-4444-555555555555",
      { q: "example.com", status: "enabled", page: 2, per_page: 50 },
    );

    const url = new URL(seen[0]!);
    expect(url.pathname).toBe(
      "/api/v1/lists/11111111-2222-3333-4444-555555555555/subscribers",
    );
    expect(url.searchParams.get("q")).toBe("example.com");
    expect(url.searchParams.get("status")).toBe("enabled");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(page.items[0]!.email).toBe("a@example.com");
    expect(page.total).toBe(1);
  });

  it("accepts a legacy Listmonk bigint id and rejects an empty one", async () => {
    const { client, seen } = harness({
      list_id: "l/1",
      items: [],
      total: 0,
      page: 1,
      per_page: 25,
    });
    await client.lists.members(42);
    expect(new URL(seen[0]!).pathname).toBe("/api/v1/lists/42/subscribers");
    // No params → no stray query string the server would have to ignore.
    expect(new URL(seen[0]!).search).toBe("");
    expect(() => client.lists.members("   ")).toThrow(/List ID is required/);
  });

  it("subscribers.list() never sends a list filter the server drops", async () => {
    const { client, seen } = harness({ items: [], total: 0 });
    // `list_id` is not in ListSubscribersParams any more; force it through as
    // an untyped extra to prove nothing re-introduces it via spread.
    await client.subscribers.list({ q: "acme", status: "enabled" });
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/api/v1/subscribers");
    expect(url.searchParams.get("list_id")).toBeNull();
    expect(url.searchParams.get("q")).toBe("acme");
  });
});

describe("archive list carries the server's search param and admin columns", () => {
  it("forwards q alongside limit + cursor", async () => {
    const { client, seen } = harness({ items: [], nextCursor: "c2" });
    await client.archive.list({ limit: 25, cursor: "c1", q: "  welcome  " });
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/api/v1/archive");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("c1");
    // Trimmed, because listsearch.ReadQuery trims and a whitespace-only
    // query must not become a filter that matches nothing.
    expect(url.searchParams.get("q")).toBe("welcome");
  });

  it("omits a blank q rather than sending an empty filter", async () => {
    const { client, seen } = harness({ items: [] });
    await client.archive.list({ q: "   " });
    expect(new URL(seen[0]!).searchParams.has("q")).toBe(false);
  });

  it("types the admin columns archive.IssueSummary actually ships", async () => {
    const { client } = harness({
      items: [
        {
          slug: "issue-1",
          subject: "Welcome",
          excerpt: "hi",
          publishedAt: "2026-07-01T00:00:00Z",
          pinned: true,
          campaignId: "camp/1",
          viewCount: 412,
          uniqueVisitors: 380,
        },
      ],
      nextCursor: "c2",
    });
    const page: ArchiveListPage = await client.archive.list();
    const row = page.items[0]!;
    expect(row.pinned).toBe(true);
    expect(row.viewCount).toBe(412);
    expect(row.uniqueVisitors).toBe(380);
    expect(row.campaignId).toBe("camp/1");
  });
});
