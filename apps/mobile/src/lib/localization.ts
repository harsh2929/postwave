/**
 * lib/localization.ts — the one call site `format.ts` was waiting for.
 *
 * `setFormatLocale()` existed with a comment saying it would be "called once
 * at startup when the app gains localization"; nothing ever called it
 * (NATIVE#43). This is that call, made from `useAppBootstrap` before the
 * launch gate lets the app paint.
 *
 * Scope, stated plainly: this makes NUMBERS, PERCENTAGES, CURRENCY, DATES and
 * RELATIVE TIME follow the phone's locale, and it points `lib/i18n` at the
 * same tag so counted sentences select the right CLDR plural category. It
 * still translates nothing — no non-English catalogue is registered, and one
 * that covered a third of the UI would read worse than consistent English —
 * and it deliberately does not touch `I18nManager`; see
 * `localePolicy.deviceIsRTL` for why mirroring the layout under English copy
 * would be a regression, not a feature.
 *
 * Separated from `localePolicy.ts` because this module imports
 * expo-localization and therefore cannot be loaded by a node vitest file; the
 * decision it delegates to is tested there.
 */
import { I18nManager } from "react-native";
import { getLocales } from "expo-localization";

import { setLayoutDirection } from "./direction";
import { setFormatLocale } from "./format";
import { setMessageLocale } from "./i18n";
import {
  describeFormatLocale,
  deviceIsRTL,
  pickFormatLocale,
  type DeviceLocaleLike,
} from "./localePolicy";

let resolved: string | null = null;
let deviceLocales: DeviceLocaleLike[] = [];
let initialized = false;

function readDeviceLocales(): DeviceLocaleLike[] {
  try {
    // `getLocales()` is documented to always return at least one entry, but it
    // reads a native constant — on a device mid language change it has been
    // seen to return nothing at all, and a throw here would take the launch
    // path with it.
    const list = getLocales();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the device locale and hand it to every formatter.
 *
 * Idempotent: the OS restarts the app when the user changes their language on
 * iOS, and Android re-creates the activity, so a one-shot read at launch is
 * the whole story. `force` exists for the diagnostics screen's re-read.
 *
 * Returns the tag actually applied, or `undefined` when the app is formatting
 * under the engine default.
 */
export function initLocalization(force = false): string | undefined {
  if (initialized && !force) return resolved ?? undefined;
  initialized = true;
  deviceLocales = readDeviceLocales();
  const picked = pickFormatLocale(deviceLocales);
  setFormatLocale(picked);
  // Same tag to the message layer, in the same tick. Numbers and sentences
  // disagreeing about the locale is the failure this single call site exists
  // to make impossible — and plural SELECTION needs the tag even while every
  // catalogue is still English (see lib/i18n's `pluralTag`).
  setMessageLocale(picked);
  // The ACTUAL layout direction, not the device's preferred one. We never call
  // I18nManager.forceRTL (see localePolicy.deviceIsRTL), so on iOS this stays
  // false; on Android, where the manifest declares supportsRtl, the platform
  // may already have mirrored the layout. `lib/direction` needs the mirrored
  // truth, because a "→" printed inside a mirrored row points backwards.
  setLayoutDirection(I18nManager.isRTL === true);
  resolved = picked ?? null;
  return picked;
}

/** The tag every formatter is currently running under, or null for default. */
export function activeFormatLocale(): string | null {
  return resolved;
}

/** Diagnostics row: what we resolved, and what the device asked for. */
export function formatLocaleSummary(): string {
  if (!initialized) return "not initialised";
  return describeFormatLocale(resolved, deviceLocales);
}

/** Diagnostics row: whether this device is configured right-to-left. */
export function deviceTextDirection(): "ltr" | "rtl" {
  return deviceIsRTL(deviceLocales) ? "rtl" : "ltr";
}
