// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";

import { CopyLink } from "@/components/marketing/copy-link";

export type ChangelogEntry = {
  version: string;
  date?: string;
  planned?: boolean;
  summary: string;
  highlights: string[];
};

type Filter = "all" | "shipped" | "planned";

function StatusBadge({ planned }: { planned?: boolean }): JSX.Element {
  // Distinct treatments so shipped vs planned is scannable without reading the
  // label, in both light and dark (MKTC-006). Shipped = solid emerald,
  // planned = amber outline.
  if (planned) {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
        Planned
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
      Shipped
    </span>
  );
}

function EntryCard({ entry }: { entry: ChangelogEntry }): JSX.Element {
  return (
    <article
      id={entry.version}
      className="group scroll-mt-20 rounded-lg border bg-pw-paper p-6"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-xl font-semibold tracking-tight">
          {entry.version}
        </h3>
        <CopyLink hash={entry.version} label={`Copy link to ${entry.version}`} />
        <span className="text-sm text-pw-muted-on-paper">
          {/* An undated entry is only "Roadmap" when it is actually planned;
              a shipped release whose date was never recorded must not be
              labelled as upcoming next to a "Shipped" badge. */}
          {entry.date ?? (entry.planned ? "Roadmap" : "Date not recorded")}
        </span>
        <StatusBadge planned={entry.planned} />
      </div>
      <p className="mt-4 text-sm leading-relaxed text-pw-muted-on-paper">
        {entry.summary}
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        {entry.highlights.map((h) => (
          <li key={h} className="flex gap-2">
            <span
              aria-hidden
              className="mt-2 inline-block h-1 w-1 flex-none rounded-full bg-pw-ember-500"
            />
            <span className="leading-relaxed">{h}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "shipped", label: "Shipped" },
  { key: "planned", label: "Planned" },
];

// Both sections are rendered conditionally on being non-empty, so a filter
// that matches nothing left the column blank with no explanation — and that
// became reachable the moment the last stale `planned: true` was cleared.
// The sibling filtered lists (McpToolFilter, IntegrationsDirectory) both
// say so out loud; this now does too.
const EMPTY_COPY: Record<Filter, string> = {
  all: "No releases yet.",
  shipped: "No shipped releases yet.",
  planned: "Nothing pending — every release listed here has shipped.",
};

export function ChangelogList({
  entries,
}: {
  entries: ChangelogEntry[];
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");

  // Shipped first (reverse-chronological by date), then planned — so a planned
  // entry is never rendered above a dated shipped entry (MKTC-005).
  const { shipped, planned } = useMemo(() => {
    const s = entries
      .filter((e) => !e.planned)
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const p = entries.filter((e) => e.planned);
    return { shipped: s, planned: p };
  }, [entries]);

  const showShipped = filter !== "planned";
  const showPlanned = filter !== "shipped";
  const indexEntries = [
    ...(showShipped ? shipped : []),
    ...(showPlanned ? planned : []),
  ];

  return (
    <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-10">
      {/* Sticky version index + filter (jump navigation, MKTC-016) */}
      <aside className="mb-8 lg:mb-0">
        <div className="lg:sticky lg:top-20">
          <div
            role="group"
            aria-label="Filter releases"
            className="inline-flex rounded-md border border-pw-surface p-0.5"
          >
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`inline-flex min-h-11 items-center rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-0 [@media(pointer:coarse)]:min-h-11 ${
                  filter === f.key
                    ? "bg-pw-ember-500 text-white"
                    : "text-pw-muted-on-paper hover:text-pw-ink2"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <nav aria-label="Releases" className="mt-4 hidden lg:block">
            <ul className="space-y-1 text-sm">
              {indexEntries.map((e) => (
                <li key={e.version}>
                  <a
                    href={`#${e.version}`}
                    className="flex min-h-9 items-center justify-between gap-2 rounded px-1 py-1 text-pw-muted-on-paper transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 [@media(pointer:coarse)]:min-h-11"
                  >
                    <span>{e.version}</span>
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        e.planned ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                    />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </aside>

      <div className="space-y-12">
        {showShipped && shipped.length > 0 ? (
          <section aria-labelledby="shipped-heading">
            <h2
              id="shipped-heading"
              className="mb-5 text-xs font-semibold uppercase tracking-widest text-pw-muted-on-paper"
            >
              Shipped
            </h2>
            <div className="space-y-6">
              {shipped.map((e) => (
                <EntryCard key={e.version} entry={e} />
              ))}
            </div>
          </section>
        ) : null}

        {showPlanned && planned.length > 0 ? (
          <section aria-labelledby="planned-heading">
            <h2
              id="planned-heading"
              className="mb-5 text-xs font-semibold uppercase tracking-widest text-pw-muted-on-paper"
            >
              Planned / roadmap
            </h2>
            <div className="space-y-6">
              {planned.map((e) => (
                <EntryCard key={e.version} entry={e} />
              ))}
            </div>
          </section>
        ) : null}

        {indexEntries.length === 0 ? (
          <p className="text-sm text-pw-muted-on-paper">{EMPTY_COPY[filter]}</p>
        ) : null}
      </div>
    </div>
  );
}
