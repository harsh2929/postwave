// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  buildLandingMetadata,
  buildPreviewHtml,
  escapeHtml,
  moveItem,
  parseContent,
  parseSeo,
  publicLandingUrl,
  serializeContent,
  serializeSeo,
  validateSeo,
  type LandingContent,
  type SeoFields,
} from "@/lib/landing-page-content";

describe("parseContent", () => {
  it("extracts hero heading/body and feature blocks", () => {
    const content = parseContent([
      { type: "hero", heading: "Big news", body: "We shipped it" },
      { type: "feature", heading: "Fast", body: "Very fast" },
      { type: "signup_form", button: "Join" },
      { type: "feature", title: "Cheap", content: "Low cost" },
    ]);
    expect(content.hero).toEqual({ heading: "Big news", body: "We shipped it" });
    expect(content.features).toHaveLength(2);
    expect(content.features[0]).toMatchObject({ heading: "Fast", body: "Very fast" });
    // title/content aliases are honored
    expect(content.features[1]).toMatchObject({ heading: "Cheap", body: "Low cost" });
    // each feature gets a stable client id
    expect(content.features[0].id).toBeTruthy();
    expect(content.features[0].id).not.toBe(content.features[1].id);
  });

  it("is defensive against null/malformed input", () => {
    expect(parseContent(null).hero).toEqual({ heading: "", body: "" });
    expect(parseContent(undefined).features).toEqual([]);
  });
});

describe("serializeContent (PATCH-replace safe)", () => {
  const content: LandingContent = {
    hero: { heading: "H", body: "B" },
    features: [
      { id: "x", heading: "F1", body: "b1" },
      { id: "y", heading: "F2", body: "b2" },
    ],
  };

  it("emits the COMPLETE block list: hero + features + signup", () => {
    const blocks = serializeContent(content, [
      { type: "hero", heading: "old" },
      { type: "signup_form", button: "Subscribe now" },
    ]);
    expect(blocks[0]).toEqual({ type: "hero", heading: "H", body: "B" });
    expect(blocks[1]).toMatchObject({ type: "feature", heading: "F1" });
    expect(blocks[2]).toMatchObject({ type: "feature", heading: "F2" });
    // the original signup_form (with its button label) is preserved, not dropped
    expect(blocks[3]).toEqual({ type: "signup_form", button: "Subscribe now" });
  });

  it("adds a default signup_form when none existed", () => {
    const blocks = serializeContent(content, []);
    expect(blocks[blocks.length - 1]).toMatchObject({ type: "signup_form" });
  });

  it("round-trips through parseContent without losing features", () => {
    const blocks = serializeContent(content, null);
    const reparsed = parseContent(blocks);
    expect(reparsed.hero).toEqual(content.hero);
    expect(reparsed.features.map((f) => f.heading)).toEqual(["F1", "F2"]);
  });
});

describe("moveItem", () => {
  it("reorders forward and backward", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });
  it("ignores out-of-range indices", () => {
    expect(moveItem([1, 2, 3], -1, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 0, 9)).toEqual([1, 2, 3]);
  });
});

describe("SEO parse/serialize/validate", () => {
  it("parses aliases", () => {
    const s = parseSeo({ title: "T", description: "D", canonical_url: "https://x.io", image: "https://x.io/a.png" });
    expect(s).toEqual({
      title: "T",
      description: "D",
      canonical: "https://x.io",
      ogImage: "https://x.io/a.png",
    });
  });

  it("omits empty fields on serialize", () => {
    const fields: SeoFields = { title: " ", description: "Hi", canonical: "", ogImage: "" };
    expect(serializeSeo(fields)).toEqual({ description: "Hi" });
  });

  it("flags over-long title/description and invalid URLs", () => {
    const errs = validateSeo({
      title: "x".repeat(80),
      description: "y".repeat(300),
      canonical: "not-a-url",
      ogImage: "ftp://nope",
    });
    expect(errs.title).toBeTruthy();
    expect(errs.description).toBeTruthy();
    expect(errs.canonical).toBeTruthy();
    expect(errs.ogImage).toBeTruthy();
  });

  it("passes valid input", () => {
    expect(
      validateSeo({ title: "Good", description: "Fine", canonical: "https://a.io", ogImage: "https://a.io/x.png" }),
    ).toEqual({});
  });
});

describe("publicLandingUrl", () => {
  it("returns a relative path when origin is empty (hydration-safe)", () => {
    expect(publicLandingUrl("", "welcome")).toBe("/landing/welcome");
    expect(publicLandingUrl(undefined, "welcome")).toBe("/landing/welcome");
  });
  it("joins origin + path and trims trailing slashes", () => {
    expect(publicLandingUrl("https://app.io/", "welcome")).toBe(
      "https://app.io/landing/welcome",
    );
  });
});

describe("buildLandingMetadata", () => {
  it("falls back to name and hero body when seo is empty", () => {
    const meta = buildLandingMetadata(
      {
        name: "Spring Sale",
        slug: "spring",
        blocks: [{ type: "hero", heading: "Sale", body: "Big discounts" }],
        seo: {},
      },
      "https://app.io",
    );
    expect(meta.title).toBe("Spring Sale");
    expect(meta.description).toBe("Big discounts");
    expect(meta.canonical).toBe("https://app.io/landing/spring");
    expect(meta.ogImage).toBeUndefined();
  });

  it("prefers explicit seo values", () => {
    const meta = buildLandingMetadata({
      name: "Spring Sale",
      slug: "spring",
      blocks: [],
      seo: { title: "Custom", description: "Custom desc", canonical: "https://x.io/p", og_image: "https://x.io/o.png" },
    });
    expect(meta.title).toBe("Custom");
    expect(meta.description).toBe("Custom desc");
    expect(meta.canonical).toBe("https://x.io/p");
    expect(meta.ogImage).toBe("https://x.io/o.png");
  });
});

describe("escapeHtml / buildPreviewHtml (XSS-safe)", () => {
  it("escapes angle brackets, quotes and ampersands", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;",
    );
  });

  it("never emits an unescaped script tag from author content", () => {
    const html = buildPreviewHtml({
      hero: { heading: "<script>alert(1)</script>", body: "<b>hi</b>" },
      features: [{ id: "1", heading: "<i>x</i>", body: "y" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("only renders up to 3 non-empty features", () => {
    const content: LandingContent = {
      hero: { heading: "H", body: "B" },
      features: [
        { id: "1", heading: "A", body: "" },
        { id: "2", heading: "B", body: "" },
        { id: "3", heading: "C", body: "" },
        { id: "4", heading: "D", body: "" },
        { id: "5", heading: "", body: "" },
      ],
    };
    const html = buildPreviewHtml(content);
    expect((html.match(/class="feature"/g) ?? []).length).toBe(3);
  });
});
