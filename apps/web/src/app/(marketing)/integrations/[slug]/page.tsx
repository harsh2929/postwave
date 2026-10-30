// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-integration detail page. Generic template that reads from
// src/lib/integrations.ts. Pre-rendered at build via generateStaticParams
// so every integration ships as a static page with structured data.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  JsonLd,
  breadcrumbSchema,
  softwareApplicationSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations";
import { asRoute } from "@/lib/typed-routes";

const SITE = "https://moosewave.com";

interface RouteParams {
  slug: string;
}

interface PageProps {
  params: Promise<RouteParams>;
}

export async function generateStaticParams(): Promise<RouteParams[]> {
  return INTEGRATIONS.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    return {
      title: "Integration not found | Moosewave",
      description: "This integration doesn't exist.",
    };
  }

  const url = `${SITE}/integrations/${integration.slug}`;
  const title = `${integration.name} integration | Moosewave`;
  return {
    title,
    description: integration.summary,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      url,
      title,
      description: integration.summary,
      siteName: "Moosewave",
      locale: "en_US",
      images: [
        {
          url: `/integrations/${integration.slug}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `${integration.name} for Moosewave`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: integration.summary,
      creator: "@moosewave",
    },
  };
}

export default async function IntegrationDetailPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    notFound();
  }

  const url = `${SITE}/integrations/${integration.slug}`;

  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: SITE },
    { name: "Integrations", url: `${SITE}/integrations` },
    { name: integration.name, url },
  ]);

  const howTo: JsonLdObject | null = integration.runtimeHoldCode
    ? null
    : {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: `Set up ${integration.name} with Moosewave`,
        description: integration.summary,
        step: integration.setupSteps.map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.title,
          text: s.body,
        })),
        // No totalTime: the Integration model carries no per-integration setup
        // duration, and a single hardcoded value asserted the same 10 minutes for
        // every one — from a webhook paste to a cross-account AWS IAM role. The
        // property is optional in schema.org HowTo, so the honest move is to omit
        // it rather than publish a number nothing backs. Add it back per
        // integration if the model ever carries a real estimate.
      };

  const software = softwareApplicationSchema({
    name: "Moosewave",
    description:
      "Moosewave — newsletter platform with dry-run-first migrations, controlled-inbox deliverability evidence, and voice-trained AI sequences.",
    url: SITE,
    applicationCategory: "BusinessApplication",
    publisherName: "Moosewave",
    publisherUrl: SITE,
  });

  return (
    <div className="bg-pw-paper">
      <JsonLd
        data={[breadcrumbs, ...(howTo ? [howTo] : []), software]}
        id={`integration-jsonld-${integration.slug}`}
      />

      {/* === Header === */}
      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-14 pb-12 md:pt-20 md:pb-16">
          <nav aria-label="Breadcrumb" className="text-xs text-pw-muted-on-ink">
            <Link
              href="/integrations"
              className="hover:text-white transition-colors"
            >
              ← All integrations
            </Link>
          </nav>
          <div className="mt-6 flex items-center gap-4">
            <span
              aria-hidden
              className="h-12 w-12 rounded-md border border-white/15 bg-white/[0.05] flex items-center justify-center text-sm font-mono text-white/80"
            >
              {integration.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
                {integration.category}
              </div>
              <h1 className="text-3xl md:text-5xl font-semibold tracking-tight leading-tight">
                {integration.name}
              </h1>
            </div>
          </div>
          <p className="mt-6 text-base md:text-lg text-pw-muted-on-ink max-w-2xl">
            {integration.summary}
          </p>
        </div>
      </section>

      {/* === What it does === */}
      <section className="bg-pw-paper">
        <div className="max-w-3xl mx-auto px-6 py-14 md:py-20 space-y-16">
          <section aria-labelledby="what-heading">
            <h2
              id="what-heading"
              className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
            >
              What it does
            </h2>
            <div className="mt-5 space-y-4 text-pw-ink2/80 leading-relaxed">
              {integration.description.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>

            {integration.runtimeHoldCode ? (
              <div
                className="mt-7 rounded-lg border border-pw-ember-700/40 bg-pw-ember-50 p-5 text-sm text-pw-ink2"
                role="status"
              >
                <strong>Coming soon</strong>
                <p className="mt-2">
                  Setup and provider actions are not available from this catalog
                  entry yet. No runtime request was sent. Hold code:{" "}
                  <code>{integration.runtimeHoldCode}</code>.
                  {integration.callbackIngressHoldCode ? (
                    <>
                      {" "}
                      Public callback ingress is separately held. Hold code:{" "}
                      <code>{integration.callbackIngressHoldCode}</code>.
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}

            {integration.capabilities.length > 0 ? (
              <ul className="mt-7 grid gap-2 sm:grid-cols-2">
                {integration.capabilities.map((c) => (
                  <li
                    key={c}
                    className="flex gap-2 items-start text-sm text-pw-ink2/80"
                  >
                    <span aria-hidden className="text-pw-ember-600 leading-6">
                      ✓
                    </span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {!integration.runtimeHoldCode ? (
            <>
              {/* === Setup in 3 steps === */}
              <section aria-labelledby="setup-heading">
                <h2
                  id="setup-heading"
                  className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
                >
                  Setup in 3 steps
                </h2>
                <ol className="mt-6 space-y-5">
                  {integration.setupSteps.map((step, i) => (
                    <li
                      key={step.title}
                      className="rounded-lg border border-pw-ink2/10 bg-pw-paper p-5"
                    >
                      <div className="flex items-baseline gap-3">
                        <span className="font-mono text-xs text-pw-ember-700 font-semibold tabular-nums">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <h3 className="text-base font-semibold text-pw-ink2">
                          {step.title}
                        </h3>
                      </div>
                      <p className="mt-2 text-sm text-pw-ink2/80 leading-relaxed">
                        {step.body}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>

              {/* === Code example === */}
              <section aria-labelledby="example-heading">
                <h2
                  id="example-heading"
                  className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
                >
                  Code example
                </h2>
                <div className="mt-5 rounded-lg overflow-hidden border border-pw-line bg-pw-ink">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 text-xs font-mono text-white/60">
                    <span>{integration.example.language}</span>
                    <span>{integration.name.toLowerCase()} example</span>
                  </div>
                  <pre
                    tabIndex={0}
                    role="group"
                    aria-label={`${integration.name} example`}
                    className="overflow-x-auto p-4 text-sm leading-relaxed text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                  >
                    <code>{integration.example.code}</code>
                  </pre>
                </div>
                {integration.docsLink ? (
                  <p className="mt-3 text-xs text-pw-muted-on-paper">
                    Read the full reference at{" "}
                    <Link
                      href={asRoute(integration.docsLink)}
                      className="text-pw-ember-700 underline decoration-pw-ember-500/70 underline-offset-2 transition-colors hover:text-pw-ember-800 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
                    >
                      {integration.docsLink}
                    </Link>
                    .
                  </p>
                ) : null}
              </section>
            </>
          ) : null}

          {/* === Related === */}
          {integration.related.length > 0 ? (
            <section aria-labelledby="related-heading">
              <h2
                id="related-heading"
                className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
              >
                Related
              </h2>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {integration.related.map((r) => (
                  <li key={r.href}>
                    <Link
                      href={asRoute(r.href)}
                      className="block rounded-lg border border-pw-ink2/10 bg-pw-paper p-4 hover:border-pw-ember-500 hover:text-pw-ember-700 transition-colors text-sm font-medium text-pw-ink2"
                    >
                      {r.label} →
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </section>

      {/* === Internal-link footer === */}
      <section className="border-t border-pw-surface bg-pw-surface/40">
        <div className="max-w-3xl mx-auto px-6 py-12 grid gap-6 sm:grid-cols-3 text-sm">
          <Link
            href="/integrations"
            className="text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
          >
            ← All integrations
          </Link>
          <Link
            href="/features"
            className="text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium"
          >
            Moosewave features →
          </Link>
          <Link
            href="/security"
            className="text-pw-ink2 hover:text-pw-ember-700 transition-colors font-medium sm:text-right"
          >
            Security and compliance →
          </Link>
        </div>
      </section>
    </div>
  );
}
