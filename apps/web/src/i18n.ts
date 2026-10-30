// SPDX-License-Identifier: AGPL-3.0-only
//
// next-intl request config. Loaded by the next-intl plugin (see
// next.config.mjs) at request time to resolve the active locale and load its
// message bundle. We read messages from apps/web/locales/<locale>.json.
//
// Public-facing pages only — the dashboard does not opt into i18n (admins
// are typically bilingual, and the dashboard surface is large; localizing
// it is out of scope here).
import { notFound } from "next/navigation";
import { getRequestConfig } from "next-intl/server";

import { defaultLocale, isLocale } from "@/i18n/locales";

export default getRequestConfig(async ({ requestLocale }) => {
  // next-intl 3.22+ exposes `requestLocale` (a Promise) as the canonical way
  // to read the active locale from the routing layer. Older guides use
  // `locale` directly; we accept either to be defensive against future
  // upgrades.
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : defaultLocale;

  let messages;
  try {
    messages = (await import(`../locales/${locale}.json`)).default;
  } catch {
    // A misconfigured locale prefix should 404, not 500. The middleware is
    // already filtering, but defense in depth.
    notFound();
  }

  return {
    locale,
    messages,
  };
});
