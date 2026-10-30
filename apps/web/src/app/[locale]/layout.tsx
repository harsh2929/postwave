// SPDX-License-Identifier: AGPL-3.0-only
//
// Locale-segment layout for the public subscriber surface. Wraps every
// /[locale]/forms, /[locale]/preferences, /[locale]/landing page with the
// next-intl provider so client components inside (e.g. the LanguagePicker,
// the SurveyForm wizard) can call useTranslations + useLocale.
//
// Unlike the default next-intl scaffold, we do NOT render <html>/<body>
// here — that's already done by the root app/layout.tsx. The dashboard
// shares the same root layout but never enters this segment.
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { pickClientMessages } from "@/i18n/client-messages";
import { isLocale, locales } from "@/i18n/locales";

// Pre-render every locale at build time. Cheap (six locales, six static
// segments) and gives us SSG for pages that don't depend on per-request
// data.
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

interface Props {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // Required so child server components and metadata can call
  // getTranslations() / getLocale() without re-detecting the locale.
  setRequestLocale(locale);

  // getMessages() reads from src/i18n.ts (the request config), which we
  // pinned to `locale` via setRequestLocale above. Everything it returns is
  // serialized into the flight payload of every subscriber-facing page, so
  // hand the provider only the namespaces client components read — server
  // components keep using getTranslations() and read the full bundle.
  const messages = await getMessages();

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={pickClientMessages(messages)}
    >
      {children}
    </NextIntlClientProvider>
  );
}
