import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/sdkClient", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import {
  listMembersPath,
  MEMBERS_PER_PAGE,
  parseGrowth,
  parseMembersPage,
} from "./listDetail";

describe("listMembersPath", () => {
  it("always sends an explicit page + per_page", () => {
    expect(listMembersPath("42", 2, "")).toBe(
      `/api/v1/lists/42/subscribers?page=2&per_page=${MEMBERS_PER_PAGE}`,
    );
  });

  it("sends `query` (the param the Go handler reads), not `q`", () => {
    expect(listMembersPath("42", 1, " ada ")).toContain("query=ada");
  });

  it("omits an all-whitespace query", () => {
    expect(listMembersPath("42", 1, "   ")).not.toContain("query");
  });

  it("clamps a zero/negative page to 1", () => {
    expect(listMembersPath("42", 0, "")).toContain("page=1");
    expect(listMembersPath("42", -3, "")).toContain("page=1");
  });

  it("encodes a UUID list id and an unsafe query", () => {
    const path = listMembersPath("3f7c1b2e-9a4d-4c11-8f22-0b1d2e3f4a5b", 1, "a&b");
    expect(path).toContain("/api/v1/lists/3f7c1b2e-9a4d-4c11-8f22-0b1d2e3f4a5b/");
    expect(path).toContain("query=a%26b");
  });
});

describe("parseMembersPage", () => {
  it("reads the MembersPage envelope", () => {
    expect(
      parseMembersPage(
        {
          list_id: "l1",
          items: [
            {
              id: "s1",
              email: "a@b.c",
              status: "enabled",
              source: "form",
              added_at: "2026-01-01T00:00:00Z",
            },
          ],
          total: 143,
          page: 1,
          per_page: 25,
        },
        1,
      ),
    ).toEqual({
      items: [
        {
          id: "s1",
          email: "a@b.c",
          status: "enabled",
          source: "form",
          added_at: "2026-01-01T00:00:00Z",
        },
      ],
      total: 143,
      page: 1,
      perPage: 25,
    });
  });

  it("drops rows with no email (nothing to render or route to)", () => {
    const page = parseMembersPage({ items: [{ id: "x" }, 5, null] }, 1);
    expect(page.items).toEqual([]);
  });

  it("falls back to the email as the row id", () => {
    expect(parseMembersPage({ items: [{ email: "a@b.c" }] }, 1).items[0]).toEqual({
      id: "a@b.c",
      email: "a@b.c",
      status: "",
    });
  });

  it("omits absent optional fields rather than setting them undefined", () => {
    const row = parseMembersPage({ items: [{ email: "a@b.c" }] }, 1).items[0]!;
    expect(Object.prototype.hasOwnProperty.call(row, "source")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "added_at")).toBe(false);
  });

  it("degrades to the loaded count when the server omits total", () => {
    const page = parseMembersPage({ items: [{ email: "a@b.c" }] }, 3);
    expect(page.total).toBe(1);
    expect(page.page).toBe(3);
  });

  it("survives a null / non-object payload", () => {
    expect(parseMembersPage(null, 1).items).toEqual([]);
    expect(parseMembersPage("nope", 1).total).toBe(0);
  });
});

describe("parseGrowth", () => {
  it("reads the points series and the current size", () => {
    expect(
      parseGrowth({
        list_id: "l1",
        window_days: 30,
        current: 1200,
        points: [
          { date: "2026-01-01", added: 5, removed: 1, net: 4, total: 1196 },
          { date: "2026-01-02", added: 6, removed: 2, net: 4, total: 1200 },
        ],
      }),
    ).toEqual({
      current: 1200,
      windowDays: 30,
      points: [
        { date: "2026-01-01", added: 5, removed: 1, net: 4, total: 1196 },
        { date: "2026-01-02", added: 6, removed: 2, net: 4, total: 1200 },
      ],
    });
  });

  it("keeps `current` NULL when absent — not 0", () => {
    // A list of unknown size must not be rendered as an empty list.
    expect(parseGrowth({ points: [] }).current).toBeNull();
  });

  it("drops malformed points instead of charting NaN", () => {
    const growth = parseGrowth({
      points: [{ added: 1 }, null, { date: "2026-01-01" }],
    });
    expect(growth.points).toEqual([
      { date: "2026-01-01", added: 0, removed: 0, net: 0, total: 0 },
    ]);
  });

  it("defaults the window to 30 days", () => {
    expect(parseGrowth({}).windowDays).toBe(30);
  });

  it("survives a null payload", () => {
    expect(parseGrowth(null)).toEqual({
      current: null,
      windowDays: 30,
      points: [],
    });
  });
});
