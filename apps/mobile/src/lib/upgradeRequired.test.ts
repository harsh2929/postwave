import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearUpgradeRequirement,
  getUpgradeRequirement,
  parseUpgradeRequired,
  reportUpgradeRequired,
  storeUrlsForPlatform,
  subscribeUpgradeRequirement,
} from "./upgradeRequired";

const PROBLEM = {
  title: "Upgrade required",
  status: 426,
  detail: "This app version is no longer supported. Please update to continue.",
  code: "upgrade_required",
  min_version: "1.4.0",
  current_version: "0.1.0",
  client: "mobile",
  request_id: "req_abc123",
};

beforeEach(() => {
  clearUpgradeRequirement();
});

describe("parseUpgradeRequired", () => {
  it("reads the gateway's problem+json document", () => {
    expect(parseUpgradeRequired(PROBLEM)).toEqual({
      minVersion: "1.4.0",
      currentVersion: "0.1.0",
      client: "mobile",
      requestId: "req_abc123",
      detail: PROBLEM.detail,
    });
  });

  it("accepts the raw JSON text as well as the parsed object", () => {
    expect(parseUpgradeRequired(JSON.stringify(PROBLEM))?.minVersion).toBe(
      "1.4.0",
    );
  });

  it("refuses any body that is not an upgrade_required problem", () => {
    expect(parseUpgradeRequired(null)).toBeNull();
    expect(parseUpgradeRequired("")).toBeNull();
    expect(parseUpgradeRequired("<html>426</html>")).toBeNull();
    expect(parseUpgradeRequired({ ...PROBLEM, code: "rate_limited" })).toBeNull();
    expect(parseUpgradeRequired([PROBLEM])).toBeNull();
  });

  it("drops fields that fail their grammar rather than rendering them", () => {
    const parsed = parseUpgradeRequired({
      code: "upgrade_required",
      min_version: "not a version",
      current_version: "1.2.3-canary.4",
      client: "MOBILE INJECTED",
      request_id: "bad id with spaces",
    });
    expect(parsed).toEqual({
      minVersion: null,
      currentVersion: "1.2.3-canary.4",
      client: null,
      requestId: null,
      detail: null,
    });
  });

  it("ignores an oversized body", () => {
    expect(parseUpgradeRequired("x".repeat(9_000))).toBeNull();
  });

  it("truncates nothing but rejects an over-long detail", () => {
    const parsed = parseUpgradeRequired({
      code: "upgrade_required",
      detail: "d".repeat(500),
    });
    expect(parsed?.detail).toBeNull();
  });
});

describe("storeUrlsForPlatform", () => {
  it("prefers the native store scheme then the https fallback on iOS", () => {
    expect(storeUrlsForPlatform("ios", { iosAppStoreId: "123456789" })).toEqual([
      "itms-apps://apps.apple.com/app/id123456789",
      "https://apps.apple.com/app/id123456789",
    ]);
  });

  it("falls back to a search URL when no App Store id is configured", () => {
    expect(storeUrlsForPlatform("ios")).toEqual([
      "https://apps.apple.com/search?term=Moosewave",
    ]);
    expect(storeUrlsForPlatform("ios", { iosAppStoreId: "abc" })).toEqual([
      "https://apps.apple.com/search?term=Moosewave",
    ]);
  });

  it("builds market:// and https Play links from the package id", () => {
    expect(
      storeUrlsForPlatform("android", { androidPackage: "com.moosewave.app" }),
    ).toEqual([
      "market://details?id=com.moosewave.app",
      "https://play.google.com/store/apps/details?id=com.moosewave.app",
    ]);
  });

  it("rejects a hostile package id", () => {
    expect(
      storeUrlsForPlatform("android", {
        androidPackage: "com.moosewave.app&x=https://evil",
      }),
    ).toEqual(["https://play.google.com/store/search?q=Moosewave&c=apps"]);
  });
});

describe("upgrade requirement store", () => {
  it("keeps the first requirement so parallel 426s do not thrash", () => {
    reportUpgradeRequired({ ...parseUpgradeRequired(PROBLEM)! });
    reportUpgradeRequired({
      minVersion: "9.9.9",
      currentVersion: null,
      client: null,
      requestId: null,
      detail: null,
    });
    expect(getUpgradeRequirement()?.minVersion).toBe("1.4.0");
  });

  it("notifies subscribers once on set and once on clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpgradeRequirement(listener);
    reportUpgradeRequired(parseUpgradeRequired(PROBLEM)!);
    expect(listener).toHaveBeenCalledTimes(1);
    reportUpgradeRequired(parseUpgradeRequired(PROBLEM)!);
    expect(listener).toHaveBeenCalledTimes(1);
    clearUpgradeRequirement();
    expect(listener).toHaveBeenCalledTimes(2);
    clearUpgradeRequirement();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
