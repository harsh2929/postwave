// SPDX-License-Identifier: AGPL-3.0-only
//
// Single source of truth for the locales we ship to subscribers. Imported by
// the next-intl request config, the middleware, and the LanguagePicker.
// Keep these in sync with the JSON files at apps/web/locales/<locale>.json.
export const locales = ["en", "es", "fr", "de", "pt", "ja"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

// Display names for the language picker. Each label is rendered in its own
// language so that someone landing in the wrong locale can still self-rescue.
export const localeLabels: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ja: "日本語",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}
