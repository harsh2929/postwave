import { describe, expect, it } from "vitest";

import {
  MIN_QUERY,
  searchEmptyCopy,
  searchFooterNotice,
  SEARCH_OFFLINE_NOTICE,
} from "./searchScreenCopy";

describe("searchFooterNotice", () => {
  it("says nothing when the results are complete and whole", () => {
    expect(searchFooterNotice(false, false)).toBeNull();
  });

  it("warns that a source never answered", () => {
    expect(searchFooterNotice(true, false)).toBe(
      "Some sources didn't answer, so these results may be incomplete.",
    );
  });

  it("offers to narrow a truncated result set", () => {
    expect(searchFooterNotice(false, true)).toBe(
      "Showing the first matches — refine your search to narrow them.",
    );
  });

  it("prefers 'incomplete' over 'truncated' when both are true", () => {
    // Only one line fits, and the reader needs the one saying the result set
    // may be WRONG rather than merely short.
    expect(searchFooterNotice(true, true)).toBe(searchFooterNotice(true, false));
    expect(searchFooterNotice(true, true)).not.toBe(
      searchFooterNotice(false, true),
    );
  });
});

describe("searchEmptyCopy", () => {
  it("only claims 'No matches.' once the server was actually asked", () => {
    expect(searchEmptyCopy(true)).toBe("No matches.");
  });

  it("prompts for more characters below the query floor", () => {
    const copy = searchEmptyCopy(false);
    expect(copy).not.toContain("No matches");
    expect(copy).toContain(`at least ${MIN_QUERY} characters`);
  });
});

describe("SEARCH_OFFLINE_NOTICE", () => {
  it("says the local half of the screen still works", () => {
    // A bare "you're offline" would read as though the whole screen had
    // stopped; the "Go to" palette is local and unaffected.
    expect(SEARCH_OFFLINE_NOTICE).toContain("still work offline");
  });

  it("is not an empty-result claim", () => {
    expect(SEARCH_OFFLINE_NOTICE).not.toContain("No matches");
  });
});

describe("MIN_QUERY", () => {
  it("is a positive floor, so a single keystroke never hits the server", () => {
    expect(MIN_QUERY).toBeGreaterThan(1);
  });
});
