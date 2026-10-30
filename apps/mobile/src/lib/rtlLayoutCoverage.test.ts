import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PHYSICAL SPACING IS A BUG WHEN THE LAYOUT MIRRORS.
 *
 * `android/app/src/main/AndroidManifest.xml` declares `supportsRtl="true"`, so
 * on an RTL locale Android mirrors the whole layout: rows reverse, the back
 * chevron moves to the trailing edge, text aligns right. Yoga mirrors LOGICAL
 * spacing (`marginStart` / `paddingEnd`) with it. It does NOT mirror
 * `marginLeft` / `paddingRight`, which stay pinned to the physical side they
 * name — so a half-mirrored layout is the result, and the failures are not
 * cosmetic:
 *
 *   - A card that reserves room for an absolutely-positioned control with
 *     `paddingRight` while the control sits at `right: 8` ends up with the
 *     control ON TOP of the text on an RTL device, because the padding follows
 *     the mirror and the control does not.
 *   - A tree indent written as `marginLeft: depth * 14` indents from the wrong
 *     edge, so nesting reads inside-out.
 *
 * This guard makes the rule enforceable instead of conventional. It scans for
 * the four spacing props with a physical side in their name; symmetric
 * `left: 0 / right: 0` insets are deliberately NOT flagged, because a box
 * pinned to both edges is identical under either direction.
 *
 * THE EXEMPTIONS ARE NAMED, with a reason of one of exactly two kinds:
 *  - the module already branches on the layout direction itself, or
 *  - the coordinates are not a mirrored layout at all (SVG plot geometry,
 *    or a value paired with a `translateX` measured in the same physical
 *    space — see SegmentedControl's indicator).
 *
 * "It looked fine on my phone" is not a reason: the person reading this app in
 * Arabic or Hebrew is not in the room.
 */

const mobileRoot = process.cwd();

const EXEMPT: Readonly<Record<string, string>> = {
  "src/components/ScreenHeader.tsx":
    "The back chevron BRANCHES on I18nManager.isRTL and picks the physical " +
    "border sides + rotation deliberately, so the arrow points at the leading " +
    "edge in both directions.",
  "src/components/charts/TimeSeriesChart.tsx":
    "Plot geometry inside an <Svg> viewBox, not a mirrored Yoga layout: the " +
    "axis gutters are coordinates in the chart's own space.",
};

/** Spacing props that name a physical side and therefore do not mirror. */
const PHYSICAL_SPACING = [
  "marginLeft:",
  "marginRight:",
  "paddingLeft:",
  "paddingRight:",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile()) return [];
    if (!/\.tsx?$/u.test(path)) return [];
    if (/\.(?:test|spec)\.tsx?$/u.test(path)) return [];
    return [path];
  });
}

function repoPath(path: string): string {
  return relative(mobileRoot, path).split(sep).join("/");
}

describe("RTL layout coverage", () => {
  it("uses logical spacing everywhere the layout can mirror", () => {
    const files = [
      ...sourceFiles(join(mobileRoot, "app")),
      ...sourceFiles(join(mobileRoot, "src")),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      const rel = repoPath(path);
      if (rel in EXEMPT) continue;
      const text = readFileSync(path, "utf8");
      const hits = PHYSICAL_SPACING.filter((prop) => text.includes(prop));
      if (hits.length === 0) continue;
      offenders.push(
        `${rel} uses ${hits.join(", ")} — use the logical equivalent ` +
          `(marginStart/marginEnd, paddingStart/paddingEnd) so the spacing ` +
          `mirrors with the layout, or add a NAMED exemption saying why this ` +
          `one is genuinely physical.`,
      );
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still needs it", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => {
      const text = readFileSync(join(mobileRoot, rel), "utf8");
      return !PHYSICAL_SPACING.some((prop) => text.includes(prop));
    });
    // An exemption nobody is using is a licence the next edit inherits
    // silently, which is how the list stops meaning anything.
    expect(stale, `stale exemptions: ${stale.join(", ")}`).toEqual([]);
  });
});
