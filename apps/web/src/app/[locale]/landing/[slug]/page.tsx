// SPDX-License-Identifier: AGPL-3.0-only
import { cache, type ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { LanguagePicker } from "@/components/LanguagePicker";
import { buildLandingMetadata } from "@/lib/landing-page-content";
import {
  fetchPublicLandingPage,
  visitorIPFromHeaders,
} from "@/lib/public-pages-api";
import { LandingSubscribeForm } from "./subscribe-form";

// One shared, request-memoized load so generateMetadata and the page render
// from a SINGLE upstream fetch — the public fetch records a "view" event, and
// React cache() dedup keeps metadata from double-counting it.
const loadLanding = cache((slug: string, visitorIP: string) =>
  fetchPublicLandingPage(slug, undefined, visitorIP),
);

function LandingFrame({
  children,
  skipLabel,
}: {
  children: ReactNode;
  skipLabel: string;
}) {
  return (
    <>
      <a
        href="#landing-main"
        className="sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-foreground focus:px-3 focus:text-sm focus:font-medium focus:text-background focus:not-sr-only"
      >
        {skipLabel}
      </a>
      <main
        id="landing-main"
        tabIndex={-1}
        className="min-h-dvh overflow-x-hidden bg-background outline-none"
      >
        {children}
      </main>
    </>
  );
}

function originFromHeaders(
  h: Awaited<ReturnType<typeof headers>>,
): string | undefined {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return undefined;
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

// Emit <title>, meta description, canonical and OpenGraph/Twitter tags derived
// from the page's seo{} (falling back to name/hero body) so hosted landing
// pages no longer ship the app's default document head (LAND-007).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const h = await headers();
  const visitorIP = visitorIPFromHeaders(h);
  const result = await loadLanding(slug, visitorIP);
  if (
    result.kind !== "ok" ||
    !result.data ||
    result.data.status !== "published"
  ) {
    return { title: "Landing page", robots: { index: false, follow: false } };
  }
  const meta = buildLandingMetadata(result.data, originFromHeaders(h));
  const images = meta.ogImage ? [meta.ogImage] : undefined;
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: meta.canonical },
    openGraph: {
      type: "website",
      title: meta.title,
      description: meta.description,
      url: meta.canonical,
      images,
    },
    twitter: {
      card: meta.ogImage ? "summary_large_image" : "summary",
      title: meta.title,
      description: meta.description,
      images,
    },
  };
}

export default async function PublicLandingPage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  setRequestLocale(locale);
  const visitorIP = visitorIPFromHeaders(await headers());
  const [result, t, tCommon] = await Promise.all([
    loadLanding(slug, visitorIP),
    getTranslations("landing"),
    getTranslations("common"),
  ]);
  if (result.kind === "unavailable") {
    return (
      <LandingFrame skipLabel={tCommon("skip_to_content")}>
        <section className="mx-auto flex min-h-dvh max-w-5xl flex-col justify-center px-5 py-16 text-center sm:px-8">
          <h1 className="break-words text-3xl font-semibold tracking-tight">
            {t("unavailable_title")}
          </h1>
          <p className="mx-auto mt-4 max-w-xl break-words text-sm leading-6 text-muted-foreground">
            {t("unavailable_body")}
          </p>
          <div className="mt-10 flex justify-center">
            <LanguagePicker />
          </div>
        </section>
      </LandingFrame>
    );
  }
  if (result.kind !== "ok") notFound();
  const page = result.data;
  if (!page || page.status !== "published") notFound();

  const hero = page.blocks.find((block) => block.type === "hero") ?? {};
  const heading = text(hero.heading) || page.name;
  // The landing page body is publisher-authored content in their own
  // language. Only the fallback (when the publisher hasn't filled it in)
  // is translated — we don't translate publisher copy.
  const body = text(hero.body) || t("default_body");

  return (
    <LandingFrame skipLabel={tCommon("skip_to_content")}>
      <section className="mx-auto flex min-h-dvh max-w-5xl flex-col justify-center px-5 py-16 sm:px-8">
        <div className="min-w-0 max-w-3xl">
          <Badge variant="secondary" className="mb-5 max-w-full break-all">
            {page.template}
          </Badge>
          <h1 className="break-words text-4xl font-semibold tracking-tight sm:text-6xl">
            {heading}
          </h1>
          <p className="mt-5 max-w-2xl break-words text-base leading-7 text-muted-foreground sm:text-lg">
            {body}
          </p>
          <LandingSubscribeForm
            slug={page.slug}
            variantToken={page.variant_token}
          />
        </div>
        <div className="mt-14 grid gap-3 sm:grid-cols-3">
          {page.blocks
            .filter(
              (block) => block.type !== "hero" && block.type !== "signup_form",
            )
            .slice(0, 3)
            .map((block, index) => (
              <article
                key={index}
                className="min-w-0 rounded-xl border bg-card p-5 shadow-sm"
              >
                <h2 className="break-words text-sm font-semibold">
                  {text(block.heading) ||
                    text(block.title) ||
                    t("feature_fallback")}
                </h2>
                <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                  {text(block.body) || text(block.content) || ""}
                </p>
              </article>
            ))}
        </div>
        <div className="mt-10 flex justify-end">
          <LanguagePicker />
        </div>
      </section>
    </LandingFrame>
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
