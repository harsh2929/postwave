/**
 * The rendered-preview readers, and the two safety properties the WebView
 * relies on: every displayed document carries the lockdown CSP, and the
 * cross-client tiles only ever fetch https images.
 */
import { describe, expect, it } from "vitest";

import {
  isolatedPreviewDocument,
  readCrossClientRenders,
  readEmailRender,
} from "./campaignRenderPreview";

describe("readEmailRender", () => {
  it("keys previews by client and keeps warnings + renderer", () => {
    const reading = readEmailRender({
      previews: {
        gmail: "<p>g</p>",
        outlook: "<p>o</p>",
        apple: "",
        junk: "<p>ignored</p>",
      },
      warnings: ["images blocked", 42],
      renderer: "mjml",
    });
    expect(reading).not.toBeNull();
    expect(reading!.previews.gmail).toBe("<p>g</p>");
    expect(reading!.previews.apple).toBeUndefined();
    expect(
      (reading!.previews as Record<string, unknown>).junk,
    ).toBeUndefined();
    expect(reading!.warnings).toEqual(["images blocked"]);
    expect(reading!.renderer).toBe("mjml");
  });
  it("null for a non-object", () => {
    expect(readEmailRender(null)).toBeNull();
  });
});

describe("isolatedPreviewDocument — the CSP is non-negotiable", () => {
  it("injects the lockdown CSP into a document with a head", () => {
    const doc = isolatedPreviewDocument("<html><head></head><body>x</body></html>", 600);
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('width=600');
  });
  it("wraps a bare fragment in a full document, CSP included", () => {
    const doc = isolatedPreviewDocument("<p>hello</p>", 375);
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("width=375");
    expect(doc).toContain("<p>hello</p>");
  });
  it("never narrows the viewport below 320", () => {
    expect(isolatedPreviewDocument("<p>x</p>", 10)).toContain("width=320");
  });
});

describe("readCrossClientRenders", () => {
  it("keeps https screenshots and DROPS anything else rather than fetching it", () => {
    const tiles = readCrossClientRenders({
      renders: [
        {
          environment: { name: "Outlook 2019", dark_mode: false },
          image_url: "https://cdn.example.com/shot.png",
          issues: ["background lost"],
        },
        {
          environment: { name: "Sketchy", dark_mode: true },
          image_url: "http://insecure.example.com/x.png",
        },
        { environment: { name: "" } },
      ],
    });
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({
      name: "Outlook 2019",
      darkMode: false,
      imageUrl: "https://cdn.example.com/shot.png",
      issues: ["background lost"],
    });
    expect(tiles[1]!.imageUrl).toBeNull();
    // The dark tile must SAY it is dark: the card renders the "Dark" pill off
    // this bit, and a matrix that mislabels dark screenshots as light reads
    // as "dark mode is fine" when it is not.
    expect(tiles[1]!.darkMode).toBe(true);
    expect(tiles[0]!.darkMode).toBe(false);
  });
});
