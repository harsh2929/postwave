// Guards filesystem-backed blog loading from path-like slugs. Route params
// should already be single path segments, but this keeps the helper safe for
// sitemap/RSS callers too.

import { describe, expect, it } from "vitest";

import { isValidBlogSlug } from "@/lib/blog";

describe("blog loader", () => {
  it("accepts canonical blog slugs", () => {
    expect(isValidBlogSlug("migrating-from-mailchimp-without-losing-tags")).toBe(
      true,
    );
  });

  it("rejects path-like and hidden-file slugs", () => {
    expect(isValidBlogSlug("../secret")).toBe(false);
    expect(isValidBlogSlug("nested/post")).toBe(false);
    expect(isValidBlogSlug(".env")).toBe(false);
  });
});
