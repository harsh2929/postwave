// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { previewDocument } from "@/app/(dashboard)/app/templates/_components/template-preview";

describe("template preview privacy boundary", () => {
  it("blocks all remote subresources and form submission", () => {
    const document = previewDocument(
      '<img src="https://tracker.example/pixel.gif"><link rel="stylesheet" href="https://tracker.example/x.css">',
      false,
    );

    expect(document).toContain('http-equiv="Content-Security-Policy"');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("img-src data: blob:");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).not.toContain("img-src https:");
  });

  it("puts the boundary before any source markup, including decoy heads", () => {
    const source =
      "<!-- <head> decoy --> <!doctype html><html><head><title>Weekly</title></head><body><p>Hello</p></body></html>";
    const document = previewDocument(source, true);

    expect(document).toContain("<head><meta");
    expect(
      document.indexOf('http-equiv="Content-Security-Policy"'),
    ).toBeLessThan(document.indexOf("decoy"));
    expect(document).toContain('<meta name="color-scheme" content="dark">');
    expect(document).toContain("<title>Weekly</title>");
    expect(document).toContain("<p>Hello</p>");
  });

  it("offers a network-silent images-off layout check", () => {
    const document = previewDocument('<img src="https://tracker.example/a.png" alt="Hero">', false, true);
    expect(document).toContain("img,mj-image{opacity:0!important}");
    expect(document.indexOf("opacity:0!important")).toBeLessThan(document.indexOf("https://tracker.example"));
    expect(document).toContain("img-src data: blob:");
  });
});
