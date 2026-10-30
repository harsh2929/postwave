import { afterEach, describe, expect, it, vi } from "vitest";

import sitemap from "@/app/sitemap";

describe("marketing sitemap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is empty until a public release record is approved", async () => {
    vi.stubEnv("POSTWAVE_PUBLIC_RELEASE_APPROVAL", "");
    await expect(sitemap()).resolves.toEqual([]);
  });

  it("indexes public controlled migration guides", async () => {
    vi.stubEnv("POSTWAVE_PUBLIC_RELEASE_APPROVAL", "approved:RELEASE-TEST");
    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls).toContain("https://moosewave.com/migrations/activecampaign");
    expect(urls).toContain("https://moosewave.com/migrations/hubspot");
    expect(urls.some((url) => url.includes("/legal/"))).toBe(false);
    expect(urls.some((url) => url.includes("/vs"))).toBe(false);
    expect(urls.some((url) => url.includes("/affiliates"))).toBe(false);
  });
});
