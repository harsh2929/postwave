// SPDX-License-Identifier: AGPL-3.0-only
import {
  defaultLocale,
  isLocale,
  type Locale,
} from "@/i18n/locales";

export type DocumentLocaleParams = {
  locale?: string | string[];
};

export function documentLocaleFromParams(
  params: DocumentLocaleParams | undefined,
): Locale {
  const value = Array.isArray(params?.locale)
    ? params.locale[0]
    : params?.locale;
  return isLocale(value) ? value : defaultLocale;
}
