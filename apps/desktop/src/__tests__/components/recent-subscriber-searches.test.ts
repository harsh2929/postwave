// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRecentSubscriberSearches,
  getRecentSubscriberSearches,
  pushRecentSubscriberSearch,
} from "../../components/subscribers/recent-searches";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
  localStorage.clear();
  sessionStorage.clear();
  clearRecentSubscriberSearches();
});

afterEach(() => {
  clearRecentSubscriberSearches();
  vi.useRealTimers();
});

describe("private recent subscriber searches", () => {
  it("never serializes emails and purges plaintext records from older builds", () => {
    localStorage.setItem(
      "pw.subscribers.recentSearches.v1",
      JSON.stringify(["legacy@example.com"]),
    );
    sessionStorage.setItem(
      "pw.subscribers.recentSearches.v1",
      JSON.stringify(["legacy@example.com"]),
    );

    pushRecentSubscriberSearch("scope-a", "person@example.com");

    expect(getRecentSubscriberSearches("scope-a")).toEqual([
      "person@example.com",
    ]);
    expect(localStorage.getItem("pw.subscribers.recentSearches.v1")).toBeNull();
    expect(
      sessionStorage.getItem("pw.subscribers.recentSearches.v1"),
    ).toBeNull();
    expect(
      `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`,
    ).not.toContain("person@example.com");
  });

  it("clears the ring on workspace change instead of retaining per-scope PII", () => {
    pushRecentSubscriberSearch("scope-a", "alpha@example.com");
    expect(getRecentSubscriberSearches("scope-b")).toEqual([]);
    pushRecentSubscriberSearch("scope-b", "beta@example.com");
    expect(getRecentSubscriberSearches("scope-a")).toEqual([]);
  });

  it("deduplicates, bounds, rejects malformed input, and expires the ring", () => {
    for (let index = 0; index < 8; index += 1) {
      pushRecentSubscriberSearch("scope-a", `person-${index}@example.com`);
    }
    pushRecentSubscriberSearch("scope-a", " PERSON-7@example.com ");
    pushRecentSubscriberSearch("scope-a", "x".repeat(257));
    pushRecentSubscriberSearch("scope-a", "unsafe\nquery");

    expect(getRecentSubscriberSearches("scope-a")).toEqual([
      "PERSON-7@example.com",
      "person-6@example.com",
      "person-5@example.com",
      "person-4@example.com",
      "person-3@example.com",
    ]);

    vi.advanceTimersByTime(8 * 60 * 60 * 1000 + 1);
    expect(getRecentSubscriberSearches("scope-a")).toEqual([]);
  });
});
