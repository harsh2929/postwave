import { describe, expect, it } from "vitest";

import {
  subscriberCountLine,
  subscriberCountNoun,
} from "./subscriberCountLine";

const base = {
  loaded: 25,
  serverTotal: undefined as number | undefined,
  isSearching: false,
  filterNoun: "",
  hasNextPage: false,
};

describe("subscriberCountNoun", () => {
  it("calls search hits results, not subscribers", () => {
    expect(subscriberCountNoun({ isSearching: true, filterNoun: "" })).toBe(
      "result",
    );
    // Search wins over the filter noun: you are counting matches.
    expect(
      subscriberCountNoun({ isSearching: true, filterNoun: "unsubscribed" }),
    ).toBe("result");
  });

  it("carries the status-filter noun", () => {
    expect(
      subscriberCountNoun({ isSearching: false, filterNoun: "unsubscribed" }),
    ).toBe("unsubscribed subscriber");
    expect(subscriberCountNoun({ isSearching: false, filterNoun: "" })).toBe(
      "subscriber",
    );
  });
});

describe("subscriberCountLine", () => {
  it("never presents a page as the workspace", () => {
    expect(
      subscriberCountLine({ ...base, loaded: 25, serverTotal: 1340 }),
    ).toBe("Showing 25 of 1,340 subscribers");
  });

  it("drops the 'showing' framing once everything is loaded", () => {
    expect(subscriberCountLine({ ...base, loaded: 12, serverTotal: 12 })).toBe(
      "12 subscribers",
    );
  });

  it("singularises one", () => {
    expect(subscriberCountLine({ ...base, loaded: 1, serverTotal: 1 })).toBe(
      "1 subscriber",
    );
  });

  it("uses the filter noun", () => {
    expect(
      subscriberCountLine({
        ...base,
        loaded: 3,
        serverTotal: 3,
        filterNoun: "unsubscribed",
      }),
    ).toBe("3 unsubscribed subscribers");
  });

  it("counts search hits as results", () => {
    expect(
      subscriberCountLine({
        ...base,
        loaded: 3,
        serverTotal: 3,
        isSearching: true,
      }),
    ).toBe("3 results");
  });

  it("invents no total when the server sent none", () => {
    expect(
      subscriberCountLine({ ...base, loaded: 40, serverTotal: undefined }),
    ).toBe("40 loaded");
    expect(
      subscriberCountLine({
        ...base,
        loaded: 40,
        serverTotal: undefined,
        hasNextPage: true,
      }),
    ).toBe("40 loaded · scroll for more");
  });

  it("does not claim 'showing N of M' when the total under-counts the page", () => {
    // A stale/over-deleted total can come back BELOW the loaded count; the
    // line must not read "Showing 25 of 10".
    expect(
      subscriberCountLine({ ...base, loaded: 25, serverTotal: 10 }),
    ).toBe("10 subscribers");
  });
});
