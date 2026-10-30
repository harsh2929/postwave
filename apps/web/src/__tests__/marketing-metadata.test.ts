import { describe, expect, it } from "vitest";

import { pageMetadata, safeMarketingPath } from "@/lib/marketing-metadata";

describe("marketing metadata helpers", () => {
  it("keeps canonical paths relative to the public site", () => {
    expect(safeMarketingPath("/pricing")).toBe("/pricing");
    expect(safeMarketingPath("/migrations/mailchimp?utm=docs")).toBe(
      "/migrations/mailchimp?utm=docs",
    );

    expect(safeMarketingPath("https://evil.example/pricing")).toBe("");
    expect(safeMarketingPath("//evil.example/pricing")).toBe("");
    expect(safeMarketingPath("/../admin")).toBe("");
    expect(safeMarketingPath("/%2e%2e/admin")).toBe("");
    expect(safeMarketingPath("/pricing\nx")).toBe("");
  });

  it("omits canonical metadata when a path is unsafe", () => {
    const metadata = pageMetadata({
      title: "Pricing",
      description: "Plans",
      path: "//evil.example/pricing",
    });

    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph?.url).toBeUndefined();
  });
});
