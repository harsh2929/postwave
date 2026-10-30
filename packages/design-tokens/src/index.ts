/**
 * @postwave/design-tokens — the single source of truth for the Moosewave
 * brand (ember on warm-paper, Inter + Fraunces) across web, desktop,
 * mobile, and email.
 *
 * Consume the canonical palette directly (mobile RN theme = `light`/`dark`),
 * or generate CSS custom properties for web (HSL triplets) / desktop (hex
 * vars) via `toCssVars`. A CI drift guard asserts every client's theme
 * still matches `BRAND_ANCHORS`.
 */

export {
  type PaletteTokens,
  type ThemeMode,
  light,
  dark,
  tokens,
  fonts,
  radius,
  TOKEN_KEYS,
} from "./tokens.js";

export {
  type EasingToken,
  type MotionTokens,
  type ReducedMotionTokens,
  motion,
  reducedMotion,
} from "./motion.js";

export { hexToRgb, hexToHsl, hexToHslTriplet } from "./color.js";

export {
  type VarNameMap,
  type CssValueFormat,
  WEB_VAR_MAP,
  DESKTOP_VAR_MAP,
  OPS_VAR_MAP,
  PORTAL_VAR_MAP,
  BRAND_ANCHORS,
  toCssVars,
} from "./css.js";
