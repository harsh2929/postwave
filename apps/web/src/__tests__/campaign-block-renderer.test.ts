import { describe, expect, it } from "vitest";

import {
  campaignBlockLinkError,
  campaignHTMLLinkError,
  campaignPlainTextLinkError,
  campaignSemanticLinkError,
  renderCampaignBlocksToHTML,
  renderCampaignBlocksToText,
  safeEmailAssetURL,
  safeEmailLinkURL,
} from "@/lib/campaign-block-renderer";

describe("campaign block renderer", () => {
  it("escapes text, attributes, and product image alt text", () => {
    const html = renderCampaignBlocksToHTML([
      { type: "heading", content: `<script>alert(1)</script>` },
      {
        type: "product",
        title: `Starter "Kit" <b>`,
        image_url: "https://cdn.example.test/product.png#fragment",
        price: `<strong>$9</strong>`,
      },
    ]);

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<strong>$9</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Starter &quot;Kit&quot; &lt;b&gt;");
    expect(html).toContain('alt="Starter &quot;Kit&quot; &lt;b&gt;"');
    expect(html).toContain('src="https://cdn.example.test/product.png"');
  });

  it("drops unsafe URLs and template tokens the send path cannot resolve", () => {
    const html = renderCampaignBlocksToHTML([
      { type: "button", label: "Bad", url: "javascript:alert(1)" },
      { type: "image", url: "file:///tmp/a.png" },
      { type: "image", image_url: "{{ logo_url }}" },
      { type: "button", label: "Prefs", url: "{{ preferences_url }}" },
    ]);

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file://");
    expect(html).toContain("<p>Bad</p>");
    expect(html).not.toContain("logo_url");
    expect(html).not.toContain("preferences_url");
    expect(html).toContain("<p>Prefs</p>");
  });

  it("never materializes example.com or empty-link fallbacks for incomplete blocks", () => {
    const html = renderCampaignBlocksToHTML([
      { type: "button", label: "Read" },
      { type: "product", title: "Product" },
      { type: "product_recommendations", product_1_title: "One" },
      { type: "discount_code", label: "Redeem" },
      { type: "survey", choices: ["Yes", "No"] },
      { type: "image", url: "https://example.com/placeholder.png" },
      {
        type: "video",
        title: "Demo",
        thumbnail_url: "https://cdn.example.test/demo.png",
      },
    ]);

    expect(html).not.toContain("example.com");
    expect(html).not.toContain('href=""');
    expect(html).toContain("Read");
    expect(html).toContain("Demo");
  });

  it("rejects dormant unsafe and placeholder source before persistence", () => {
    expect(
      campaignBlockLinkError([
        { type: "button", url: "https://example.com/buy" },
      ]),
    ).toContain("still points to example.com");
    expect(
      campaignBlockLinkError([
        { type: "product", url: "java&#x73;cript:alert(1)" },
      ]),
    ).toContain("must be a safe absolute");
    expect(
      campaignBlockLinkError([
        { type: "button", url: "https://shop.example.test/buy" },
      ]),
    ).toBeNull();

    expect(
      campaignHTMLLinkError(
        '<a href="java&#x73;cript:alert(1)">bad</a>',
      ),
    ).toContain("must be a safe absolute");
    expect(
      campaignHTMLLinkError('<a href="https://example.com/offer">bad</a>'),
    ).toContain("still points to example.com");
    expect(
      campaignHTMLLinkError('<a href="{{ unsubscribe_url }}">Leave</a>'),
    ).toBeNull();
    expect(campaignPlainTextLinkError("Visit https://example.com/offer")).toContain(
      "example.com placeholder",
    );
    expect(
      campaignSemanticLinkError([
        {
          type: "action",
          content: {
            action: { canonical_url: "https://example.com/semantic" },
          },
        },
      ]),
    ).toContain("/canonical_url still points to example.com");
  });

  it("keeps plain-text rendering free of HTML wrappers", () => {
    expect(
      renderCampaignBlocksToText([
        { type: "heading", content: "Title" },
        { type: "button", label: "CTA", url: "https://example.test" },
      ]),
    ).toBe("Title\n\nCTA https://example.test/");
  });

  it("renders commerce, survey, and video blocks without leaking foreign conditional syntax", () => {
    const html = renderCampaignBlocksToHTML([
      {
        type: "product_recommendations",
        title: "Picked for you",
        product_1_title: "Starter",
        product_1_url: "https://example.test/starter",
      },
      { type: "discount_code", code: "SAVE20", url: "https://example.test" },
      {
        type: "survey",
        question: "How was it?",
        choices: "Great,Needs work",
        url: "https://example.test/survey",
      },
      {
        type: "video",
        video_url: "https://youtu.be/abc",
        thumbnail_url: "https://img.example.test/abc.jpg",
        title: "Demo",
      },
      {
        type: "conditional_content",
        condition: "FNAME",
        content: "Hello *|FNAME|*",
        fallback: "Hello",
      },
    ]);

    expect(html).toContain("Picked for you");
    expect(html).toContain("SAVE20");
    expect(html).toContain("How was it?");
    expect(html).toContain("https://img.example.test/abc.jpg");
    expect(html).toContain("<p>Hello</p>");
    expect(html).not.toContain("*|IF:");
  });

  it("normalizes URL helpers consistently", () => {
    expect(safeEmailLinkURL("https://u:p@example.test")).toBe("");
    expect(safeEmailLinkURL("mailto:hello@example.test#frag")).toBe(
      "mailto:hello@example.test",
    );
    expect(safeEmailAssetURL("//cdn.example.test/logo.png")).toBe("");
    expect(safeEmailLinkURL(`https://example.test/${"x".repeat(3000)}`)).toBe(
      "",
    );
    expect(safeEmailLinkURL("https://example.com/placeholder")).toBe("");
    expect(safeEmailAssetURL("https://example.com/placeholder.png")).toBe("");
    expect(
      safeEmailLinkURL("https://example.test/\nBcc: victim@example.test"),
    ).toBe("");
  });

  it("caps rendered block count and text length", () => {
    const html = renderCampaignBlocksToHTML(
      Array.from({ length: 120 }, (_, i) => ({
        type: "heading",
        content: i === 0 ? "x".repeat(12_000) : `Heading ${i}`,
      })),
    );

    expect(html).toContain("x".repeat(10_000));
    expect(html).not.toContain("x".repeat(10_001));
    expect(html).toContain("Heading 99");
    expect(html).not.toContain("Heading 100");
  });
});
