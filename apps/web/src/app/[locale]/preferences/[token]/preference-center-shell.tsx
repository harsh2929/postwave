// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";

import type { PublicPreferenceCustomization } from "@/lib/preferences-api";
import { preferredContrastingTextColor } from "@/lib/preference-branding-security";

interface PreferenceCenterShellProps {
  children: ReactNode;
  customization: PublicPreferenceCustomization;
  poweredBy: string;
}

export function preferenceAccentForeground(primaryColor: string) {
  return preferredContrastingTextColor(primaryColor);
}

/** Subscriber-safe rendering of the tenant's verified preference-center theme. */
export function PreferenceCenterShell({
  children,
  customization,
  poweredBy,
}: PreferenceCenterShellProps) {
  const footerVisible =
    customization.footer_text.length > 0 || customization.show_postwave_badge;
  const accentStyle: CSSProperties = {
    borderTopColor: customization.primary_color,
  };

  return (
    <section
      className="space-y-5 rounded-2xl border border-t-4 bg-card p-5 shadow-sm sm:p-8"
      style={accentStyle}
      data-testid="preference-center-shell"
    >
      {customization.logo_url ? (
        <div className="flex min-h-12 items-center justify-center border-b pb-4">
          {/* A tenant-supplied HTTPS image is intentionally rendered without a
              referrer so the capability token never reaches that host. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={customization.logo_url}
            alt=""
            referrerPolicy="no-referrer"
            decoding="async"
            className="max-h-14 max-w-[min(100%,16rem)] object-contain"
          />
        </div>
      ) : null}

      {children}

      {footerVisible ? (
        <footer className="space-y-2 border-t pt-4 text-center text-xs leading-5 text-muted-foreground">
          {customization.footer_text ? (
            <p className="whitespace-pre-wrap break-words">
              {customization.footer_text}
            </p>
          ) : null}
          {customization.show_postwave_badge ? (
            <p>
              {poweredBy}{" "}
              <a
                href="https://moosewave.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9"
              >
                Moosewave
              </a>
            </p>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
