/**
 * Color helpers for emitting the canonical hex tokens in the forms each
 * consumer needs (web wants space-separated HSL triplets for
 * `hsl(var(--token))`; desktop wants raw hex).
 */

/** Parse #rgb / #rrggbb into [r,g,b] 0-255. Throws on malformed input. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex color: ${hex}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Convert hex to HSL components (h: 0-360, s/l: 0-100, rounded). */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r255, g255, b255] = hexToRgb(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Space-separated HSL triplet for Tailwind/shadcn-style custom properties,
 * e.g. `350 86% 42%` — used as `hsl(var(--primary))`. rgba() inputs (the
 * overlay token) pass through unchanged since they aren't HSL-able.
 */
export function hexToHslTriplet(value: string): string {
  if (!value.startsWith("#")) return value;
  const { h, s, l } = hexToHsl(value);
  return `${h} ${s}% ${l}%`;
}
