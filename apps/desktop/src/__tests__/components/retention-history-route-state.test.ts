import { describe, expect, it } from "vitest";

import type { DesktopRoute } from "../../lib/desktop-router";
import { serializeDesktopRoute } from "../../lib/desktop-router";
import {
  canonicalRetentionHistoryRoute,
  isCanonicalRetentionHistoryRoute,
  retentionHistoryViewFromRoute,
  retentionOfferDetailRouteId,
  routeWithRetentionHistoryView,
  routeWithRetentionOfferDetail,
  routeWithoutRetentionOfferDetail,
} from "../../components/retention/retention-history-route";

const OFFER_ID = "20000000-0000-4000-8000-000000000001";

describe("retention history route state", () => {
  it("round-trips every supported list control through one canonical URL", () => {
    const route = routeWithRetentionHistoryView(
      { section: "retentionOffers" },
      {
        tab: "history",
        query: "high intent",
        status: "active",
        discount: "fixed",
        evidence: "anomaly",
        sort: "accepted-desc",
        page: 3,
      },
    );

    expect(retentionHistoryViewFromRoute(route)).toEqual({
      tab: "history",
      query: "high intent",
      status: "active",
      discount: "fixed",
      evidence: "anomaly",
      sort: "accepted-desc",
      page: 3,
    });
    expect(serializeDesktopRoute(route)).toBe(
      "/app/retention-offers?tab=history&q=high+intent&sort=accepted&dir=desc&f.discount=fixed&f.evidence=anomaly&f.page=3&f.status=active",
    );
    expect(isCanonicalRetentionHistoryRoute(route)).toBe(true);
  });

  it("omits every default from the URL", () => {
    expect(
      routeWithRetentionHistoryView(
        { section: "retentionOffers" },
        {
          tab: "overview",
          query: "   ",
          status: "all",
          discount: "all",
          evidence: "all",
          sort: "newest",
          page: 1,
        },
      ),
    ).toEqual({ section: "retentionOffers" });
  });

  it("round-trips the recently updated sort as an explicit non-default", () => {
    const route = routeWithRetentionHistoryView(
      { section: "retentionOffers" },
      {
        tab: "history",
        query: "",
        status: "all",
        discount: "all",
        evidence: "all",
        sort: "updated-desc",
        page: 1,
      },
    );

    expect(serializeDesktopRoute(route)).toBe(
      "/app/retention-offers?tab=history&sort=updated&dir=desc",
    );
    expect(retentionHistoryViewFromRoute(route).sort).toBe("updated-desc");
  });

  it("fails closed on unsupported tokens and strips unknown retention filters", () => {
    const malformed: DesktopRoute = {
      section: "retentionOffers",
      tab: "surprise",
      query: "verified query",
      sort: { field: "tier", direction: "desc" },
      filters: [
        { key: "status", value: "secret-state" },
        { key: "discount", value: "currency-copy" },
        { key: "evidence", value: "claimed" },
        { key: "page", value: "999" },
        { key: "headline", value: "raw customer-facing copy" },
        { key: "provider-ref", value: "coupon_secret_1" },
      ],
      overlay: { name: "unowned-retention-surface" },
    };

    expect(retentionHistoryViewFromRoute(malformed)).toEqual({
      tab: "overview",
      query: "verified query",
      status: "all",
      discount: "all",
      evidence: "all",
      sort: "newest",
      page: 1,
    });
    expect(isCanonicalRetentionHistoryRoute(malformed)).toBe(false);
    const canonical = canonicalRetentionHistoryRoute(malformed);
    expect(canonical).toEqual({
      section: "retentionOffers",
      query: "verified query",
    });
    const url = serializeDesktopRoute(canonical);
    expect(url).not.toMatch(
      /secret-state|currency-copy|claimed|raw|coupon_secret/u,
    );
  });

  it("removes explicit default encodings instead of retaining duplicate states", () => {
    const route: DesktopRoute = {
      section: "retentionOffers",
      tab: "overview",
      sort: { field: "recorded", direction: "desc" },
      filters: [
        { key: "status", value: "all" },
        { key: "discount", value: "all" },
        { key: "evidence", value: "all" },
        { key: "page", value: "1" },
      ],
    };

    expect(isCanonicalRetentionHistoryRoute(route)).toBe(false);
    expect(canonicalRetentionHistoryRoute(route)).toEqual({
      section: "retentionOffers",
    });
  });

  it("opens and closes detail without losing any list state", () => {
    const base = routeWithRetentionHistoryView(
      { section: "retentionOffers" },
      {
        tab: "history",
        query: "founder",
        status: "inactive",
        discount: "percent",
        evidence: "zero",
        sort: "oldest",
        page: 4,
      },
    );
    const detail = routeWithRetentionOfferDetail(base, OFFER_ID);

    expect(retentionOfferDetailRouteId(detail)).toBe(OFFER_ID);
    expect(detail).toMatchObject({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: OFFER_ID,
      },
    });
    expect(routeWithoutRetentionOfferDetail(detail)).toEqual(base);
  });

  it("normalizes a legacy resource deep link into the explicit history overlay", () => {
    const legacy: DesktopRoute = {
      section: "retentionOffers",
      resourceId: OFFER_ID.toUpperCase(),
      query: "member",
      filters: [{ key: "status", value: "active" }],
    };
    const canonical = canonicalRetentionHistoryRoute(legacy);

    expect(canonical).toEqual({
      section: "retentionOffers",
      tab: "history",
      query: "member",
      filters: [{ key: "status", value: "active" }],
      overlay: {
        name: "retention-offer-detail",
        resourceId: OFFER_ID,
      },
    });
    expect(canonical.resourceId).toBeUndefined();
  });

  it("removes malformed detail identities instead of rendering an ambiguous record", () => {
    const route: DesktopRoute = {
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "not-a-retention-uuid",
      },
    };

    expect(retentionOfferDetailRouteId(route)).toBeNull();
    expect(canonicalRetentionHistoryRoute(route)).toEqual({
      section: "retentionOffers",
      tab: "history",
    });
  });
});
