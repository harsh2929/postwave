// SPDX-License-Identifier: AGPL-3.0-only
//
// Generic success landing. Used when a form's settings have no
// successRedirectUrl and the submit endpoint returns a redirect to
// /forms/success?form=<slug>&mode=<mode>. The mode matches the submit
// answer: "double" (a confirmation email is on its way), "received" (a
// response that did not ask to subscribe), anything else "single".
//
// A form that set a Success message gets it shown here, in both signup modes:
// the setting used to reach nothing at all, so a form configured to say
// something of its own still read "Thanks for signing up." A "received"
// response is not a signup, and the success message is written for signups, so
// that state keeps its own copy (the submit endpoint withholds the message
// there too).
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CheckCircle2, MailCheck } from "lucide-react";

import { fetchPublicFormSuccessMessage } from "@/lib/public-pages-api";

export default async function FormSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ form?: string; mode?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations("forms");
  const received = sp.mode === "received";
  // Authored copy is only fetched for a state it applies to, so the "received"
  // page costs no request.
  const authored =
    received || !sp.form ? "" : await fetchPublicFormSuccessMessage(sp.form);
  const copy =
    sp.mode === "double"
      ? {
          Icon: MailCheck,
          title: t("success_almost_there"),
          body: authored || t("success_double_check_inbox"),
        }
      : received
        ? {
            Icon: CheckCircle2,
            title: t("success_received_title"),
            body: t("success_received_body"),
          }
        : {
            Icon: CheckCircle2,
            title: t("success_title"),
            body: authored || t("success_thanks"),
          };
  const { Icon } = copy;

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-5 text-center shadow-sm sm:p-8">
      <div
        aria-hidden="true"
        className="mx-auto flex size-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
      >
        <Icon className="size-5" />
      </div>
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {copy.title}
      </h1>
      {/* Authored by the workspace and rendered as text, never as markup. */}
      <p className="whitespace-pre-line break-words text-sm leading-6 text-muted-foreground">
        {copy.body}
      </p>
    </div>
  );
}
