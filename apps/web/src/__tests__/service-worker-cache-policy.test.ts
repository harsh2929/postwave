import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isAuthSensitiveNavigation,
  isAuthSensitiveRequest,
  isCacheCandidate,
  isPublicArchiveApiCacheCandidate,
  shouldCacheNavigation,
} from "@/app/sw-cache-policy";

beforeEach(() => {
  vi.stubGlobal("location", { origin: "https://app.postwave.test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker cache policy", () => {
  it("adds the offline document through Serwist's precache contract", () => {
    const config = readFileSync(
      resolve(process.cwd(), "next.config.mjs"),
      "utf8",
    );

    expect(config).toContain("additionalPrecacheEntries");
    expect(config).toContain('url: "/offline"');
    // The revision must VARY between deploys. Serwist keys precache entries on
    // url+revision and skips re-download when the revision is unchanged, so a
    // string literal froze /offline at whatever the first service-worker
    // install fetched — a document referencing hashed CSS that later deploys
    // replaced. Assert the property (derived, not literal) rather than the
    // exact expression, so tightening how the build id is sourced does not
    // need a test edit.
    expect(config).toMatch(/revision:\s*process\.env\.POSTWAVE_BUILD_ID/);
    expect(config).not.toMatch(/revision:\s*"offline-v\d+"/);
    expect(config).toContain('!asset.name.startsWith("static/css/")');
    expect(config).not.toContain("manifestTransforms:");
  });

  it("caches reviewed static assets but leaves Next chunks to the browser", () => {
    const icon = new Request("https://app.postwave.test/icons/icon-192.png");
    expect(isCacheCandidate(icon, new URL(icon.url))).toBe(true);

    const chunk = new Request(
      "https://app.postwave.test/_next/static/chunks/94553-abc.js",
    );
    expect(isCacheCandidate(chunk, new URL(chunk.url))).toBe(false);
  });

  it("refuses API, sensitive-query, cross-origin, and authorized requests", () => {
    const api = new Request("https://app.postwave.test/api/v1/assets/logo.png");
    expect(isCacheCandidate(api, new URL(api.url))).toBe(false);

    const tokenized = new Request(
      "https://app.postwave.test/assets/logo.png?stream_token=pws_secret",
    );
    expect(isCacheCandidate(tokenized, new URL(tokenized.url))).toBe(false);

    const crossOrigin = new Request("https://cdn.example.test/logo.png");
    expect(isCacheCandidate(crossOrigin, new URL(crossOrigin.url))).toBe(false);

    const authorized = new Request("https://app.postwave.test/logo.png", {
      headers: { authorization: "Bearer pw_secret" },
    });
    expect(isCacheCandidate(authorized, new URL(authorized.url))).toBe(false);
  });

  it("caches only reviewed archive APIs, never token-in-path public data", () => {
    const archive = new Request(
      "https://app.postwave.test/api/public/archive/acme",
    );
    expect(
      isPublicArchiveApiCacheCandidate(archive, new URL(archive.url)),
    ).toBe(true);

    for (const path of [
      "/api/public/preferences/pref_secret",
      "/api/public/gifts/gift_secret",
      "/api/public/podcast/acme/feed/bearer_secret.xml",
      "/api/share/future_secret",
    ]) {
      const request = new Request(`https://app.postwave.test${path}`);
      expect(
        isPublicArchiveApiCacheCandidate(request, new URL(request.url)),
        path,
      ).toBe(false);
      expect(isCacheCandidate(request, new URL(request.url)), path).toBe(false);
    }
  });

  it("keeps authenticated and auth-flow navigations network-only", () => {
    for (const path of [
      "/app",
      "/app/campaigns",
      "/login",
      "/signup",
      "/magic-link",
      "/totp-challenge",
      "/reset-password",
      "/cli/auth",
    ]) {
      const url = new URL(`https://app.postwave.test${path}`);
      const request = navigationRequest(url);
      expect(isAuthSensitiveNavigation(url), path).toBe(true);
      expect(shouldCacheNavigation(request, url), path).toBe(false);
    }
  });

  // The bug this suite could not see: every assertion above tests a pure
  // helper with a synthetic `mode: "navigate"` request. Serwist matches
  // first-rule-wins WITH FALL-THROUGH, so a request the helpers refuse is not
  // network-only — it keeps falling until `...defaultCache`, whose last two
  // entries store every same-origin non-/api GET for 24h. `shouldCacheNavigation`
  // returning false therefore proved nothing about whether the response was
  // stored. These tests assert the composed route table, not just the helpers.
  it("routes Next RSC payload fetches for /app as auth-sensitive", () => {
    // Next requests RSC payloads and <Link> prefetches with mode "cors", never
    // "navigate". A guard gated on navigations misses every client-side
    // navigation inside the dashboard.
    const url = new URL("https://app.postwave.test/app/subscribers");
    const request = new Request(url, { headers: { RSC: "1" } });

    expect(request.mode).not.toBe("navigate");
    expect(isAuthSensitiveRequest(request, url)).toBe(true);
    expect(isCacheCandidate(request, url)).toBe(false);
  });

  it("treats credential-bearing auth routes as auth-sensitive", () => {
    for (const path of [
      "/accept-invite",
      "/browser-auth",
      "/browser-auth/reset",
    ]) {
      const url = new URL(`https://app.postwave.test${path}?token=pws_secret`);
      const request = navigationRequest(url);
      expect(isAuthSensitiveNavigation(url), path).toBe(true);
      expect(isAuthSensitiveRequest(request, url), path).toBe(true);
      expect(isCacheCandidate(request, url), path).toBe(false);
    }
  });

  it("terminates refused requests before Serwist's defaultCache catch-alls", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/sw.ts"),
      "utf8",
    );

    const denyAt = source.indexOf("!isCacheCandidate(request, url)");
    const defaultAt = source.indexOf("...defaultCache");

    expect(denyAt, "terminal NetworkOnly deny rule is missing").toBeGreaterThan(
      -1,
    );
    expect(defaultAt).toBeGreaterThan(-1);
    // Ordering is the whole control: behind defaultCache the deny is dead code.
    expect(denyAt).toBeLessThan(defaultAt);
  });

  it("allows public navigations without sensitive query values", () => {
    const url = new URL("https://app.postwave.test/pricing");
    const request = navigationRequest(url);
    expect(shouldCacheNavigation(request, url)).toBe(true);

    const tokenized = new URL(
      "https://app.postwave.test/pricing?token=pws_secret",
    );
    expect(shouldCacheNavigation(request, tokenized)).toBe(false);
  });
});

function navigationRequest(url: URL): Request {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}
