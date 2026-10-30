// Moosewave docs - per-endpoint detail page.
//
// Long-tail endpoint pages are generated and cached on first request. Baking
// every OpenAPI operation into the image added more than a GiB of duplicate
// HTML/RSC output without changing the URL or content contract.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { OpenAPIEndpoint } from "@/components/docs/OpenAPIEndpoint";
import { findOperationBySlug, operationsByTag } from "@/lib/docs/loadOpenAPI";

interface PageProps {
  params: Promise<{ endpoint: string }>;
}

export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = 86_400;

export function generateStaticParams(): [] {
  return [];
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { endpoint } = await params;
  const op = findOperationBySlug(endpoint);
  if (!op) {
    return { title: "Endpoint not found · Moosewave docs" };
  }
  return {
    title: `${op.method.toUpperCase()} ${op.path} · Moosewave API`,
    description: op.summary,
    alternates: { canonical: `/docs/api/${op.slug}` },
  };
}

export default async function EndpointPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { endpoint } = await params;
  const op = findOperationBySlug(endpoint);
  if (!op) {
    notFound();
  }
  // The tag crumb was inert text, so there was no one-click way back to the
  // group this endpoint belongs to — even though /docs/api renders exactly
  // that anchor, and the sibling skills page links its category crumb the same
  // way. The slug comes from operationsByTag rather than being re-derived here:
  // it disambiguates case-only tag collisions ("SMS" vs "Sms"), which a local
  // toLowerCase could not.
  const tagAnchor = operationsByTag().find(
    (g) => g.tag === op.primaryTag,
  )?.slug;

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "API", href: "/docs/api" },
          {
            label: op.primaryTag,
            ...(tagAnchor ? { href: `/docs/api#${tagAnchor}` } : {}),
          },
          { label: `${op.method.toUpperCase()} ${op.path}` },
        ]}
      />
      <OpenAPIEndpoint op={op} />
    </div>
  );
}
