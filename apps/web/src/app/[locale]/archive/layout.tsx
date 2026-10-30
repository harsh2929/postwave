// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { LanguagePicker } from "@/components/LanguagePicker";

export default async function PublicArchiveLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const [t, tCommon] = await Promise.all([
    getTranslations("forms"),
    getTranslations("common"),
  ]);

  return (
    <div className="flex min-h-dvh flex-col overflow-x-hidden bg-background text-foreground">
      <a
        href="#archive-main"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-foreground focus:px-3 focus:text-sm focus:font-medium focus:text-background focus:not-sr-only"
      >
        {tCommon("skip_to_content")}
      </a>
      <main id="archive-main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <footer className="border-t bg-muted/20 px-4 py-4 text-xs text-muted-foreground [padding-bottom:max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-between gap-3 sm:flex-row">
          <LanguagePicker />
          <div className="flex min-h-11 items-center sm:min-h-9">
            {t("powered_by")}{" "}
            <a
              href="https://moosewave.com"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9"
            >
              Moosewave
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
