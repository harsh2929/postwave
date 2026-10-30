import { describe, expect, it } from "vitest";

import {
  BODY_SCAN_LIMIT,
  campaignBodyForPrediction,
  campaignHasBody,
  campaignPreviewText,
  hasDynamicRegions,
  htmlToText,
} from "./campaignBody";

describe("htmlToText", () => {
  it("strips tags and decodes the common entities", () => {
    expect(htmlToText("<p>Hi&nbsp;&amp; bye</p>")).toBe("Hi & bye");
    expect(htmlToText("<h1>A</h1><h1>B</h1>")).toBe("A\nB");
  });

  it("removes style and script blocks entirely", () => {
    expect(htmlToText("<style>.a{color:red}</style><p>Body</p>")).toBe("Body");
    expect(htmlToText("<script>alert(1)</script><p>Body</p>")).toBe("Body");
  });

  it("collapses runs of blank lines", () => {
    expect(htmlToText("<p>A</p><p></p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("BOUNDS the input before scanning — a huge body cannot cost unbounded work", () => {
    const huge = `${"<p>x</p>".repeat(100_000)}<p>TAIL</p>`;
    expect(huge.length).toBeGreaterThan(BODY_SCAN_LIMIT);
    const out = htmlToText(huge);
    // The tail beyond the scan window is never reached.
    expect(out).not.toContain("TAIL");
    expect(out.length).toBeLessThanOrEqual(BODY_SCAN_LIMIT);
  });

  it("honours an explicit limit", () => {
    expect(htmlToText("<p>abcdefghij</p>", 6)).toBe("abc");
  });

  it("handles an empty body", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("campaignPreviewText", () => {
  it("prefers plain_text over html", () => {
    expect(
      campaignPreviewText({ plain_text: "  plain  ", body_html: "<p>html</p>" }),
    ).toBe("plain");
  });

  it("falls back to html then mjml", () => {
    expect(campaignPreviewText({ body_html: "<p>html</p>" })).toBe("html");
    expect(campaignPreviewText({ body_mjml: "<mj-text>mj</mj-text>" })).toBe("mj");
  });

  it("returns null when there is no body at all", () => {
    expect(campaignPreviewText({})).toBeNull();
    expect(campaignPreviewText(null)).toBeNull();
    expect(campaignPreviewText({ plain_text: "   " })).toBeNull();
  });

  it("bounds an enormous plain-text body too", () => {
    const out = campaignPreviewText({ plain_text: "y".repeat(200_000) });
    expect(out).toHaveLength(BODY_SCAN_LIMIT);
  });
});

describe("campaignHasBody / campaignBodyForPrediction", () => {
  it("accepts all three persisted body forms", () => {
    expect(campaignHasBody({ body_mjml: "<mj/>" })).toBe(true);
    expect(campaignHasBody({ plain_text: "hi" })).toBe(true);
    expect(campaignHasBody({ body_html: "  " })).toBe(false);
    expect(campaignHasBody(null)).toBe(false);
  });

  it("prefers html for the placement predictor", () => {
    expect(
      campaignBodyForPrediction({ body_html: "<p>h</p>", body_mjml: "m" }),
    ).toBe("<p>h</p>");
    expect(campaignBodyForPrediction({ plain_text: "p" })).toBe("p");
    expect(campaignBodyForPrediction(null)).toBe("");
  });
});

describe("hasDynamicRegions", () => {
  it("detects composer region markers and template conditionals", () => {
    expect(hasDynamicRegions({ body_html: '<div data-pw-region="a">x</div>' })).toBe(
      true,
    );
    expect(hasDynamicRegions({ body_html: "{{#if vip}}x{{/if}}" })).toBe(true);
    expect(hasDynamicRegions({ body_html: "{{ if vip }}" })).toBe(true);
  });

  it("is false for a plain body", () => {
    expect(hasDynamicRegions({ body_html: "<p>Hello {{ name }}</p>" })).toBe(false);
    expect(hasDynamicRegions({})).toBe(false);
    expect(hasDynamicRegions(null)).toBe(false);
  });
});
