// SPDX-License-Identifier: AGPL-3.0-only
//
// Public hosted-form layout. NO sidebar, NO auth — this is the root for
// pages served at forms.moosewave.com/forms/<slug>. We deliberately keep chrome
// minimal so embedded iframes look clean and the hosted page feels like the
// publisher's own page, not Moosewave's dashboard.
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { PublicSubscriberLayout } from "@/components/public-subscriber-layout";

export default async function PublicFormsLayout({
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
    >
      {children}
    </PublicSubscriberLayout>
  );
}
