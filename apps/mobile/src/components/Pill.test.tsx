/**
 * Pill.test.tsx — A11Y-11: a pill's label must be readable on the tint the
 * pill paints behind it.
 *
 * The pill paints its tone at 15% alpha as a wash and, until this test, the
 * label in that same tone. `themeContrast.test.ts` measured each tone on SOLID
 * grounds only, so nothing measured the combination actually on screen. On
 * that combination light danger measured 3.80:1 and dark accent 3.55:1, for
 * 11pt uppercase text that needs 4.5:1.
 *
 * This file renders the REAL component with the REAL palettes and measures
 * what it painted: it parses the rendered backgroundColor, composites it over
 * each ground a pill sits on, and checks the rendered text colour against the
 * result. It does not ask the component how it chose its colours, so it keeps
 * checking the right thing whatever the implementation does.
 */
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { dark, light } from "@postwave/design-tokens";

import { blendOver, contrastRatio } from "@/lib/contrast";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  current: {} as Record<string, string>,
}));

vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
}));

vi.mock("@/lib/fonts", () => ({
  FONT: {
    regular: "Inter_400Regular",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
  },
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ t: theme.current }),
}));

// eslint-disable-next-line import/first
import { Pill, type PillTone } from "./Pill";

/** WCAG 2.2 SC 1.4.3. badgeSmall is 11pt semibold, so the large-text floor does not apply. */
const NORMAL_TEXT_MIN = 4.5;

const palettes = { light, dark } as const;
type Palette = (typeof palettes)[keyof typeof palettes];

/** The token each tone tints its wash with. `neutral` is the muted-text grey. */
const TONE_TOKEN: Record<PillTone, keyof Palette> = {
  neutral: "fgMuted",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
};

/** What a pill is placed on: the page, a section, a card, a sheet. */
const GROUNDS = ["bg", "bgSubtle", "surface", "surfaceElevated"] as const;

interface Painted {
  label: string;
  ink: unknown;
  washHex: string;
  washAlpha: number;
}

function flatten(style: unknown): Record<string, unknown> {
  const layers = (Array.isArray(style) ? style : [style]).filter(
    (layer): layer is Record<string, unknown> =>
      typeof layer === "object" && layer !== null,
  );
  return Object.assign({}, ...layers) as Record<string, unknown>;
}

/** `rgba(212,60,31,0.15)` → `{ hex: "#d43c1f", alpha: 0.15 }`. */
function parseRgba(color: unknown): { hex: string; alpha: number } | null {
  if (typeof color !== "string") return null;
  const match = /^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/.exec(color);
  if (!match) return null;
  const hex = [match[1], match[2], match[3]]
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("");
  return { hex: `#${hex}`, alpha: Number(match[4]) };
}

function paint(palette: Palette, tone: PillTone | undefined): Painted {
  theme.current = palette as unknown as Record<string, string>;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      tone === undefined ? (
        <Pill label="Fail 120" />
      ) : (
        <Pill label="Fail 120" tone={tone} />
      ),
    );
  });
  if (!renderer) throw new Error("Pill did not render");
  const view = renderer.root.find(
    (node) => (node.type as unknown) === "View",
  );
  const text = renderer.root.find(
    (node) => (node.type as unknown) === "Text",
  );
  const wash = parseRgba(flatten(view.props.style).backgroundColor);
  if (!wash) {
    throw new Error(
      `Pill painted a backgroundColor this test cannot measure: ${String(
        flatten(view.props.style).backgroundColor,
      )}`,
    );
  }
  const painted: Painted = {
    label: text.children.join(""),
    ink: flatten(text.props.style).color,
    washHex: wash.hex,
    washAlpha: wash.alpha,
  };
  act(() => renderer?.unmount());
  return painted;
}

describe("Pill label ink is readable on the wash it paints (A11Y-11)", () => {
  for (const [name, palette] of Object.entries(palettes)) {
    for (const tone of Object.keys(TONE_TOKEN) as PillTone[]) {
      it(`${name}: ${tone} label clears ${NORMAL_TEXT_MIN}:1 on its own tint over every ground`, () => {
        const painted = paint(palette, tone);
        expect(painted.label).toBe("Fail 120");
        const ink = String(painted.ink);
        const measured = GROUNDS.map((ground) => {
          const composite = blendOver(
            painted.washHex,
            palette[ground],
            painted.washAlpha,
          );
          return { ground, ratio: contrastRatio(ink, composite) };
        });
        for (const { ground, ratio } of measured) {
          expect(
            ratio,
            `${name} ${tone}: ink ${ink} on its ${painted.washAlpha} wash over ${ground} measured ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(NORMAL_TEXT_MIN);
        }
      });
    }
  }
});

describe("the fix changes the ink, never the wash", () => {
  // Contrast could be "fixed" by dropping the tint, which would silently
  // repaint 233 call sites. The tint is the tone's own colour at 15%.
  for (const [name, palette] of Object.entries(palettes)) {
    for (const [tone, token] of Object.entries(TONE_TOKEN) as [
      PillTone,
      keyof Palette,
    ][]) {
      it(`${name}: ${tone} still tints with ${String(token)} at 15%`, () => {
        const painted = paint(palette, tone);
        expect(painted.washHex).toBe(palette[token].toLowerCase());
        expect(painted.washAlpha).toBeCloseTo(0.15, 5);
      });
    }
  }

  it("defaults to the neutral tone when no tone is passed", () => {
    const neutral = paint(light, "neutral");
    const unspecified = paint(light, undefined);
    expect(unspecified).toEqual(neutral);
    expect(unspecified.washHex).toBe(light.fgMuted.toLowerCase());
  });
});
