// SPDX-License-Identifier: AGPL-3.0-only
//
// The server reads the bundled spec only for the small operation/path counts.
// The full spec stays server-side. This page sends only counts and a small set
// of reference-group links; operation details live under /docs/api.

import type { Metadata } from "next";
import Link from "next/link";

import {
  defaultServerUrl,
  getSpec,
  listOperations,
  operationsByTag,
} from "@/lib/docs/loadOpenAPI";
import { pageMetadata } from "@/lib/marketing-metadata";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";
import { asRoute } from "@/lib/typed-routes";
import { ApiReferencePreview } from "./_components/api-reference-preview";

export const metadata: Metadata = pageMetadata({
  title: "Moosewave API reference",
  description:
    "Browse Moosewave REST and SSE operations published in the OpenAPI 3.1 contract. MCP distribution remains a release-held source candidate.",
  path: "/api-docs",
});

const spec = getSpec();

const SIDE_LINKS: { href: string; label: string; sub: string }[] = [
  {
    href: "/forge/docs",
    label: "Agent overview",
    sub: "Release-held source architecture; not runnable setup.",
  },
  {
    href: "/mcp",
    label: "MCP source catalogue",
    sub: "Mutable candidate definitions under release hold.",
  },
  {
    href: "/docs/api",
    label: "Endpoint reference",
    sub: "Operation-by-operation request and response documentation.",
  },
];

const PATH_COUNT = Object.keys(spec.paths ?? {}).length;
const OPERATION_COUNT = listOperations().length;
const FEATURED_API_TAGS = new Set([
  "Subscribers",
  "Campaigns",
  "Segments",
  "Automations",
  "Templates",
  "Forms",
  "Outbound Webhooks",
  "Privacy",
]);
const FEATURED_API_GROUPS = operationsByTag()
  .filter((group) => FEATURED_API_TAGS.has(group.tag))
  .map((group) => ({
    tag: group.tag,
    slug: group.slug,
    operationCount: group.operations.length,
  }));
const SERVER_URL = defaultServerUrl();
const VERSION = spec.info?.version ?? "v1";

export default function ApiDocsPage(): JSX.Element {
  return (
    <div className="max-w-6xl mx-auto px-6 py-12 md:py-16">
      <header className="max-w-3xl space-y-4">
        <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-700">
          API reference
        </div>
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight">
          Moosewave API
        </h1>
        <p className="text-lg text-pw-muted-on-paper">
          REST + SSE: {OPERATION_COUNT} operations across {PATH_COUNT} paths in{" "}
          {VERSION}. Browse below, or generate a client from the spec.
        </p>
        <p className="text-sm text-pw-muted-on-paper">
          This reference covers the operations published in OpenAPI. A mounted
          gateway route remains outside OpenAPI and the SDK only when its exact
          method and path have a reviewed gateway-only exclusion.
        </p>
        <p className="text-sm text-pw-muted-on-paper">
          <code>{MCP_RELEASE_HOLD_CODE}</code>: {MCP_RELEASE_STATUS_COPY}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center rounded-md border border-pw-surface px-3 py-1.5 font-mono text-pw-muted-on-paper">
            {SERVER_URL}
          </span>
          <a
            href="/api/openapi.json"
            className="inline-flex items-center rounded-md border border-pw-surface px-3 py-1.5 font-mono hover:border-pw-ember-500 transition-colors"
          >
            openapi.json
          </a>
          <Link
            href="/mcp"
            className="inline-flex items-center rounded-md border border-pw-surface px-3 py-1.5 hover:border-pw-ember-500 transition-colors"
          >
            MCP source catalogue · release held
          </Link>
        </div>
      </header>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8">
        <aside
          aria-label="Related references"
          className="lg:sticky lg:top-20 lg:self-start"
        >
          <div className="text-xs font-semibold uppercase tracking-wider text-pw-muted-on-paper mb-3">
            Related
          </div>
          <ul className="space-y-3 text-sm">
            {SIDE_LINKS.map((l) => {
              const className =
                "block rounded-md border border-pw-surface p-3 hover:border-pw-ember-500 transition-colors";
              const inner = (
                <>
                  <div className="font-medium text-pw-ink2">{l.label}</div>
                  <div className="mt-1 text-xs text-pw-muted-on-paper">
                    {l.sub}
                  </div>
                </>
              );
              return (
                <li key={l.href}>
                  {l.href.startsWith("http") ? (
                    <a
                      href={l.href}
                      rel="noopener noreferrer"
                      className={className}
                    >
                      {inner}
                    </a>
                  ) : (
                    <Link href={asRoute(l.href)} className={className}>
                      {inner}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>

        <section
          aria-label="OpenAPI reference"
          className="min-w-0 rounded-lg border border-pw-surface bg-white"
        >
          <ApiReferencePreview
            groups={FEATURED_API_GROUPS}
            operationCount={OPERATION_COUNT}
            specUrl="/api/openapi.json"
          />
        </section>
      </div>
    </div>
  );
}
