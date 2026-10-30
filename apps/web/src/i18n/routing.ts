// SPDX-License-Identifier: AGPL-3.0-only
//
// Routing configuration for next-intl. Drives both the middleware and any
// localized navigation helpers we add later. Centralised here so the
// LanguagePicker, middleware, and i18n.ts all read from one source.
import { defineRouting } from "next-intl/routing";

import { defaultLocale, locales } from "@/i18n/locales";

export const routing = defineRouting({
  locales: [...locales],
  defaultLocale,
  // Locale prefix is required on every public path. The middleware below is
  // scoped (via its matcher) to only run against public routes — the
  // dashboard never sees the locale prefix.
  localePrefix: "always",
  // Detect from cookie + Accept-Language. The user can also force a locale
  // via ?lang=xx (handled in middleware.ts before this runs).
  localeDetection: true,
});
