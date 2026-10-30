// subscribers-paging — server-driven Subscribers list logic.
//
// Pins the offset numbered-pager model: param building (status→engine
// mapping, perPage clamp, server-only sorts), honest response parsing
// (the cursor-path total:0 trap, items|data|results unwrap), and the
// pager footer math (real total vs degraded "N loaded").

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  MAX_PER_PAGE,
  buildListParams,
  clampPerPage,
  clientSortPage,
  isServerSort,
  pagerView,
  parseListResponse,
  unwrapRows,
} from "../pages/subscribers-paging";
import type { SubscribersResponse } from "../lib/api-client";

// Mirrors uiStatusToEngine for the buckets the page uses, kept local so
// the pure module has no cross-module dep in tests.
const statusToEngine = (s: string): string => {
  switch (s) {
    case "subscribed":
      return "enabled";
    case "unsubscribed":
      return "blocklisted";
    case "disabled":
      return "disabled";
    case "unconfirmed":
      return "unconfirmed";
    default:
      return "enabled";
  }
};

describe("isServerSort", () => {
  it("accepts the server-supported columns", () => {
    for (const s of [
      "updated_at",
      "created_at",
      "email",
      "status",
      "engagement",
      "first_name",
      "last_name",
      // SUB-038 — churn-risk + contact rating joined the server-sort set.
      "churn",
      "rating",
    ]) {
      expect(isServerSort(s)).toBe(true);
    }
  });
  it("rejects unsupported columns", () => {
    // SUB-038 — only the alias "churn" is server-sortable, not the raw
    // column name "churn_score"; the latter still falls back to a client sort.
    expect(isServerSort("churn_score")).toBe(false);
    expect(isServerSort("last_active")).toBe(false);
    expect(isServerSort("")).toBe(false);
  });
});

describe("clampPerPage", () => {
  it("clamps to the server max", () => {
    expect(clampPerPage(500)).toBe(MAX_PER_PAGE);
    expect(clampPerPage(MAX_PER_PAGE)).toBe(MAX_PER_PAGE);
  });
  it("falls back to 50 on garbage", () => {
    expect(clampPerPage(0)).toBe(50);
    expect(clampPerPage(-5)).toBe(50);
    expect(clampPerPage(Number.NaN)).toBe(50);
  });
  it("keeps a sane page size", () => {
    expect(clampPerPage(50)).toBe(50);
    expect(clampPerPage(25)).toBe(25);
  });
});

describe("buildListParams", () => {
  const base = {
    query: "",
    status: "all",
    sort: DEFAULT_SORT as string,
    order: DEFAULT_ORDER,
    page: 1,
    perPage: 50,
    statusToEngine,
  };

  it("omits query/status when empty/all and forwards the default sort", () => {
    const p = buildListParams(base);
    expect(p).toEqual({
      page: 1,
      perPage: 50,
      sort: "updated_at",
      order: "desc",
    });
    expect(p.query).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("trims the query and drops it when blank", () => {
    expect(buildListParams({ ...base, query: "  a@b.com " }).query).toBe(
      "a@b.com",
    );
    expect(buildListParams({ ...base, query: "   " }).query).toBeUndefined();
  });

  it("maps the UI status bucket to the engine value", () => {
    expect(buildListParams({ ...base, status: "subscribed" }).status).toBe(
      "enabled",
    );
    expect(buildListParams({ ...base, status: "unsubscribed" }).status).toBe(
      "blocklisted",
    );
    expect(buildListParams({ ...base, status: "disabled" }).status).toBe(
      "disabled",
    );
    expect(buildListParams({ ...base, status: "unconfirmed" }).status).toBe(
      "unconfirmed",
    );
    expect(buildListParams({ ...base, status: "all" }).status).toBeUndefined();
  });

  it("omits sort/order for a column the server can't sort", () => {
    // last_active is not in SERVER_SORTS, so it stays a client-only sort.
    const p = buildListParams({ ...base, sort: "last_active" });
    expect(p.sort).toBeUndefined();
    expect(p.order).toBeUndefined();
  });

  it("forwards the SUB-038 server sorts (churn, rating)", () => {
    const churn = buildListParams({ ...base, sort: "churn", order: "desc" });
    expect(churn.sort).toBe("churn");
    expect(churn.order).toBe("desc");
    const rating = buildListParams({ ...base, sort: "rating", order: "asc" });
    expect(rating.sort).toBe("rating");
    expect(rating.order).toBe("asc");
  });

  it("clamps perPage and floors the page", () => {
    const p = buildListParams({ ...base, perPage: 9999, page: 3.7 });
    expect(p.perPage).toBe(MAX_PER_PAGE);
    expect(p.page).toBe(3);
  });

  it("never lets page drop below 1", () => {
    expect(buildListParams({ ...base, page: 0 }).page).toBe(1);
    expect(buildListParams({ ...base, page: -2 }).page).toBe(1);
  });
});

describe("unwrapRows", () => {
  it("reads items, then results, then data", () => {
    expect(unwrapRows({ items: [{ id: 1, email: "a@b.com" }] })).toHaveLength(1);
    expect(unwrapRows({ results: [{ id: 2, email: "b@b.com" }] })).toHaveLength(1);
    expect(unwrapRows({ data: [{ id: 3, email: "c@b.com" }] })).toHaveLength(1);
    expect(unwrapRows({})).toEqual([]);
    expect(unwrapRows(null)).toEqual([]);
    expect(unwrapRows(undefined)).toEqual([]);
  });
});

describe("parseListResponse", () => {
  it("reads a normal offset page with a real total", () => {
    const res: SubscribersResponse = {
      items: [
        { id: 1, email: "a@b.com" },
        { id: 2, email: "b@b.com" },
      ],
      total: 1984,
      page: 2,
      per_page: 50,
    };
    const p = parseListResponse(res, 2, 50);
    expect(p.rows).toHaveLength(2);
    expect(p.total).toBe(1984);
    expect(p.page).toBe(2);
    expect(p.perPage).toBe(50);
  });

  it("does NOT trust the cursor-path total:0 when rows exist", () => {
    // Cursor path returns rows + total:0; we must not claim total 0.
    const res: SubscribersResponse = {
      items: [{ id: 1, email: "a@b.com" }],
      total: 0,
      next_cursor: "abc",
    };
    expect(parseListResponse(res, 1, 50).total).toBeNull();
  });

  it("reports an honest 0 for a genuinely empty first page", () => {
    expect(parseListResponse({ items: [], total: 0 }, 1, 50).total).toBe(0);
    expect(parseListResponse({ items: [] }, 1, 50).total).toBe(0);
  });

  it("leaves total null for an empty slice past page 1", () => {
    expect(parseListResponse({ items: [] }, 4, 50).total).toBeNull();
  });

  it("falls back to the requested page/perPage when the server omits them", () => {
    const p = parseListResponse(
      { items: [{ id: 1, email: "a@b.com" }], total: 10 },
      3,
      25,
    );
    expect(p.page).toBe(3);
    expect(p.perPage).toBe(25);
  });
});

describe("pagerView", () => {
  it("computes pages + an honest label with a real total", () => {
    const v = pagerView(2, 1984, 50, 50);
    expect(v.totalPages).toBe(40); // ceil(1984/50)
    expect(v.page).toBe(2);
    expect(v.hasPrev).toBe(true);
    expect(v.hasNext).toBe(true);
    expect(v.hasTotal).toBe(true);
    expect(v.label).toBe("Page 2 of 40 · 50 of 1,984");
  });

  it("clamps an out-of-range page into bounds", () => {
    expect(pagerView(99, 100, 50, 0).page).toBe(2); // ceil(100/50)=2
    expect(pagerView(0, 100, 50, 50).page).toBe(1);
  });

  it("renders the empty state when total is 0", () => {
    const v = pagerView(1, 0, 50, 0);
    expect(v.label).toBe("No subscribers");
    expect(v.hasNext).toBe(false);
    expect(v.hasPrev).toBe(false);
  });

  it("degrades honestly when total is unknown (cursor/sparse backend)", () => {
    // Full page ⇒ assume more, keep Next.
    const full = pagerView(2, null, 50, 50);
    expect(full.hasTotal).toBe(false);
    expect(full.hasNext).toBe(true);
    expect(full.label).toBe("Page 2 · 50 loaded");
    // Short page ⇒ end of set, Next disabled.
    const short = pagerView(2, null, 50, 17);
    expect(short.hasNext).toBe(false);
    expect(short.label).toBe("Page 2 · 17 loaded");
  });
});

describe("clientSortPage", () => {
  it("sorts strings asc/desc without mutating the input", () => {
    const rows = [{ email: "c" }, { email: "a" }, { email: "b" }];
    const asc = clientSortPage(rows, "email", "asc");
    expect(asc.map((r) => r.email)).toEqual(["a", "b", "c"]);
    const desc = clientSortPage(rows, "email", "desc");
    expect(desc.map((r) => r.email)).toEqual(["c", "b", "a"]);
    // Original untouched.
    expect(rows.map((r) => r.email)).toEqual(["c", "a", "b"]);
  });

  it("sorts numeric fields numerically", () => {
    const rows = [
      { rating: 10 },
      { rating: 2 },
      { rating: 30 },
    ] as unknown as Parameters<typeof clientSortPage>[0];
    const asc = clientSortPage(rows, "rating", "asc");
    expect(
      asc.map((r) => (r as unknown as { rating: number }).rating),
    ).toEqual([2, 10, 30]);
  });

  it("sorts rows with missing fields to one end", () => {
    const rows = [
      { email: "b" },
      {},
      { email: "a" },
    ] as unknown as Parameters<typeof clientSortPage>[0];
    const asc = clientSortPage(rows, "email", "asc");
    // "" sorts first ascending.
    expect(asc[0]).toEqual({});
  });
});
