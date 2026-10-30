// Tests for the pure podcast-feed URL logic behind PodcastTokensCard
// (backlog #52). Routes mirror apps/api/internal/podcast/podcast.go.

import { describe, expect, it } from "vitest";

import {
  isLikelyEmail,
  publicPodcastFeedUrl,
  readTenantSlug,
  tokenizedPodcastFeedUrl,
} from "../../components/archive/podcast-feed";
import { resolveMintedPodcastFeedUrl } from "../../components/archive/PodcastTokensCard";
import type { PodcastSubscriberToken } from "../../lib/api-client";

describe("podcast feed URL builders", () => {
  it("builds the public feed URL keyed on the tenant slug", () => {
    expect(publicPodcastFeedUrl("https://api.example.com/", "acme")).toBe(
      "https://api.example.com/api/public/podcast/acme/feed.xml",
    );
  });

  it("builds the tokenized feed URL with the token as a path segment", () => {
    expect(
      tokenizedPodcastFeedUrl("https://api.example.com", "acme", "tok_AbC123"),
    ).toBe(
      "https://api.example.com/api/public/podcast/acme/feed/tok_AbC123.xml",
    );
  });

  it("URL-encodes slug + token", () => {
    expect(tokenizedPodcastFeedUrl("https://x.io", "a/b", "t/k")).toBe(
      "https://x.io/api/public/podcast/a%2Fb/feed/t%2Fk.xml",
    );
  });

  it("prefers the one-time server URL and otherwise derives it from the token", () => {
    expect(
      resolveMintedPodcastFeedUrl(
        { feed_url: "https://feeds.example/private" } as PodcastSubscriberToken,
        "acme",
        "https://api.example.com",
      ),
    ).toBe("https://feeds.example/private");
    expect(
      resolveMintedPodcastFeedUrl(
        { token: "secret" } as PodcastSubscriberToken,
        "acme",
        "https://api.example.com",
      ),
    ).toBe("https://api.example.com/api/public/podcast/acme/feed/secret.xml");
    expect(resolveMintedPodcastFeedUrl(null, "acme")).toBeNull();
  });
});

describe("readTenantSlug", () => {
  const storageWith = (v: string | null): Pick<Storage, "getItem"> => ({
    getItem: () => v,
  });

  it("returns the slugified stored value", () => {
    expect(readTenantSlug(storageWith("Acme Newsletter"))).toBe(
      "acme-newsletter",
    );
  });

  it("returns null when unset or blank", () => {
    expect(readTenantSlug(storageWith(null))).toBeNull();
    expect(readTenantSlug(storageWith("   "))).toBeNull();
    expect(readTenantSlug(undefined)).toBeNull();
  });

  it("swallows storage exceptions (Tauri webview privacy modes)", () => {
    const throwing: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readTenantSlug(throwing)).toBeNull();
  });
});

describe("isLikelyEmail", () => {
  it("accepts normal addresses and trims whitespace", () => {
    expect(isLikelyEmail("a@b.co")).toBe(true);
    expect(isLikelyEmail("  a@b.co  ")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isLikelyEmail("")).toBe(false);
    expect(isLikelyEmail("nope")).toBe(false);
    expect(isLikelyEmail("a@b")).toBe(false);
    expect(isLikelyEmail("a b@c.io")).toBe(false);
  });
});
