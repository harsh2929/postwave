import { describe, expect, it } from "vitest";
import {
  BRAND_ANCHORS,
  DESKTOP_VAR_MAP,
  WEB_VAR_MAP,
  dark,
  hexToHsl,
  hexToHslTriplet,
  light,
  toCssVars,
  tokens,
  TOKEN_KEYS,
} from "./index";

describe("canonical tokens", () => {
  it("locks the brand anchors", () => {
    expect(BRAND_ANCHORS.emberLight).toBe("#C8102E");
    expect(BRAND_ANCHORS.emberDark).toBe("#E55262");
    expect(BRAND_ANCHORS.paper).toBe("#FDFCF8");
    expect(BRAND_ANCHORS.ink).toBe("#0F0F0F");
    expect(BRAND_ANCHORS.warmBorder).toBe("#E0DDD3");
    expect(BRAND_ANCHORS.gold).toBe("#F2B233");
  });

  it("uses warm ink (not a cool blue-slate) for the dark canvas", () => {
    // Regression guard for the desktop drift: dark bg must be neutral
    // (R≈G≈B), never blue-tinted like the old #0c0e14.
    const { h, s } = hexToHsl(dark.bg);
    expect(s).toBeLessThanOrEqual(5);
    void h;
  });

  it("light and dark expose the identical key set", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(TOKEN_KEYS.length).toBeGreaterThan(0);
  });

  it("keeps semantic emphasis AA-safe across its real web treatments", () => {
    const rgb = (hex: string): [number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const linearChannel = (channel: number): number => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const [red, green, blue] = rgb(hex);
      return (
        linearChannel(red) * 0.2126 +
        linearChannel(green) * 0.7152 +
        linearChannel(blue) * 0.0722
      );
    };
    const contrast = (a: string, b: string): number => {
      const luminanceA = luminance(a);
      const luminanceB = luminance(b);
      const lighter = Math.max(luminanceA, luminanceB);
      const darker = Math.min(luminanceA, luminanceB);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const composite = (
      foreground: string,
      background: string,
      alpha: number,
    ) => {
      const [foregroundRed, foregroundGreen, foregroundBlue] = rgb(foreground);
      const [backgroundRed, backgroundGreen, backgroundBlue] = rgb(background);
      const channels = [
        Math.round(foregroundRed * alpha + backgroundRed * (1 - alpha)),
        Math.round(foregroundGreen * alpha + backgroundGreen * (1 - alpha)),
        Math.round(foregroundBlue * alpha + backgroundBlue * (1 - alpha)),
      ];
      return `#${channels
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`;
    };

    for (const palette of [light, dark]) {
      const surfaces = [
        palette.bg,
        palette.bgSubtle,
        palette.surface,
        palette.surfaceElevated,
      ];

      // Solid destructive button and its 90%-alpha hover state.
      expect(
        contrast(palette.dangerEmphasis, palette.dangerEmphasisFg),
      ).toBeGreaterThanOrEqual(4.5);
      for (const surface of surfaces) {
        expect(
          contrast(
            composite(palette.dangerEmphasis, surface, 0.9),
            palette.dangerEmphasisFg,
          ),
        ).toBeGreaterThanOrEqual(4.5);

        // Error copy on the product's `bg-destructive/10` washed surface.
        expect(
          contrast(
            palette.dangerEmphasis,
            composite(palette.danger, surface, 0.1),
          ),
        ).toBeGreaterThanOrEqual(4.5);

        for (const alpha of [0.05, 0.1, 0.15]) {
          expect(
            contrast(
              palette.successEmphasis,
              composite(palette.success, surface, alpha),
            ),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(palette.successEmphasis, palette.successSubtle),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("hexToHsl / hexToHslTriplet", () => {
  // NOTE: these are the TRUE conversions of the canonical brand hex.
  // apps/web globals.css currently declares slightly-off approximations
  // (e.g. `40 33% 98%` for #FDFCF8, which actually converts to 48 56% 98%);
  // wiring web to this package deliberately corrects that drift.
  it("computes the canonical ember triplet from #C8102E", () => {
    expect(hexToHslTriplet("#C8102E")).toBe("350 85% 42%");
  });
  it("computes the canonical warm-paper triplet from #FDFCF8", () => {
    expect(hexToHslTriplet("#FDFCF8")).toBe("48 56% 98%");
  });
  it("passes rgba() through unchanged", () => {
    expect(hexToHslTriplet("rgba(15,15,15,0.5)")).toBe("rgba(15,15,15,0.5)");
  });
  it("handles 3-digit hex", () => {
    expect(hexToHsl("#fff")).toEqual({ h: 0, s: 0, l: 100 });
  });
});

describe("toCssVars", () => {
  it("emits web HSL-triplet custom props", () => {
    const css = toCssVars("light", WEB_VAR_MAP, "hsl-triplet");
    expect(css).toContain("--primary: 350 85% 42%;");
    expect(css).toContain("--background: 48 56% 98%;");
  });
  it("emits desktop hex custom props with warm-ink canvas", () => {
    const css = toCssVars("dark", DESKTOP_VAR_MAP, "hex");
    expect(css).toContain("--pw-bg: #0F0F0F;");
    expect(css).toContain("--pw-accent: #E55262;");
  });
  it("covers every mapped key for both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const lines = toCssVars(mode, DESKTOP_VAR_MAP, "hex").split("\n");
      expect(lines.length).toBe(Object.keys(DESKTOP_VAR_MAP).length);
    }
    expect(tokens.light).toBe(light);
  });
});
