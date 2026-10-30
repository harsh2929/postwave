import { describe, expect, it } from "vitest";

import type { DesktopRoute } from "../../lib/desktop-router";
import {
  isCanonicalSubscribersRouteView,
  routeWithSubscribersView,
  subscribersRouteView,
  subscribersRouteViewSignature,
} from "../../pages/subscribers/subscribers-route-state";
import {
  routeWithSubscriberDetail,
  routeWithoutSubscriberDetail,
  subscriberDetailRouteId,
} from "../../pages/subscribers/subscriber-detail-route";

describe("Subscribers route-backed directory state", () => {
  it("restores validated query, filter, archive, paging, and sort state", () => {
    const route: DesktopRoute = {
      section: "subscribers",
      tab: "directory",
      query: "enterprise",
      sort: { field: "churn-score", direction: "asc" },
      filters: [
        { key: "status", value: "unconfirmed" },
        { key: "archived", value: "true" },
        { key: "page", value: "7" },
      ],
    };

    expect(subscribersRouteView(route)).toEqual({
      query: "enterprise",
      filter: "unconfirmed",
      showArchived: true,
      page: 7,
      sortColumn: "churn_score",
      sortOrder: "asc",
      savedSegmentId: null,
    });
  });

  it("fails closed to safe defaults for malformed subscriber state", () => {
    const malformed: DesktopRoute = {
      section: "subscribers",
      sort: { field: "secret-field", direction: "asc" },
      filters: [
        { key: "status", value: "enabled-by-surprise" },
        { key: "archived", value: "yes" },
        { key: "page", value: "99999999" },
      ],
    };
    expect(subscribersRouteView(malformed)).toEqual({
      query: "",
      filter: "all",
      showArchived: false,
      page: 1,
      sortColumn: "updated_at",
      sortOrder: "desc",
      savedSegmentId: null,
    });
    expect(isCanonicalSubscribersRouteView(malformed)).toBe(false);
    expect(
      routeWithSubscribersView(malformed, subscribersRouteView(malformed)),
    ).toEqual({ section: "subscribers", sort: undefined, filters: undefined });
  });

  it("writes only non-default view state and preserves unrelated route intent", () => {
    const next = routeWithSubscribersView(
      {
        section: "subscribers",
        tab: "directory",
        overlay: { name: "import" },
        filters: [{ key: "cohort", value: "west" }],
      },
      {
        query: "  high intent  ",
        filter: "subscribed",
        showArchived: true,
        page: 3,
        sortColumn: "first_name",
        sortOrder: "desc",
        savedSegmentId: "segment-7",
      },
    );

    expect(next).toEqual({
      section: "subscribers",
      tab: "directory",
      overlay: { name: "import" },
      query: "high intent",
      sort: { field: "first-name", direction: "desc" },
      filters: [
        { key: "cohort", value: "west" },
        { key: "status", value: "subscribed" },
        { key: "archived", value: "true" },
        { key: "page", value: "3" },
        { key: "saved-view", value: "segment-7" },
      ],
    });
    expect(isCanonicalSubscribersRouteView(next)).toBe(true);
  });

  it("produces the same comparison signature for normalized equivalents", () => {
    expect(
      subscribersRouteViewSignature({
        query: "  reader  ",
        filter: "all",
        showArchived: false,
        page: 0,
        sortColumn: "unsupported",
        sortOrder: "desc",
        savedSegmentId: null,
      }),
    ).toBe(
      subscribersRouteViewSignature({
        query: "reader",
        filter: "all",
        showArchived: false,
        page: 1,
        sortColumn: "updated_at",
        sortOrder: "desc",
        savedSegmentId: null,
      }),
    );
  });

  it("round-trips active saved-view identity and rejects malformed identity", () => {
    const route: DesktopRoute = {
      section: "subscribers",
      filters: [{ key: "saved-view", value: "segment_42" }],
    };
    expect(subscribersRouteView(route).savedSegmentId).toBe("segment_42");
    expect(isCanonicalSubscribersRouteView(route)).toBe(true);

    const malformed: DesktopRoute = {
      section: "subscribers",
      filters: [{ key: "saved-view", value: "../other-workspace" }],
    };
    expect(subscribersRouteView(malformed).savedSegmentId).toBeNull();
    expect(isCanonicalSubscribersRouteView(malformed)).toBe(false);
  });

  it("keeps detail as a route-owned overlay and preserves the directory view", () => {
    const base: DesktopRoute = {
      section: "subscribers",
      tab: "directory",
      query: "reader",
      filters: [{ key: "status", value: "subscribed" }],
    };
    const detail = routeWithSubscriberDetail(base, "subscriber-42");
    expect(detail).toEqual({
      ...base,
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    expect(subscriberDetailRouteId(detail)).toBe("subscriber-42");
    expect(routeWithoutSubscriberDetail(detail)).toEqual(base);
    expect(
      subscriberDetailRouteId({
        section: "subscribers",
        resourceId: "subscriber-from-deep-link",
      }),
    ).toBe("subscriber-from-deep-link");
  });
});
