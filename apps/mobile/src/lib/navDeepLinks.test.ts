import { describe, expect, it } from "vitest";

import {
  knownNavLinkSlugs,
  routeForNavLink,
  routeForNavSlug,
} from "./navDeepLinks";
import { MOBILE_SECONDARY_ROUTES } from "./mobileRouteManifest";

describe("routeForNavSlug", () => {
  it("resolves every secondary route by its manifest key", () => {
    for (const route of MOBILE_SECONDARY_ROUTES) {
      expect(routeForNavSlug(route.key)).toBe(route.route);
    }
  });

  it("resolves the five bottom tabs", () => {
    expect(routeForNavSlug("dashboard")).toBe("/(tabs)/dashboard");
    expect(routeForNavSlug("subscribers")).toBe("/(tabs)/subscribers");
    expect(routeForNavSlug("campaigns")).toBe("/(tabs)/campaigns");
    expect(routeForNavSlug("approvals")).toBe("/(tabs)/approvals");
    expect(routeForNavSlug("more")).toBe("/(tabs)/more");
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    expect(routeForNavSlug("  DMARC ")).toBe("/(tabs)/dmarc");
  });

  it("returns null for an unknown slug rather than guessing a path", () => {
    expect(routeForNavSlug("wat")).toBeNull();
    expect(routeForNavSlug("")).toBeNull();
    expect(routeForNavSlug("../settings")).toBeNull();
  });

  it("covers materially more destinations than route-map's four entities", () => {
    expect(knownNavLinkSlugs().length).toBeGreaterThan(30);
  });
});

describe("routeForNavLink — moosewave:// scheme", () => {
  it("resolves a bare destination host", () => {
    expect(routeForNavLink("moosewave://dmarc")).toBe("/(tabs)/dmarc");
    expect(routeForNavLink("moosewave://audit-sinks")).toBe(
      "/(tabs)/audit-sinks",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(routeForNavLink("moosewave://suppressions/")).toBe(
      "/(tabs)/suppressions",
    );
  });

  it("rejects extra path segments instead of truncating them", () => {
    // Landing on the tag list would imply tag 42 is what is on screen.
    expect(routeForNavLink("moosewave://tags/42")).toBeNull();
  });

  it("never steals an auth link", () => {
    expect(routeForNavLink("moosewave://auth/magic?p=1")).toBeNull();
    expect(routeForNavLink("moosewave://auth")).toBeNull();
  });

  it("rejects the desktop-only API playground", () => {
    expect(routeForNavLink("moosewave://api-playground")).toBeNull();
  });

  it("rejects a port", () => {
    expect(routeForNavLink("moosewave://dmarc:8080")).toBeNull();
  });
});

describe("routeForNavLink — universal links", () => {
  it("resolves /app/<slug> on a trusted host", () => {
    expect(routeForNavLink("https://app.moosewave.com/app/audit")).toBe(
      "/(tabs)/audit",
    );
  });

  it("rejects an untrusted host", () => {
    expect(routeForNavLink("https://evil.example/app/audit")).toBeNull();
    expect(
      routeForNavLink("https://app.moosewave.com.evil/app/audit"),
    ).toBeNull();
  });

  it("rejects http", () => {
    expect(routeForNavLink("http://app.moosewave.com/app/audit")).toBeNull();
  });

  it("leaves entity-shaped paths alone", () => {
    // /app/campaigns/<id> is route-map's job; three segments must not match.
    expect(
      routeForNavLink("https://app.moosewave.com/app/campaigns/abc"),
    ).toBeNull();
  });

  it("rejects a trusted web link to the desktop-only API playground", () => {
    expect(
      routeForNavLink("https://app.moosewave.com/app/api-playground"),
    ).toBeNull();
  });

  it("rejects embedded credentials and fragments", () => {
    expect(
      routeForNavLink("https://u:p@app.moosewave.com/app/audit"),
    ).toBeNull();
    expect(routeForNavLink("https://app.moosewave.com/app/audit#x")).toBeNull();
  });

  it("rejects a non-URL, an empty string and an oversized string", () => {
    expect(routeForNavLink("")).toBeNull();
    expect(routeForNavLink("not a url")).toBeNull();
    expect(routeForNavLink(`moosewave://${"a".repeat(4000)}`)).toBeNull();
  });
});
