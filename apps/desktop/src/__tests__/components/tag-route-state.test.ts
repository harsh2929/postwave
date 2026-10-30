import { describe, expect, it } from "vitest";

import type { DesktopRoute } from "../../lib/desktop-router";
import {
  routeWithTagDetail,
  routeWithoutTagDetail,
  routeWithTagView,
  tagDetailRouteId,
  tagViewFromRoute,
} from "../../pages/tags/tagRouteState";

describe("tag route state", () => {
  it("round-trips query, colour, page, and sort without losing an overlay", () => {
    const route: DesktopRoute = {
      section: "tags",
      overlay: { name: "tag-detail", resourceId: "tag-1" },
      filters: [{ key: "future", value: "retained" }],
    };
    const next = routeWithTagView(route, {
      query: "vip",
      color: "rose",
      group: "group-1",
      page: 3,
      sortField: "subscribers",
      sortDirection: "desc",
    });

    expect(next.overlay).toEqual(route.overlay);
    expect(next.filters).toEqual([
      { key: "future", value: "retained" },
      { key: "color", value: "rose" },
      { key: "group", value: "group-1" },
      { key: "page", value: "3" },
    ]);
    expect(tagViewFromRoute(next)).toEqual({
      query: "vip",
      color: "rose",
      group: "group-1",
      page: 3,
      sortField: "subscribers",
      sortDirection: "desc",
    });
  });

  it("keeps defaults out of the URL model and rejects malformed local values", () => {
    const malformed: DesktopRoute = {
      section: "tags",
      filters: [
        { key: "color", value: "BAD VALUE" },
        { key: "page", value: "0" },
      ],
      sort: { field: "unknown", direction: "desc" },
    };
    expect(tagViewFromRoute(malformed)).toEqual({
      query: "",
      color: "all",
      group: "",
      page: 1,
      sortField: "name",
      sortDirection: "desc",
    });

    expect(
      routeWithTagView(
        { section: "tags" },
        tagViewFromRoute({ section: "tags" }),
      ),
    ).toEqual({
      section: "tags",
      query: undefined,
      filters: undefined,
      sort: undefined,
    });
  });

  it("opens and closes one detail overlay while preserving the exact list view", () => {
    const base: DesktopRoute = {
      section: "tags",
      query: "customer",
      filters: [{ key: "color", value: "teal" }],
      sort: { field: "created", direction: "desc" },
    };
    const detail = routeWithTagDetail(base, "tag-1");

    expect(tagDetailRouteId(detail)).toBe("tag-1");
    expect(routeWithoutTagDetail(detail)).toEqual(base);
    expect(tagDetailRouteId(routeWithoutTagDetail(detail))).toBeNull();
  });

  it("normalizes a legacy resource route into the explicit detail overlay", () => {
    const legacy: DesktopRoute = { section: "tags", resourceId: "tag-old" };
    expect(tagDetailRouteId(legacy)).toBe("tag-old");
    const normalized = routeWithTagDetail(legacy, "tag-new");
    expect(normalized.resourceId).toBeUndefined();
    expect(normalized.overlay).toEqual({
      name: "tag-detail",
      resourceId: "tag-new",
    });
  });
});
