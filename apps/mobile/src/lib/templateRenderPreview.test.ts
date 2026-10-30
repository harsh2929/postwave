/**
 * The template preview wrapper: every document keeps the lockdown CSP, the
 * dark toggle forces a dark ground, and a bodiless template renders nothing.
 */
import { describe, expect, it } from "vitest";

import {
  TEMPLATE_PREVIEW_MODES,
  templateHasRenderableBody,
  templatePreviewDocument,
} from "./templateRenderPreview";

const mobile = TEMPLATE_PREVIEW_MODES[0]!;
const desktop = TEMPLATE_PREVIEW_MODES[1]!;

describe("templatePreviewDocument", () => {
  it("carries the lockdown CSP and the mode's viewport width", () => {
    const doc = templatePreviewDocument("<p>x</p>", desktop, "light");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain(`width=${desktop.width}`);
  });
  it("dark forces a dark ground; light does not", () => {
    const dark = templatePreviewDocument("<p>x</p>", mobile, "dark");
    expect(dark).toContain("color-scheme:dark");
    const light = templatePreviewDocument("<p>x</p>", mobile, "light");
    expect(light).not.toContain("color-scheme:dark");
  });
});

describe("templateHasRenderableBody", () => {
  it("only a non-blank body renders", () => {
    expect(templateHasRenderableBody("<p>x</p>")).toBe(true);
    expect(templateHasRenderableBody("   ")).toBe(false);
    expect(templateHasRenderableBody(null)).toBe(false);
    expect(templateHasRenderableBody(undefined)).toBe(false);
  });
});
