// SPDX-License-Identifier: AGPL-3.0-only
//
// Public hosted preference-center layout. NO sidebar, NO auth. Mirrors the
// /forms layout so the hosted page feels consistent with the publisher's
// signup page.
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { PublicSubscriberLayout } from "@/components/public-subscriber-layout";

export default async function PublicPreferencesLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [t, tCommon] = await Promise.all([
    getTranslations("forms"),
    getTranslations("common"),
  ]);
  return (
    <PublicSubscriberLayout
      poweredBy={t("powered_by")}
      skipLabel={tCommon("skip_to_content")}
      showPoweredBy={false}
    >
      {children}
    </PublicSubscriberLayout>
  );
}
