// SPDX-License-Identifier: AGPL-3.0-only
//
// Graceful end state when a preference token is past expires_at. We don't
// reveal which email the (now-invalid) token was bound to — that's a
// privacy leak. Subscribers can request a fresh link from any email we send
// them.
import { getTranslations, setRequestLocale } from "next-intl/server";

export default async function PreferencesExpiredPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("preferences");
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-5 text-center shadow-sm sm:p-8">
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {t("expired_title")}
      </h1>
      <p className="break-words text-sm leading-6 text-muted-foreground">
        {t("expired_body")}
      </p>
      <p className="break-words text-xs leading-5 text-muted-foreground">
        {t("expired_unsubscribe_hint")}
      </p>
    </div>
  );
}
