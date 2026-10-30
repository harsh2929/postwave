import { describe, expect, it } from "vitest";

import type { SuppressionRow } from "@/lib/suppressionPage";
import {
  filterSuppressionRows,
  rowInDateWindow,
  sortTime,
  suppressionDateWindowByKey,
  suppressionEmptyCopy,
  SUPPRESSION_DATE_WINDOWS,
} from "@/lib/suppressionListRows";
import type { ClassifiedQuery } from "@/lib/suppressionSearch";

const NONE: ClassifiedQuery = { mode: "none", value: "" };
const CLIENT: ClassifiedQuery = { mode: "client", value: "ac" };
const PREFIX: ClassifiedQuery = { mode: "prefix", value: "zzz" };

function row(over: Partial<SuppressionRow>): SuppressionRow {
  return { id: "id-1", email: "a@example.com", ...over };
}

describe("sortTime", () => {
  it("reads an ISO timestamp as its epoch milliseconds", () => {
    expect(sortTime("1970-01-01T00:00:01.000Z")).toBe(1000);
    expect(sortTime("2026-08-27T00:00:00.000Z")).toBe(
      Date.UTC(2026, 7, 27, 0, 0, 0),
    );
  });

  it("sinks a missing or unparseable date instead of poisoning the sort", () => {
    expect(sortTime(undefined)).toBe(0);
    expect(sortTime("")).toBe(0);
    expect(sortTime("not a date")).toBe(0);
  });
});

describe("filterSuppressionRows", () => {
  it("orders newest first", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
        row({ id: "new", created_at: "2026-06-01T00:00:00Z" }),
        row({ id: "mid", created_at: "2026-03-01T00:00:00Z" }),
      ],
      "all",
      NONE,
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("puts a row with no timestamp last rather than dropping it", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "undated" }),
        row({ id: "dated", created_at: "2026-01-01T00:00:00Z" }),
      ],
      "all",
      NONE,
    );
    expect(rows.map((r) => r.id)).toEqual(["dated", "undated"]);
  });

  it("narrows by the reason chip", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "bounced", reason: "hard_bounce" }),
        row({ id: "complained", reason: "complaint" }),
      ],
      "hard_bounce",
      NONE,
    );
    expect(rows.map((r) => r.id)).toEqual(["bounced"]);
  });

  it("narrows on a 1-2 character query the server was never asked to filter", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "hit", email: "MAC@example.com" }),
        row({ id: "miss", email: "bob@example.com" }),
      ],
      "all",
      CLIENT,
    );
    // Case-insensitive: the classified value is already lowercased, the row's
    // address is not.
    expect(rows.map((r) => r.id)).toEqual(["hit"]);
  });

  it("does not re-filter a query the server already applied", () => {
    // `prefix` means the gateway returned exactly the matching rows; narrowing
    // again on the raw address would drop a legitimate name-field match.
    const rows = filterSuppressionRows(
      [row({ id: "server-hit", email: "bob@example.com" })],
      "all",
      PREFIX,
    );
    expect(rows.map((r) => r.id)).toEqual(["server-hit"]);
  });

  it("combines the chip and the short query", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "both", email: "mac@example.com", reason: "hard_bounce" }),
        row({ id: "wrong-reason", email: "mac@x.com", reason: "complaint" }),
        row({ id: "wrong-email", email: "bob@x.com", reason: "hard_bounce" }),
      ],
      "hard_bounce",
      CLIENT,
    );
    expect(rows.map((r) => r.id)).toEqual(["both"]);
  });

  it("survives a missing page and a row with no address", () => {
    expect(filterSuppressionRows(undefined, "all", NONE)).toEqual([]);
    expect(
      filterSuppressionRows(
        [{ id: "no-email" } as SuppressionRow],
        "all",
        CLIENT,
      ),
    ).toEqual([]);
  });

  it("does not mutate the page it was handed", () => {
    const items = [
      row({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
      row({ id: "new", created_at: "2026-06-01T00:00:00Z" }),
    ];
    filterSuppressionRows(items, "all", NONE);
    expect(items.map((r) => r.id)).toEqual(["old", "new"]);
  });
});

describe("suppressionEmptyCopy", () => {
  it("says the workspace is empty when nothing was narrowed", () => {
    const copy = suppressionEmptyCopy(false);
    expect(copy.title).toBe("No suppressions");
    expect(copy.description).toMatch(/bounce or complain/u);
  });

  it("says the SEARCH is empty, and that it covered the whole archive", () => {
    const copy = suppressionEmptyCopy(true);
    expect(copy.title).toBe("Nothing matches");
    expect(copy.description).toMatch(/not just this page/u);
    expect(copy.title).not.toBe(suppressionEmptyCopy(false).title);
  });
});

describe("date window — mobile's translation of desktop's local date range", () => {
  // Fixed clock so every boundary below is exact, not flaky.
  const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

  it("narrows to the last 24 hours, excluding the row just past the boundary", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "fresh", created_at: "2026-08-28T11:00:00Z" }),
        row({ id: "edge", created_at: "2026-08-27T12:00:00Z" }),
        row({ id: "stale", created_at: "2026-08-27T11:59:59Z" }),
      ],
      "all",
      NONE,
      "24h",
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["fresh", "edge"]);
  });

  it("defaults to Any time, which changes nothing", () => {
    const items = [
      row({ id: "old", created_at: "2020-01-01T00:00:00Z" }),
      row({ id: "new", created_at: "2026-08-28T11:00:00Z" }),
    ];
    expect(filterSuppressionRows(items, "all", NONE).map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("excludes a row with no parseable date from every narrowed window", () => {
    // 'suppressed in the last 24 hours' is a positive claim a dateless row
    // cannot support; it still shows under Any time.
    expect(rowInDateWindow(undefined, "24h", NOW)).toBe(false);
    expect(rowInDateWindow("garbage", "7d", NOW)).toBe(false);
    expect(rowInDateWindow(undefined, "all", NOW)).toBe(true);
  });

  it("composes with the reason chip and the sub-3-char query", () => {
    const rows = filterSuppressionRows(
      [
        row({ id: "hit", email: "ace@x.com", reason: "hard_bounce", created_at: "2026-08-28T10:00:00Z" }),
        row({ id: "wrong-reason", email: "ace2@x.com", reason: "complaint", created_at: "2026-08-28T10:00:00Z" }),
        row({ id: "too-old", email: "ace3@x.com", reason: "hard_bounce", created_at: "2026-08-01T10:00:00Z" }),
      ],
      "hard_bounce",
      CLIENT,
      "24h",
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["hit"]);
  });

  it("guards a persisted key an older build may have written", () => {
    expect(suppressionDateWindowByKey("7d")).toBe("7d");
    expect(suppressionDateWindowByKey("last_fortnight")).toBe("all");
    expect(suppressionDateWindowByKey(undefined)).toBe("all");
  });

  it("keeps Any time first so the default chip is the unfiltered one", () => {
    expect(SUPPRESSION_DATE_WINDOWS[0]?.key).toBe("all");
  });
});
