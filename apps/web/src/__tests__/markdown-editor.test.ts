import { describe, expect, it } from "vitest";

import {
  markdownToHtml,
  normalizeEditorHref,
} from "@/components/editor/markdown";

describe("markdownToHtml", () => {
  it("renders safe links with escaped text and noreferrer", () => {
    expect(markdownToHtml("[Moosewave](https://moosewave.com?a=1&b=2)")).toBe(
      '<p><a href="https://moosewave.com/?a=1&amp;b=2" rel="noreferrer">Moosewave</a></p>',
    );
  });

  it("drops unsafe markdown links instead of creating active anchors", () => {
    expect(markdownToHtml("[bad](javascript:alert)")).toBe("<p>bad</p>");
    expect(markdownToHtml("[bad](https://u:p@example.com/path)")).toBe(
      "<p>bad</p>",
    );
  });

  it("escapes non-link text before seeding the editor", () => {
    expect(markdownToHtml("hello <script>x</script>")).toBe(
      "<p>hello &lt;script&gt;x&lt;/script&gt;</p>",
    );
  });

  it("preserves level-one headings, block quotes, and fenced code", () => {
    expect(
      markdownToHtml(
        "# Launch notes\n\n> Keep this quoted\n> on two lines\n\n```html\n<strong>literal</strong>\n```",
      ),
    ).toBe(
      '<h1>Launch notes</h1><blockquote><p>Keep this quoted</p><p>on two lines</p></blockquote><pre><code class="language-html">&lt;strong&gt;literal&lt;/strong&gt;</code></pre>',
    );
  });
});

describe("normalizeEditorHref", () => {
  it("allows browser-safe marketing links", () => {
    expect(normalizeEditorHref(" https://moosewave.com/path ")).toBe(
      "https://moosewave.com/path",
    );
    expect(normalizeEditorHref("mailto:billing@moosewave.com")).toBe(
      "mailto:billing@moosewave.com",
    );
  });

  it("rejects script, credentialed, and malformed links", () => {
    expect(normalizeEditorHref("javascript:alert(1)")).toBeNull();
    expect(normalizeEditorHref("https://u:p@example.com")).toBeNull();
    expect(normalizeEditorHref("not a url")).toBeNull();
  });
});
