// Moosewave docs - API reference index page.
//
// The spec carries 1,955 operations across 174 tags. Rendering every one of
// them as a row produced a ~1.2 MB HTML document (plus an equivalent flight
// payload, plus ~10,000 DOM nodes against an app-wide 3,000-node budget), and
// registered 1,955 viewport prefetches on top — for a page nobody reads
// end-to-end (RSC-02).
//
// So the index paginates by tag, with a real URL per tag:
//   /docs/api            → every tag, with its first few endpoints as a preview
//   /docs/api?tag=<slug> → that one tag, complete
// The tag slug comes from operationsByTag() so the jump-list anchor, the
// section id and the ?tag= value are the same value throughout — the drift
// between two independent slug computations is what api-tag-anchors.test.ts
// exists to prevent. Each row still links to /docs/api/[endpoint] for detail.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import {
  defaultServerUrl,
  getSpec,
  listOperations,
  operationsByTag,
  type FlatOperation,
} from "@/lib/docs/loadOpenAPI";

export const metadata: Metadata = {
  title: "API reference · Moosewave docs",
  description:
    "Moosewave REST API reference for operations published in the OpenAPI 3.1 contract, including request and response details.",
  alternates: { canonical: "/docs/api" },
};

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-700 bg-emerald-50 border-emerald-200",
  POST: "text-blue-700 bg-blue-50 border-blue-200",
  PUT: "text-amber-700 bg-amber-50 border-amber-200",
  PATCH: "text-orange-700 bg-orange-50 border-orange-200",
  DELETE: "text-red-700 bg-red-50 border-red-200",
};

/** Rows shown per tag on the all-tags view before "view all" takes over. */
const PREVIEW_ROWS = 3;

function OperationRow({ op }: { op: FlatOperation }): JSX.Element {
  const m = op.method.toUpperCase();
  return (
    <Link
      href={`/docs/api/${op.slug}`}
      data-testid="api-operation"
      // Viewport prefetching across hundreds of endpoint routes is a network
      // storm of its own; the row is one click either way.
      prefetch={false}
      className="flex min-h-11 items-center gap-3 px-3 py-2 transition-colors hover:bg-pw-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
    >
      <span
        className={`inline-flex items-center justify-center rounded-sm border px-1 text-[10px] font-mono font-bold w-12 flex-none leading-4 ${
          METHOD_COLORS[m] ??
          "border-pw-line bg-pw-surface text-pw-muted-on-paper"
        }`}
      >
        {m}
      </span>
      <span className="font-mono text-xs text-pw-ink2 truncate flex-1">
        {op.path}
      </span>
      <span className="hidden sm:block text-xs text-pw-muted-on-paper truncate max-w-[40%]">
        {op.summary}
      </span>
    </Link>
  );
}

export default async function ApiIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}): Promise<JSX.Element> {
  const spec = getSpec();
  const groups = operationsByTag();
  const total = listOperations().length;
  const baseUrl = defaultServerUrl();

  const requestedTag = (await searchParams).tag;
  // An unknown ?tag= falls back to the all-tags view rather than 404ing: the
  // reference should always show something browseable.
  const active = requestedTag
    ? (groups.find((g) => g.slug === requestedTag) ?? null)
    : null;

  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          ...(active
            ? [
                { label: "API reference", href: "/docs/api" },
                { label: active.tag },
              ]
            : [{ label: "API reference" }]),
        ]}
      />
      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          API reference
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          {total} endpoints across {groups.length} tags ·{" "}
          {spec.info?.title ?? "Moosewave API"}{" "}
          {spec.info?.version ? `· ${spec.info.version}` : null}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border border-pw-line bg-white px-2 py-1 font-mono">
            {baseUrl}
          </span>
          <a
            href="/api/openapi.json"
            className="inline-flex min-h-11 items-center rounded-md border border-pw-line bg-white px-2 py-1 font-mono transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
          >
            openapi.json
          </a>
        </div>
      </header>

      <nav aria-label="Tag jump-list" className="flex flex-wrap gap-2 text-xs">
        {groups.map((g) =>
          active ? (
            // On a single-tag view the other sections are not on the page, so
            // a hash would go nowhere: the chip navigates to that tag instead.
            <Link
              key={g.tag}
              href={`/docs/api?tag=${g.slug}`}
              prefetch={false}
              aria-current={g.slug === active.slug ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full border px-3 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8 ${
                g.slug === active.slug
                  ? "border-pw-ember-500 bg-pw-ember-500/10 text-pw-ember-700"
                  : "border-pw-line bg-white hover:border-pw-ember-500"
              }`}
            >
              {g.tag}
              <span className="ml-1 text-pw-muted-on-paper tabular-nums">
                {g.operations.length}
              </span>
            </Link>
          ) : (
            <a
              key={g.tag}
              href={`#${g.slug}`}
              className="inline-flex min-h-11 items-center rounded-full border border-pw-line bg-white px-3 py-1 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
            >
              {g.tag}
              <span className="ml-1 text-pw-muted-on-paper tabular-nums">
                {g.operations.length}
              </span>
            </a>
          ),
        )}
      </nav>

      {active ? (
        <section id={active.slug} className="scroll-mt-20 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">
              {active.tag}
              <span className="ml-2 text-sm font-normal text-pw-muted-on-paper tabular-nums">
                {active.operations.length} endpoints
              </span>
            </h2>
            <Link
              href="/docs/api"
              prefetch={false}
              className="inline-flex min-h-11 items-center rounded-sm text-xs text-pw-ember-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
            >
              ← All tags
            </Link>
          </div>
          <div className="overflow-hidden rounded-md border border-pw-line bg-white divide-y divide-pw-line">
            {active.operations.map((op) => (
              <OperationRow key={op.slug} op={op} />
            ))}
          </div>
        </section>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => {
            const preview = g.operations.slice(0, PREVIEW_ROWS);
            const remaining = g.operations.length - preview.length;
            return (
              <section key={g.tag} id={g.slug} className="scroll-mt-20">
                <h2 className="text-xl font-semibold tracking-tight mb-3">
                  {g.tag}
                  <span className="ml-2 text-sm font-normal text-pw-muted-on-paper tabular-nums">
                    {g.operations.length}
                  </span>
                </h2>
                <div className="overflow-hidden rounded-md border border-pw-line bg-white divide-y divide-pw-line">
                  {preview.map((op) => (
                    <OperationRow key={op.slug} op={op} />
                  ))}
                  {remaining > 0 ? (
                    <Link
                      href={`/docs/api?tag=${g.slug}`}
                      prefetch={false}
                      className="flex min-h-11 items-center gap-2 px-3 py-2 text-xs text-pw-ember-700 transition-colors hover:bg-pw-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                    >
                      View all {g.operations.length} {g.tag} endpoints
                      <span aria-hidden>→</span>
                    </Link>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </article>
  );
}
