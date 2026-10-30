// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";

export interface ApiReferenceGroupPreview {
  tag: string;
  slug: string;
  operationCount: number;
}

/**
 * Lightweight entry point into the canonical server-rendered API reference.
 * The former Redoc embed downloaded a 1 MiB client runtime and pulled a
 * vulnerable React-Native/Metro peer graph into the web dependency closure.
 */
export function ApiReferencePreview({
  groups,
  operationCount,
  specUrl,
}: {
  groups: ApiReferenceGroupPreview[];
  operationCount: number;
  specUrl: string;
}): JSX.Element {
  return (
    <div className="space-y-6 p-5 sm:p-7">
      <header className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-widest text-pw-ember-700">
          Browse the reference
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-pw-ink2">
          Request and response contracts without a heavyweight client runtime
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-pw-muted-on-paper">
          Published operations have stable, server-rendered detail pages showing
          their contract details, plus copyable curl examples. Start with a
          common API area or open all {operationCount} operations in the
          published contract.
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => (
          <li key={group.slug}>
            <Link
              href={`/docs/api?tag=${encodeURIComponent(group.slug)}`}
              prefetch={false}
              className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-pw-line px-4 py-3 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              <span className="font-medium text-pw-ink2">{group.tag}</span>
              <span className="text-xs tabular-nums text-pw-muted-on-paper">
                {group.operationCount} endpoints
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/docs/api"
          className="inline-flex min-h-11 items-center rounded-md bg-pw-ember-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pw-ember-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
        >
          Browse published API operations
        </Link>
        <a
          href={specUrl}
          className="inline-flex min-h-11 items-center rounded-md border border-pw-line px-4 py-2 font-mono text-sm text-pw-ink2 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
        >
          Download OpenAPI JSON
        </a>
      </div>
    </div>
  );
}
