// SPDX-License-Identifier: AGPL-3.0-only
//
// Dependency-light QR generation for the Embed page (FORM-036). We use the
// battle-tested `qrcode` package for the encoding (Reed-Solomon + masking) but
// render the module matrix ourselves — no <canvas>, so it works during SSR, in
// tests, and produces a crisp, downloadable, scalable asset. Pure and
// deterministic given the same input.

import QRCode from "qrcode";

export interface QrSvgOptions {
  /** Quiet-zone modules around the code (spec minimum is 4). */
  margin?: number;
  /** Dark-module color. */
  dark?: string;
  /** Light/background color. */
  light?: string;
  /** Error-correction level. */
  level?: "L" | "M" | "Q" | "H";
}

export interface QrPath {
  /** SVG viewBox dimension (modules + margins), a square. */
  dim: number;
  /** SVG path `d` covering every dark module. */
  path: string;
  dark: string;
  light: string;
}

/**
 * Encode `text` into an SVG path over a square module grid. The caller can
 * render this as React `<svg>` elements (no innerHTML) or serialize it.
 */
export function qrPath(text: string, opts: QrSvgOptions = {}): QrPath {
  const margin = opts.margin ?? 4;
  const dark = opts.dark ?? "#0f172a";
  const light = opts.light ?? "#ffffff";
  const qr = QRCode.create(text, { errorCorrectionLevel: opts.level ?? "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const dim = size + margin * 2;

  const rects: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]) {
        rects.push(`M${x + margin} ${y + margin}h1v1h-1z`);
      }
    }
  }
  return { dim, path: rects.join(""), dark, light };
}

/** Render `text` to a self-contained SVG string (for download/serialization). */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { dim, path, dark, light } = qrPath(text, opts);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
