import { describe, expect, it } from "vitest";

import {
  decodeEntities,
  htmlToParagraphs,
  previewWasTruncated,
  readingMinutes,
} from "./archivePreviewText";

describe("decodeEntities", () => {
  it("decodes the named entities that appear in prose", () => {
    expect(decodeEntities("Ben &amp; Jerry&rsquo;s &mdash; today")).toBe(
      "Ben & Jerry’s — today",
    );
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeEntities("&#8212;&#x2014;")).toBe("——");
  });

  it("leaves an unknown entity verbatim rather than guessing", () => {
    expect(decodeEntities("&notarealentity; &#xZZ;")).toBe(
      "&notarealentity; &#xZZ;",
    );
  });

  it("refuses lone surrogates and out-of-range codepoints", () => {
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;");
  });
});

describe("htmlToParagraphs", () => {
  it("drops style and script CONTENT instead of flattening it into prose", () => {
    const html =
      "<style>.a{color:red}</style><script>var x=1;</script><p>Hello there</p>";
    expect(htmlToParagraphs(html)).toEqual(["Hello there"]);
  });

  it("splits block-level markup into separate paragraphs", () => {
    const html = "<h1>Issue 12</h1><p>First para</p><p>Second para</p>";
    expect(htmlToParagraphs(html)).toEqual([
      "Issue 12",
      "First para",
      "Second para",
    ]);
  });

  it("keeps <br> as a soft line break inside one paragraph", () => {
    expect(htmlToParagraphs("<p>Line one<br/>Line two</p>")).toEqual([
      "Line one\nLine two",
    ]);
  });

  it("keeps link targets, which is the whole point of previewing an issue", () => {
    expect(
      htmlToParagraphs('<p>Read <a href="https://x.test/a">the post</a></p>'),
    ).toEqual(["Read the post (https://x.test/a)"]);
  });

  it("does not repeat a target the anchor text already contains", () => {
    expect(
      htmlToParagraphs('<p><a href="https://x.test/a">https://x.test/a</a></p>'),
    ).toEqual(["https://x.test/a"]);
  });

  it("leaves in-page anchors and mailto links alone", () => {
    expect(
      htmlToParagraphs(
        '<p><a href="#top">Top</a> <a href="mailto:a@b.test">Mail</a></p>',
      ),
    ).toEqual(["Top Mail"]);
  });

  it("strips Outlook conditional comments", () => {
    expect(
      htmlToParagraphs("<p>Body<!--[if mso]><table><![endif]--></p>"),
    ).toEqual(["Body"]);
  });

  it("returns an empty list for markup with no prose so the caller can say so", () => {
    expect(htmlToParagraphs("<style>.a{color:red}</style>")).toEqual([]);
    expect(htmlToParagraphs("")).toEqual([]);
  });

  it("caps the paragraph count and reports the truncation", () => {
    const html = Array.from({ length: 12 }, (_, i) => `<p>P${i}</p>`).join("");
    expect(htmlToParagraphs(html, 5)).toHaveLength(5);
    expect(previewWasTruncated(html, 5)).toBe(true);
    expect(previewWasTruncated(html, 20)).toBe(false);
  });
});

describe("readingMinutes", () => {
  it("returns null — never 0 — when there was nothing to read", () => {
    expect(readingMinutes([])).toBeNull();
    expect(readingMinutes(["   "])).toBeNull();
  });

  it("rounds up to at least one minute for short issues", () => {
    expect(readingMinutes(["a few words only"])).toBe(1);
  });

  it("scales with word count", () => {
    const words = Array.from({ length: 660 }, () => "word").join(" ");
    expect(readingMinutes([words])).toBe(3);
  });
});
