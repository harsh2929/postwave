// SPDX-License-Identifier: AGPL-3.0-only
//
// Public hosted preference page. RSC fetches the token's topics + opt-in
// state, then a small client island handles the checkbox toggles + the
// POST-back. Past-expiry redirects to /preferences/expired.
//
// The page has two surfaces:
//
//   1. Default — the topic checkbox form (PreferencesForm).
//   2. ?frequency=true — the smart-unsubscribe radio picker
//      (FrequencyForm). Operators link to this from the campaign
//      unsubscribe footer so subscribers see a "less often" /
//      "pause" option before the full opt-out.
//
// Smart-unsubscribe lives on the same token because both surfaces
// authenticate the same way; routing it as ?frequency=true (rather
// than /preferences/{token}/frequency) keeps the URL shape backwards-
// compatible with every campaign already linked.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import {
  fetchPublicPreferences,
  visitorIPFromHeaders,
} from "@/lib/public-pages-api";

import { FrequencyForm } from "./frequency-form";
import { PreferenceCenterShell } from "./preference-center-shell";
import { PreferencesForm } from "./preferences-form";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function PreferencesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; locale: string }>;
  searchParams: Promise<{ frequency?: string }>;
}) {
  const { token, locale } = await params;
  const { frequency } = await searchParams;
  setRequestLocale(locale);
  const visitorIP = visitorIPFromHeaders(await headers());
  const [result, t, tFreq, tForms] = await Promise.all([
    fetchPublicPreferences(token, undefined, visitorIP),
    getTranslations("preferences"),
    getTranslations("preferences.frequency"),
    getTranslations("forms"),
  ]);
  // Preserve the locale prefix when redirecting so the expired page renders
  // in the same language the subscriber arrived in.
  if (result.kind === "expired") redirect(`/${locale}/preferences/expired`);
  if (result.kind === "missing") notFound();
  if (result.kind === "unavailable") {
    return (
      <div className="space-y-3 rounded-2xl border bg-card p-5 text-center shadow-sm sm:p-8">
        <h1 className="break-words text-xl font-semibold tracking-tight">
          {t("unavailable_title")}
        </h1>
        <p className="break-words text-sm leading-6 text-muted-foreground">
          {t("unavailable_body")}
        </p>
      </div>
    );
  }

  const isFrequency = frequency === "true" || frequency === "1";
  const encodedToken = encodeURIComponent(token);

  return (
    <PreferenceCenterShell
      customization={result.data.customization}
      poweredBy={tForms("powered_by")}
    >
      <header className="space-y-1">
        <h1 className="break-words text-xl font-semibold tracking-tight">
          {isFrequency ? tFreq("header_title") : t("header_title")}
        </h1>
        <p className="break-words text-sm leading-6 text-muted-foreground">
          {isFrequency ? tFreq("header_intro") : t("header_intro")}
        </p>
        <p
          dir="auto"
          className="break-all pt-1 font-mono text-xs text-muted-foreground"
        >
          {result.data.email}
        </p>
      </header>
      {/* Tab strip linking to the other surface — subscribers can
          switch between topics + frequency without leaving the page. */}
      <nav
        aria-label={`${t("tab_topics")} / ${t("tab_frequency")}`}
        tabIndex={0}
        className="-mx-1 flex gap-1 overflow-x-auto border-b px-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <a
          href={`/${locale}/preferences/${encodedToken}`}
          aria-current={!isFrequency ? "page" : undefined}
          className={`inline-flex min-h-11 shrink-0 items-center rounded-t-md border-b-2 px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
            !isFrequency
              ? "border-primary font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          style={
            !isFrequency
              ? { borderBottomColor: result.data.customization.primary_color }
              : undefined
          }
        >
          {t("tab_topics")}
        </a>
        <a
          href={`/${locale}/preferences/${encodedToken}?frequency=true`}
          aria-current={isFrequency ? "page" : undefined}
          className={`inline-flex min-h-11 shrink-0 items-center rounded-t-md border-b-2 px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
            isFrequency
              ? "border-primary font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          style={
            isFrequency
              ? { borderBottomColor: result.data.customization.primary_color }
              : undefined
          }
        >
          {t("tab_frequency")}
        </a>
      </nav>
      {isFrequency ? (
        <FrequencyForm
          token={token}
          email={result.data.email}
          initialChoice={result.data.frequencyPreference ?? "default"}
          pausedUntil={result.data.pausedUntil}
          primaryColor={result.data.customization.primary_color}
        />
      ) : (
        <PreferencesForm
          token={token}
          initial={result.data}
          primaryColor={result.data.customization.primary_color}
        />
      )}
    </PreferenceCenterShell>
  );
}
