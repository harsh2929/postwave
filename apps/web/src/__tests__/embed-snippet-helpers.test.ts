import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBED_OPTIONS,
  iframeSnippet,
  inlineSnippet,
  normalizeHeight,
  normalizeWidth,
  parseTargetPaths,
  popupSnippet,
  type EmbedOptions,
} from "@/lib/embed-snippet-helpers";

const opts = (over: Partial<EmbedOptions> = {}): EmbedOptions => ({
  ...DEFAULT_EMBED_OPTIONS,
  ...over,
});

describe("normalizeWidth", () => {
  it("turns a bare number into px", () => {
    expect(normalizeWidth("480")).toEqual({ value: "480px" });
  });
  it("passes valid CSS widths through", () => {
    expect(normalizeWidth("100%")).toEqual({ value: "100%" });
    expect(normalizeWidth("auto")).toEqual({ value: "auto" });
    expect(normalizeWidth("30rem")).toEqual({ value: "30rem" });
  });
  it("errors on garbage instead of silently coercing", () => {
    expect("error" in normalizeWidth("abc")).toBe(true);
    expect("error" in normalizeWidth("")).toBe(true);
  });
});

describe("normalizeHeight", () => {
  it("accepts pixels only", () => {
    expect(normalizeHeight("520")).toEqual({ value: "520" });
    expect(normalizeHeight("640px")).toEqual({ value: "640" });
  });
  it("rejects non-pixel/garbage values (no silent 520 fallback)", () => {
    expect("error" in normalizeHeight("abc")).toBe(true);
    expect("error" in normalizeHeight("50%")).toBe(true);
  });
});

describe("parseTargetPaths", () => {
  it("splits, trims, and root-anchors paths", () => {
    expect(parseTargetPaths("/pricing, blog\n/docs")).toEqual([
      "/pricing",
      "/blog",
      "/docs",
    ]);
  });
  it("returns [] for empty input", () => {
    expect(parseTargetPaths("   ")).toEqual([]);
  });
});

describe("snippet builders", () => {
  it("iframe snippet uses validated dims and escapes the src", () => {
    const snip = iframeSnippet("https://f.example.com/", "a/b", opts({ width: "480", height: "600" }));
    expect(snip).toContain('src="https://f.example.com/forms/a%2Fb"');
    expect(snip).toContain('width="480px"');
    expect(snip).toContain('height="600"');
  });

  it("iframe snippet falls back to defaults for invalid dims (does not emit garbage)", () => {
    const snip = iframeSnippet("https://f.example.com", "s", opts({ width: "abc", height: "xyz" }));
    expect(snip).toContain('width="100%"');
    expect(snip).toContain('height="520"');
  });

  it("popup snippet omits frequency/paths when unset", () => {
    const snip = popupSnippet("https://f.example.com", "s", opts());
    expect(snip).not.toContain("frequency-days");
    expect(snip).not.toContain("popup-paths");
    expect(snip).toContain('data-postwave-mode="popup"');
  });

  it("popup snippet emits frequency cap + page targeting when set (FORM-037)", () => {
    const snip = popupSnippet(
      "https://f.example.com",
      "s",
      opts({ frequencyDays: 7, targetPaths: "/pricing, /blog" }),
    );
    expect(snip).toContain('data-postwave-popup-frequency-days="7"');
    expect(snip).toContain('data-postwave-popup-paths="/pricing,/blog"');
  });

  it("escapes attribute-breaking characters in the slug", () => {
    const snip = inlineSnippet("https://f.example.com", 'x"><b', opts());
    expect(snip).not.toContain('"><b"');
    expect(snip).toContain("&quot;&gt;&lt;b");
  });
});
