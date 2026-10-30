/**
 * lib/localePolicy.ts — choosing the locale every formatter runs under.
 *
 * `lib/format.ts` was written "locale-ready by construction": every number,
 * percentage, currency and date goes through `Intl` with a module-level
 * `locale` that `setFormatLocale()` sets. That function had ZERO callers
 * (NATIVE#43), so `locale` stayed `undefined` forever and every screen
 * rendered under whatever default the JS engine happened to pick. On Hermes
 * that is not reliably the device locale, so a French user could see
 * `1,234.5` and `Mar 14, 2026` on a phone set to `fr-FR`.
 *
 * The wiring itself lives in `lib/localization.ts` (it imports
 * expo-localization and therefore cannot be loaded by a node test). The
 * DECISION lives here, import-free, because the decision is where the sharp
 * edge is:
 *
 *   `new Intl.NumberFormat("en_US")` — an underscore, which some Android
 *   OEM builds still report — throws a RangeError. Handing an unvalidated
 *   device tag straight to `setFormatLocale` would therefore turn a cosmetic
 *   locale quirk into a crash in every single number on every single screen.
 *   So a tag is only accepted after it has been PROVED to construct.
 *
 * Deliberately NOT done here: message translation. Moosewave's UI strings are
 * English literals across all three clients, and a half-populated catalogue
 * (some sentences translated, most not) reads worse than a consistently
 * English one. Formatting is the part that is wrong today for a user whose
 * device is not en-US, and it is fixable without shipping a lie.
 */

/** The subset of expo-localization's `Locale` this module needs. */
export interface DeviceLocaleLike {
  languageTag?: string | null;
  languageCode?: string | null;
  regionCode?: string | null;
  textDirection?: string | null;
}

/**
 * Conservative BCP-47: language, optional script, optional region, optional
 * variants. Anything with an underscore, a control character, or an absurd
 * length is rejected before it reaches `Intl`.
 */
const BCP47_RE =
  /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/;

const MAX_TAG_CHARS = 35; // BCP-47's own practical ceiling for our subset.

/** Trim + shape-check a candidate tag. Returns null when it is not usable. */
export function normalizeLanguageTag(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TAG_CHARS) return null;
  if (!BCP47_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Prove the tag by constructing the two formatters `format.ts` actually uses.
 * A shape check is not sufficient: `qq-ZZ` is well-formed and still throws on
 * some engines, and `Intl.DateTimeFormat` and `Intl.NumberFormat` do not
 * always agree about what they accept.
 */
export function isUsableFormatLocale(tag: string): boolean {
  try {
    new Intl.NumberFormat(tag).format(1);
    new Intl.DateTimeFormat(tag).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the locale to format under, in the user's own preference order.
 *
 * Falls back from the full tag (`pt-BR`) to the bare language (`pt`) before
 * moving on to the next preference, because a region we cannot construct is
 * not a reason to discard a language we can.
 *
 * Returns `undefined` — NOT a hardcoded "en-US" — when nothing is usable.
 * `undefined` means "let the engine use its own default", which is the
 * existing behaviour; substituting American conventions for an unknown device
 * would be a guess dressed up as a decision.
 */
export function pickFormatLocale(
  locales: readonly DeviceLocaleLike[] | null | undefined,
): string | undefined {
  if (!Array.isArray(locales)) return undefined;
  for (const entry of locales) {
    if (!entry || typeof entry !== "object") continue;
    const candidates = [
      normalizeLanguageTag(entry.languageTag),
      normalizeLanguageTag(entry.languageCode),
    ];
    for (const candidate of candidates) {
      if (candidate && isUsableFormatLocale(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * One line for the diagnostics report. Support's first question when a
 * customer says "the dates are wrong" is which locale the phone is in, and
 * until now the report could not answer it.
 *
 * `resolved` is what the app actually formats under, which is NOT always the
 * device's first preference — that is precisely the case worth surfacing.
 */
export function describeFormatLocale(
  resolved: string | null | undefined,
  locales: readonly DeviceLocaleLike[] | null | undefined,
): string {
  const preferred = Array.isArray(locales)
    ? normalizeLanguageTag(locales[0]?.languageTag)
    : null;
  if (!resolved) {
    return preferred ? `engine default (device ${preferred})` : "engine default";
  }
  if (preferred && preferred !== resolved) {
    return `${resolved} (device ${preferred})`;
  }
  return resolved;
}

/**
 * Whether the device is configured right-to-left.
 *
 * Reported, never acted on. Flipping `I18nManager.forceRTL` while every string
 * in the app is still English would mirror the layout around left-to-right
 * text — strictly worse than the current LTR presentation. Surfacing it in
 * diagnostics is how we find out whether anyone is affected before doing the
 * translation work that would make an RTL layout correct.
 */
export function deviceIsRTL(
  locales: readonly DeviceLocaleLike[] | null | undefined,
): boolean {
  if (!Array.isArray(locales)) return false;
  return locales[0]?.textDirection === "rtl";
}
