// Tests for the deep-link → in-app path mapper. These are pure
// functions over a String → String mapping — no DOM, no fetch.

import { describe, expect, it } from "vitest";

import { buildDashboardHref, mapDeepLinkToPath } from "../lib/dashboard-url";

describe("mapDeepLinkToPath", () => {
  it("returns null for non-postwave URLs", () => {
    expect(mapDeepLinkToPath("https://app.moosewave.com/x")).toBeNull();
    expect(mapDeepLinkToPath("")).toBeNull();
    // @ts-expect-error — exercising the runtime guard
    expect(mapDeepLinkToPath(undefined)).toBeNull();
  });

  it("maps approval deep links to /app/approvals/<id>", () => {
    expect(mapDeepLinkToPath("moosewave://approval/abc-123")).toBe(
      "/app/approvals/abc-123",
    );
  });

  it("maps subscriber deep links and URL-encodes the email", () => {
    expect(mapDeepLinkToPath("moosewave://subscriber/foo+bar@example.com")).toBe(
      "/app/subscribers?email=foo%2Bbar%40example.com",
    );
  });

  it("maps campaign deep links to /app/campaigns/<id>", () => {
    expect(mapDeepLinkToPath("moosewave://campaign/CAMP_42")).toBe(
      "/app/campaigns/CAMP_42",
    );
  });

  it("maps sequence deep links to /app/sequences/<id>", () => {
    expect(mapDeepLinkToPath("moosewave://sequence/seq_42")).toBe(
      "/app/sequences/seq_42",
    );
  });

  it("maps settings to /app/settings", () => {
    expect(mapDeepLinkToPath("moosewave://settings")).toBe("/app/settings");
  });

  it("maps HubSpot migration credential return links and preserves state", () => {
    expect(
      mapDeepLinkToPath(
        "moosewave://migrations/api-key?source=hubspot&state=st_123",
      ),
    ).toBe("/app/migrations/api-key?source=hubspot&state=st_123");
  });

  it("maps ActiveCampaign migration credential return links and preserves state", () => {
    expect(
      mapDeepLinkToPath(
        "moosewave://migrations/api-key?source=activecampaign&state=st_456",
      ),
    ).toBe("/app/migrations/api-key?source=activecampaign&state=st_456");
  });

  it("maps Brevo migration API-key return links and preserves state", () => {
    expect(
      mapDeepLinkToPath("moosewave://migrate/brevo/api-key-entry?state=st_789"),
    ).toBe("/app/migrations/api-key?source=brevo&state=st_789");
  });

  it("returns null on unknown action", () => {
    expect(mapDeepLinkToPath("moosewave://nonsense/foo")).toBeNull();
  });

  it("rejects authority confusion, fragments, and non-canonical schemes", () => {
    for (const raw of [
      "POSTWAVE://approval/abc",
      "moosewave://user@approval/abc",
      "moosewave://approval:443/abc",
      "moosewave://approv%61l/abc",
      "moosewave://approval/abc#settings",
      "moosewave://approval/abc\\settings",
    ]) {
      expect(mapDeepLinkToPath(raw), raw).toBeNull();
    }
  });

  it("requires exact entity paths and rejects query widening", () => {
    for (const raw of [
      "moosewave://approval/abc/extra",
      "moosewave://approval/abc/",
      "moosewave://approval/abc?from=email",
      "moosewave://subscriber/..",
      "moosewave://subscriber/not+an+email",
      "moosewave://campaign/%2e%2e",
      "moosewave://campaign/abc%2Fsettings",
      "moosewave://campaign/%252e%252e",
      "moosewave://settings/extra",
      "moosewave://settings?next=campaigns",
    ]) {
      expect(mapDeepLinkToPath(raw), raw).toBeNull();
    }
  });

  it("rejects non-allowlisted, duplicate, or encoded migration parameters", () => {
    for (const raw of [
      "moosewave://migrations/api-key?source=unknown",
      "moosewave://migrations/api-key?source=hubspot&source=brevo",
      "moosewave://migrations/api-key?source=hubspot&next=settings",
      "moosewave://migrations/api-key?%73ource=hubspot",
      "moosewave://migrations/api-key?state=abc%250a",
      "moosewave://migrations/api-key?state=abc%0a",
      "moosewave://migrate/brevo/private-app-token?state=abc",
      "moosewave://migrate/brevo/api-key-entry?source=hubspot",
      `moosewave://migrations/api-key?state=${"a".repeat(257)}`,
    ]) {
      expect(mapDeepLinkToPath(raw), raw).toBeNull();
    }
  });

  it("caps the complete native deep-link payload", () => {
    expect(
      mapDeepLinkToPath(`moosewave://approval/${"a".repeat(8 * 1024)}`),
    ).toBeNull();
  });
});

describe("buildDashboardHref", () => {
  it("returns the base when no path is provided", () => {
    expect(buildDashboardHref("https://app.moosewave.com")).toBe(
      "https://app.moosewave.com",
    );
  });

  it("strips trailing slashes from the base", () => {
    expect(buildDashboardHref("https://app.moosewave.com/", "/x")).toBe(
      "https://app.moosewave.com/x",
    );
  });

  it("allows absolute same-origin dashboard URLs", () => {
    expect(
      buildDashboardHref(
        "https://app.moosewave.com",
        "https://app.moosewave.com/x",
      ),
    ).toBe("https://app.moosewave.com/x");
  });

  it("rejects absolute cross-origin or unsafe dashboard URLs", () => {
    expect(
      buildDashboardHref("https://app.moosewave.com", "https://other/x"),
    ).toBe("https://app.moosewave.com");
    expect(
      buildDashboardHref(
        "https://app.moosewave.com",
        "https://u:p@app.moosewave.com/x",
      ),
    ).toBe("https://app.moosewave.com");
    expect(
      buildDashboardHref(
        "https://app.moosewave.com",
        "http://app.moosewave.com/x",
      ),
    ).toBe("https://app.moosewave.com");
    expect(
      buildDashboardHref(
        "https://app.moosewave.com",
        "https://app.moosewave.com/x\nbad",
      ),
    ).toBe("https://app.moosewave.com");
  });

  it("translates moosewave:// deep links via mapDeepLinkToPath", () => {
    expect(
      buildDashboardHref("https://app.moosewave.com", "moosewave://approval/foo"),
    ).toBe("https://app.moosewave.com/app/approvals/foo");
  });

  it("falls back to base when deep link is invalid", () => {
    expect(
      buildDashboardHref("https://app.moosewave.com", "moosewave://garbage"),
    ).toBe("https://app.moosewave.com");
  });

  it("prepends a leading slash when the path lacks one", () => {
    expect(buildDashboardHref("https://app.moosewave.com", "campaigns/1")).toBe(
      "https://app.moosewave.com/campaigns/1",
    );
  });

  it("rejects unsafe relative dashboard paths", () => {
    expect(
      buildDashboardHref("https://app.moosewave.com", "//evil.example/x"),
    ).toBe("https://app.moosewave.com");
    expect(
      buildDashboardHref("https://app.moosewave.com", "javascript:alert(1)"),
    ).toBe("https://app.moosewave.com");
    expect(buildDashboardHref("https://app.moosewave.com", "/app\nx")).toBe(
      "https://app.moosewave.com",
    );
    expect(
      buildDashboardHref("https://app.moosewave.com", "/app\\settings"),
    ).toBe("https://app.moosewave.com");
  });
});
