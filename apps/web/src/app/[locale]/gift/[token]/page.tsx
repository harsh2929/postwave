// SPDX-License-Identifier: AGPL-3.0-only
//
// Historical gift links land on an explicit unsupported-state page. Paid
// gift lookup and claim are not enabled without a verified Stripe adapter.
import type { Metadata } from "next";
import { Gift } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { PublicSubscriberLayout } from "@/components/public-subscriber-layout";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function GiftPage({
  params,
}: {
  params: Promise<{ token: string; locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tForms, tCommon] = await Promise.all([
    getTranslations("gift"),
    getTranslations("forms"),
    getTranslations("common"),
  ]);
  return (
    <PublicSubscriberLayout
      poweredBy={tForms("powered_by")}
      skipLabel={tCommon("skip_to_content")}
    >
      <GiftCard title={t("unavailable_title")} body={t("unavailable_body")} />
    </PublicSubscriberLayout>
  );
}

/**
 * Small terminal-state card used for the four non-happy paths.
 * Pulled out so each branch is one line in the parent.
 */
function GiftCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
      <div
        aria-hidden="true"
        className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Gift className="size-5" />
      </div>
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="break-words text-sm leading-6 text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
