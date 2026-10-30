import { describe, expect, it } from "vitest";

import { qrSvg } from "@/lib/qr-code";

describe("qrSvg", () => {
  const url = "https://forms.moosewave.com/forms/newsletter";

  it("produces a self-contained SVG with a square viewBox", () => {
    const svg = qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(vb).not.toBeNull();
    expect(vb![1]).toBe(vb![2]); // square
    expect(svg).toContain("</svg>");
  });

  it("emits dark modules as a non-trivial path", () => {
    const svg = qrSvg(url);
    const path = svg.match(/<path d="([^"]+)"/);
    expect(path).not.toBeNull();
    expect(path![1].length).toBeGreaterThan(50);
  });

  it("is deterministic for the same input", () => {
    expect(qrSvg(url)).toBe(qrSvg(url));
  });

  it("honors custom colors", () => {
    const svg = qrSvg(url, { dark: "#123456", light: "#abcdef" });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#abcdef"');
  });
});
