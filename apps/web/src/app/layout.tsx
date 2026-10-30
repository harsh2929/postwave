// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import "./globals.css";

import { InstallPromptLoader } from "@/components/install-prompt-loader";
import { PwaRegistrarLoader } from "@/components/pwa-registrar-loader";
import { WebVitalsReporterLoader } from "@/components/seo/web-vitals-reporter-loader";
import { TelemetryProviderLoader } from "@/components/telemetry-provider-loader";
import { ThemedToaster } from "@/components/themed-toaster";
import { documentLocaleFromParams } from "@/lib/document-locale";
import {
  DOCUMENT_LOCALE_SCRIPT,
  THEME_SCRIPT,
} from "@/lib/root-layout-scripts";
import { publicSiteOrigin } from "@/lib/site-url";

const SITE_URL = publicSiteOrigin();
const WEB_VITALS_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_WEB_VITALS_ENDPOINT?.trim(),
);

export const metadata: Metadata = {
  // Resolves all relative og: / twitter: / canonical URLs against the
  // production origin so OpenGraph image references like '/opengraph-image'
  // become absolute URLs in the emitted HTML.
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Moosewave",
    template: "%s · Moosewave",
  },
  description:
    "A pre-production newsletter platform undergoing release qualification.",
  manifest: "/manifest.webmanifest",
  applicationName: "Moosewave",
  authors: [{ name: "Moosewave" }],
  creator: "Moosewave",
  publisher: "Moosewave",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

// PWA viewport theme color tints the in-browser chrome (Android status bar,
// iOS Safari toolbar) to match the page surface — warm paper in light, ink in
// dark — so the chrome reads as a seamless extension of the page. (The
// standalone-app title bar uses manifest.theme_color = highlighter yellow
// #FFDF38 instead, matching the tactile action color.) Separate `viewport`
// export per Next.js 14+ App Router conventions.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FDFCF8" },
    { media: "(prefers-color-scheme: dark)", color: "#0F0F0F" },
  ],
  colorScheme: "light dark",
};

// Pathname-aware no-flash theme script: runs synchronously before paint so a
// dark-mode user never sees a light flash on load. Only the /app dashboard
// honors the stored theme; marketing/docs are always light (they mix fixed
// pw-* + flipping semantic tokens and aren't dark-audited). The next-themes
// providers (per route group) take over for interactive toggling + persistence.
export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params?: Promise<{ locale?: string | string[] }>;
}) {
  // A request-specific CSP nonce cannot be embedded in prerendered HTML.
  // Opt every document into request rendering so middleware's strict nonce
  // policy and Next's framework/bootstrap scripts always agree.
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const lang = documentLocaleFromParams(params ? await params : undefined);

  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="font-sans antialiased">
        {/* These two pre-paint scripts carry a per-request CSP `nonce`. Browsers
            blank the nonce *content attribute* from the DOM after applying CSP
            (an anti-exfiltration measure), so at hydration the server-rendered
            `nonce="…"` no longer matches the now-empty DOM attribute — the
            app-global "tree hydrated but some attributes didn't match" warning
            that fired on every route (SHELL-001). Scope the suppression to
            exactly these two nodes; do NOT widen it to <body>. The script
            bodies are unchanged, so their CSP SHA-256 allow-list still matches. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: DOCUMENT_LOCALE_SCRIPT }}
        />
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
        {children}
        <ThemedToaster />
        {WEB_VITALS_ENABLED ? <WebVitalsReporterLoader /> : null}
        <PwaRegistrarLoader />
        <InstallPromptLoader />
        {/* useSearchParams() in TelemetryProvider requires a Suspense
            boundary in App Router; otherwise the entire tree opts out
            of static rendering. */}
        <Suspense fallback={null}>
          <TelemetryProviderLoader />
        </Suspense>
      </body>
    </html>
  );
}
