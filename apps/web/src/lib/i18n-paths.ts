// SPDX-License-Identifier: AGPL-3.0-only
import { isLocale, type Locale } from "@/i18n/locales";

export function localizedPathForLangOverride(
  pathname: string,
  locale: Locale,
): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const segments = normalized.split("/");

  if (isLocale(segments[1])) {
    segments[1] = locale;
    return segments.join("/") || `/${locale}`;
  }

  return `/${locale}${normalized === "/" ? "" : normalized}`;
}
