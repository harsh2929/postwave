// SPDX-License-Identifier: AGPL-3.0-only
//
// Confirmation landing for double opt-in. The user clicks a link in the
// confirmation email; we hit the gateway's public /confirm/:token endpoint
// and show one of three end states.
import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Clock3, Link2Off } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { confirmPublicFormToken } from "@/lib/public-pages-api";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function ConfirmPage({
  params,
}: {
  params: Promise<{ slug: string; token: string; locale: string }>;
}) {
  const { slug, token, locale } = await params;
  setRequestLocale(locale);
  const [state, t] = await Promise.all([
    confirmPublicFormToken(token),
    getTranslations("forms"),
  ]);

  const title =
    state === "confirmed"
      ? t("confirm_confirmed_title")
      : state === "already"
        ? t("confirm_already_title")
        : state === "expired"
          ? t("confirm_expired_title")
          : state === "missing"
            ? t("confirm_missing_title")
            : t("confirm_unavailable_title");
  const body =
    state === "confirmed"
      ? t("confirm_confirmed_body")
      : state === "already"
        ? t("confirm_already_body")
        : state === "expired"
          ? t("confirm_expired_body")
          : state === "missing"
            ? t("confirm_missing_body")
            : t("confirm_unavailable_body");
  const Icon =
    state === "confirmed" || state === "already"
      ? CheckCircle2
      : state === "expired"
        ? Clock3
        : state === "missing"
          ? Link2Off
          : AlertCircle;
  const iconTone =
    state === "confirmed" || state === "already"
      ? "bg-emerald-100 text-emerald-700"
      : state === "unavailable"
        ? "bg-amber-100 text-amber-800"
        : "bg-muted text-muted-foreground";

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-5 text-center shadow-sm sm:p-8">
      <div
        aria-hidden="true"
        className={`mx-auto flex size-11 items-center justify-center rounded-full ${iconTone}`}
      >
        <Icon className="size-5" />
      </div>
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="break-words text-sm leading-6 text-muted-foreground">
        {body}
      </p>
      {state === "expired" ? (
        <div className="pt-2">
          <Link
            href={`/${locale}/forms/${encodeURIComponent(slug)}`}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("confirm_resubscribe")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
