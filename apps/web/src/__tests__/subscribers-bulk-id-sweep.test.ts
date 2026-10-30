// SPDX-License-Identifier: AGPL-3.0-only
//
// "Select all matching" turns a filter into concrete subscriber ids by walking
// the list endpoint. At the 10k bulk cap that is 50 pages, and it used to walk
// them strictly one after another — 50 serialized round trips before the bulk
// action even started, with no progress signal.
//
// These tests pin the three properties a windowed sweep must keep: it really
// does overlap requests, the ids stay in page order, and both stop conditions
// (the cap, and a short page meaning "no more rows") still hold.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BULK_ID_FETCH_CONCURRENCY,
  collectIdsPaged,
} from "@/app/(dashboard)/app/subscribers/subscribers-list-helpers";

/** A fetchPage stub that records how many calls are in flight at once. */
function trackingFetcher(pageRows: (page: number) => string[]) {
  const state = { inFlight: 0, maxInFlight: 0, pages: [] as number[] };
  const fetchPage = async (page: number) => {
    state.pages.push(page);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    // Yield twice so overlapping calls have a chance to be observed.
    await Promise.resolve();
    await Promise.resolve();
    state.inFlight -= 1;
    const ids = pageRows(page);
    return { ids, count: ids.length };
  };
  return { state, fetchPage };
}

const fullPage = (per: number) => (page: number) =>
  Array.from({ length: per }, (_, i) => `p${page}-${i}`);

describe("collectIdsPaged", () => {
  it("overlaps page requests instead of walking them one at a time", async () => {
    const per = 200;
    const { state, fetchPage } = trackingFetcher(fullPage(per));

    await collectIdsPaged(fetchPage, { total: 2_000, per, cap: 10_000 });

    expect(state.pages).toHaveLength(10);
    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(state.maxInFlight).toBeLessThanOrEqual(BULK_ID_FETCH_CONCURRENCY);
  });

  it("keeps ids in page order across the concurrency window", async () => {
    const per = 2;
    const { fetchPage } = trackingFetcher((page) => [`p${page}-a`, `p${page}-b`]);

    const ids = await collectIdsPaged(fetchPage, {
      total: 8,
      per,
      cap: 100,
      concurrency: 4,
    });

    expect(ids).toEqual([
      "p1-a",
      "p1-b",
      "p2-a",
      "p2-b",
      "p3-a",
      "p3-b",
      "p4-a",
      "p4-b",
    ]);
  });

  it("stops at the cap and returns exactly that many ids", async () => {
    const per = 200;
    const { fetchPage } = trackingFetcher(fullPage(per));

    const ids = await collectIdsPaged(fetchPage, {
      total: 50_000,
      per,
      cap: 1_000,
    });

    expect(ids).toHaveLength(1_000);
  });

  it("stops at a short page and drops rows fetched beyond it", async () => {
    const per = 10;
    // Page 2 comes back short: the result set ended there. Pages 3+ were
    // fetched in the same wave and must not contribute.
    const { fetchPage } = trackingFetcher((page) =>
      page === 2
        ? ["p2-a", "p2-b"]
        : Array.from({ length: per }, (_, i) => `p${page}-${i}`),
    );

    const ids = await collectIdsPaged(fetchPage, {
      total: 200,
      per,
      cap: 10_000,
      concurrency: 5,
    });

    expect(ids).toHaveLength(12);
    expect(ids.some((id) => id.startsWith("p3-"))).toBe(false);
  });

  it("still asks for one page when the total is unknown (0)", async () => {
    const { state, fetchPage } = trackingFetcher(() => ["only"]);

    const ids = await collectIdsPaged(fetchPage, {
      total: 0,
      per: 200,
      cap: 10_000,
    });

    expect(state.pages).toEqual([1]);
    expect(ids).toEqual(["only"]);
  });
});

// The list table renders two dates per row across 50 rows, so building a fresh
// Intl.DateTimeFormat inside each call meant ~100 formatter constructions on
// every keystroke in the search box. `toLocaleDateString(undefined, {...})` and
// `toLocaleString()` do exactly that — the formatter they build internally is
// not cached across differing option objects — so this asserts on the source:
// the helpers must format through a hoisted Intl.DateTimeFormat.
describe("subscribers list date formatters are hoisted", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "src/app/(dashboard)/app/subscribers/subscribers-list-helpers.ts",
    ),
    "utf8",
  );

  // Comments mentioning the old API are fine; calls on a Date are not.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("constructs the formatters outside the per-call path", () => {
    expect(code).toContain("new Intl.DateTimeFormat");
    expect(code).not.toMatch(/\bd\.toLocaleDateString\(/);
    expect(code).not.toMatch(/\bd\.toLocaleString\(/);
  });
});
