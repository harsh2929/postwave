import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeForNavLink } from "./navDeepLinks";

/**
 * DASHBOARD#49 — the widget's tap targets.
 *
 * A `.widgetURL` that the JS side cannot parse is WORSE than no widgetURL:
 * instead of opening the app to the last route, it opens the app to the last
 * route AND fires the "couldn't open that link" toast. The Swift constants and
 * the JS link grammar are in two languages that no compiler checks against
 * each other, so the contract is pinned here: every URL the widget can hand
 * the OS must resolve to a real mobile route.
 */
const swift = readFileSync(
  join(process.cwd(), "targets/widget/index.swift"),
  "utf8",
);

function widgetURLs(): string[] {
  return [...swift.matchAll(/"(postwave:\/\/[^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("widget tap-target contract", () => {
  it("declares at least the dashboard and approvals destinations", () => {
    const urls = widgetURLs();
    expect(urls).toContain("moosewave://dashboard");
    expect(urls).toContain("moosewave://approvals");
  });

  it("resolves every URL the Swift target can emit", () => {
    const urls = widgetURLs();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(routeForNavLink(url), `${url} did not resolve`).not.toBeNull();
    }
  });

  it("resolves them to routes the tab tree actually has", () => {
    expect(routeForNavLink("moosewave://dashboard")).toBe("/(tabs)/dashboard");
    expect(routeForNavLink("moosewave://approvals")).toBe("/(tabs)/approvals");
  });
});
