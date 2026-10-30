// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { isLocale, locales, localeLabels } from "@/i18n/locales";
import { asRoute } from "@/lib/typed-routes";

// Simple uncontrolled <select>. On change, swap the locale segment of the
// current path and navigate. We deliberately avoid next-intl's
// createNavigation helper here — keeping the implementation a few lines of
// vanilla Next routing makes it easier to embed inline in any public layout
// without dragging the routing types around.
export function LanguagePicker() {
  const t = useTranslations("language_picker");
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const currentLocale = useLocale();
  const [pending, startTransition] = useTransition();

  // The root layout survives App Router transitions, so its pre-paint locale
  // script only runs on the first document load. Keep the document language
  // synchronized when this picker changes locale client-side; otherwise the
  // translated page remains announced as the previous language by assistive
  // technology until a full reload.
  useEffect(() => {
    document.documentElement.lang = currentLocale;
  }, [currentLocale]);

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isLocale(next) || next === currentLocale) return;

    // Replace the leading locale segment, if present. The middleware always
    // prefixes public routes with a locale, so we expect the path to look
    // like /<locale>/<rest>. Defensive: if it doesn't, prepend.
    const segments = pathname.split("/");
    if (segments.length >= 2 && isLocale(segments[1])) {
      segments[1] = next;
    } else {
      segments.splice(1, 0, next);
    }
    const target = segments.join("/") || "/";
    // usePathname intentionally omits these. Keep token-surface modes such as
    // ?frequency=true and any in-page destination intact when changing only
    // the language segment.
    const suffix = `${window.location.search}${window.location.hash}`;

    startTransition(() => {
      // replace() already fetches and installs the new locale segment. Calling
      // refresh() in the same transition can race it and re-install the old
      // segment's RSC payload: the address bar changes while the copy remains
      // in the previous language.
      router.replace(asRoute(`${target}${suffix}`));
    });
  }

  return (
    <label className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-9">
      <span>{t("label")}:</span>
      <select
        aria-label={t("label")}
        value={currentLocale}
        onChange={onChange}
        disabled={pending}
        className="min-h-11 rounded-md border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60 sm:min-h-9"
      >
        {locales.map((locale) => (
          <option key={locale} value={locale}>
            {localeLabels[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
