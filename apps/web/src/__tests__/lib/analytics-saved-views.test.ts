// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-39 — the saved-views contract: a view is the Analytics URL state
// (range, tab + lib/analytics-view-params' metric/focus/compare/group_by), it
// round-trips through the URL, and storage is scoped by workspace AND user.

import { describe, expect, it } from "vitest";

import {
  MAX_SAVED_VIEWS,
  readAnalyticsViewState,
  readSavedViews,
  sanitizeSavedViews,
  savedViewHref,
  savedViewNameProblem,
  savedViewsStorageKey,
  writeSavedViews,
  type SavedView,
  type SavedViewsStore,
} from "@/lib/analytics-saved-views";

function memoryStore(): SavedViewsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const VIEW: SavedView = {
  id: "v-1",
  name: "Weekly opens",
  range: "7d",
  tab: "campaign",
  metric: "opens",
  focus: "grouped-breakdown",
  compare: false,
  groupBy: "domain",
};

describe("saved view ⇄ URL", () => {
  it("writes every saved field into the Analytics URL", () => {
    const href = savedViewHref(VIEW);
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/app/analytics");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      range: "7d",
      tab: "campaign",
      metric: "opens",
      focus: "grouped-breakdown",
      compare: "off",
      group_by: "domain",
    });
  });

  it("round-trips: reading the href back gives the saved state", () => {
    const { search } = new URL(savedViewHref(VIEW), "http://localhost");
    const { id: _id, name: _name, ...state } = VIEW;
    expect(readAnalyticsViewState(search)).toEqual(state);
  });

  it("drops params that are page defaults and keeps unrelated ones", () => {
    const href = savedViewHref(
      {
        range: "30d",
        tab: "overview",
        metric: null,
        focus: null,
        compare: true,
        groupBy: null,
      },
      "?range=90d&metric=clicks&compare=off&group_by=campaign&utm=x",
    );
    expect(href).toBe("/app/analytics?utm=x");
  });
});

describe("storage", () => {
  it("is scoped by workspace and user", () => {
    const store = memoryStore();
    writeSavedViews("tenant-a", "user-1", [VIEW], store);
    expect([...store.data.keys()]).toEqual([
      "postwave.web.analytics-saved-views.v1:tenant-a:user-1",
    ]);
    expect(savedViewsStorageKey("tenant-a", "user-1")).toBe(
      "postwave.web.analytics-saved-views.v1:tenant-a:user-1",
    );
    expect(readSavedViews("tenant-a", "user-1", store)).toEqual([VIEW]);
    expect(readSavedViews("tenant-a", "user-2", store)).toEqual([]);
    expect(readSavedViews("tenant-b", "user-1", store)).toEqual([]);
  });

  it("a corrupt or foreign value reads as no views, never a crash", () => {
    const store = memoryStore();
    store.data.set(savedViewsStorageKey("t", "u"), "{not json");
    expect(readSavedViews("t", "u", store)).toEqual([]);
    store.data.set(savedViewsStorageKey("t", "u"), JSON.stringify({ a: 1 }));
    expect(readSavedViews("t", "u", store)).toEqual([]);
    expect(readSavedViews("t", "u", null)).toEqual([]);
  });

  it("throws when there is no storage to write to", () => {
    expect(() => writeSavedViews("t", "u", [VIEW], null)).toThrow(
      "This browser isn't letting Moosewave save views here.",
    );
  });

  it("sanitizes: drops malformed and duplicate views, caps the list, normalizes fields", () => {
    const many = Array.from({ length: MAX_SAVED_VIEWS + 5 }, (_, i) => ({
      ...VIEW,
      id: `v-${i}`,
    }));
    expect(sanitizeSavedViews(many)).toHaveLength(MAX_SAVED_VIEWS);
    const cleaned = sanitizeSavedViews([
      { ...VIEW, id: "" },
      { ...VIEW, range: "365d" },
      { ...VIEW, name: "bad\u0007name" },
      { ...VIEW, compare: "no" },
      VIEW,
      { ...VIEW, name: "dupe" },
      {
        ...VIEW,
        id: "v-2",
        tab: "nope",
        metric: "open_rate",
        focus: "Not A Chart!",
        groupBy: "list",
      },
    ]);
    expect(cleaned.map((v) => v.id)).toEqual(["v-1", "v-2"]);
    expect(cleaned[1]).toMatchObject({
      tab: "overview",
      metric: "opens",
      focus: null,
      groupBy: null,
    });
  });
});

describe("naming", () => {
  it("requires a unique, non-empty, bounded name", () => {
    expect(savedViewNameProblem("  ", [])).toBe("Give the view a name.");
    expect(savedViewNameProblem("x".repeat(61), [])).toBe(
      "Keep the name to 60 characters or fewer.",
    );
    expect(savedViewNameProblem("weekly OPENS", [VIEW])).toBe(
      "You already have a view with that name.",
    );
    expect(savedViewNameProblem("Monthly", [VIEW])).toBeNull();
  });
});

it("round-trips grouped metric and window through saved browser storage and URL", () => {
  const store = memoryStore();
  const view: SavedView = {
    ...VIEW,
    breakdownMetric: "clicks",
    breakdownDays: 90,
  };
  writeSavedViews("tenant", "user", [view], store);
  const [saved] = readSavedViews("tenant", "user", store);
  const search = new URL(savedViewHref(saved), "http://localhost").search;
  expect(readAnalyticsViewState(search)).toMatchObject({
    breakdownMetric: "clicks",
    breakdownDays: 90,
  });
});
