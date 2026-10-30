import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CARD_GEOMETRY,
  CARD_RADIUS,
  SECTION_LABEL_RHYTHM,
  SECTION_LABEL_RHYTHM_COMPACT,
  SECTION_LABEL_TEXT,
} from "./shellStyleTokens";

const appRoot = resolve(process.cwd());
const read = (relativePath: string): string =>
  readFileSync(join(appRoot, relativePath), "utf8");

/**
 * The three shell modules that each used to declare their OWN section-label
 * and card geometry. The audit found 11/600/0.6 written three times with
 * different margins, and card radius 16 / 16 / 12 — differences nobody chose.
 */
const SHELL_STYLE_CONSUMERS = [
  "src/components/SectionLabel.tsx",
  "src/components/Card.tsx",
  "src/components/settings/SettingsScreenPrimitives.tsx",
  "src/components/more/moreStyles.ts",
];

describe("shell style tokens", () => {
  it("keeps one card radius across the shell", () => {
    expect(CARD_GEOMETRY.default.borderRadius).toBe(CARD_RADIUS);
    expect(CARD_GEOMETRY.compact.borderRadius).toBe(CARD_RADIUS);
  });

  it("varies only padding between card variants", () => {
    expect(CARD_GEOMETRY.default.padding).not.toBe(
      CARD_GEOMETRY.compact.padding,
    );
  });

  it("states the section-label typography once", () => {
    expect(SECTION_LABEL_TEXT).toEqual({
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.6,
      textTransform: "uppercase",
    });
  });

  it("keeps the compact rhythm tighter than the default one", () => {
    expect(SECTION_LABEL_RHYTHM_COMPACT.marginTop).toBeLessThan(
      SECTION_LABEL_RHYTHM.marginTop,
    );
    expect(SECTION_LABEL_RHYTHM_COMPACT.marginBottom).toBeLessThan(
      SECTION_LABEL_RHYTHM.marginBottom,
    );
  });
});

describe("shell style single-sourcing", () => {
  it("has no shell module re-declaring the label typography inline", () => {
    const offenders = SHELL_STYLE_CONSUMERS.filter((path) => {
      const source = read(path);
      // The literal pair that identifies a hand-rolled copy of the heading.
      return (
        source.includes("letterSpacing: 0.6") ||
        source.includes('textTransform: "uppercase"')
      );
    });
    expect(offenders).toEqual([]);
  });

  it("has no shell module re-declaring card geometry inline", () => {
    const offenders = SHELL_STYLE_CONSUMERS.filter((path) => {
      const source = read(path);
      return /borderRadius:\s*1[26]\b/u.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("routes every shell style consumer through the token module", () => {
    const missing = SHELL_STYLE_CONSUMERS.filter(
      (path) => !read(path).includes("shellStyleTokens"),
    );
    expect(missing).toEqual([]);
  });
});
