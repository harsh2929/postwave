/**
 * The stub in metro.config.js that removes the css-tree CSS parser is only
 * safe while nothing passes `logoSVG` to a QR code.
 *
 * react-native-qrcode-svg's LogoSVG statically imports `react-native-svg/css`
 * for `LocalSvg`, pulling a full CSS parser (111 modules) into the bundle to
 * draw a logo in the middle of a QR code.
 *
 * THE PROP THAT MATTERS IS `logoSVG`, NOT `logo`. An earlier version of this
 * file watched `logo` and would have passed while the app crashed — `logo`
 * renders a plain <Image> and never touches the CSS entry. Verified by probe
 * with the module mocked empty:
 *
 *   logo={...}                -> renders fine
 *   logoSVG="<svg .../>"      -> renders fine   (SvgXml, main entry)
 *   logoSVG={require(...)}    -> TypeError: Cannot read properties of
 *                                undefined (reading 'displayName')
 *
 * Only the non-string (local asset) branch reaches `LocalSvg`, but this guard
 * flags ANY `logoSVG` usage: deciding string-ness by static inspection is
 * exactly the kind of cleverness that produced the first hole.
 *
 * A crash here lands on 2FA enrolment and phone sign-in approval — screens
 * where a broken QR locks somebody out of their account. This test fails at
 * build time instead.
 *
 * The fix when it fires is to delete "react-native-svg/css" from
 * CSS_PARSER_STUBS in metro.config.js and accept the bundle cost.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.[jt]sx?$/u.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so prose ABOUT the forbidden prop cannot fail the test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

describe("QR-code logo prop stays unused", () => {
  const files = [
    ...sourceFiles(join(APP_ROOT, "src")),
    ...sourceFiles(join(APP_ROOT, "app")),
  ].filter((f) => !f.endsWith("qrcodeLogoPropUnused.test.ts"));

  it("finds the QRCode call sites at all", () => {
    // Vacuity floor: if the import disappears or is renamed, the scan below
    // would pass while proving nothing.
    const importers = files.filter((f) =>
      stripComments(readFileSync(f, "utf8")).includes("react-native-qrcode-svg"),
    );
    expect(importers.length).toBeGreaterThan(0);
  });

  it("passes no logoSVG prop, so the CSS parser stays stubbed", () => {
    const offenders = files.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      if (!src.includes("QRCode")) return false;
      // `logoSVG` in any form -- JSX attribute or spread-built object.
      return /\blogoSVG\b/u.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the stub wired in metro.config.js", () => {
    // The other half: the prop being unused only helps while the stub exists.
    const metro = readFileSync(join(APP_ROOT, "metro.config.js"), "utf8");
    expect(stripComments(metro)).toContain('"react-native-svg/css"');
  });
});
