// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

export interface IntegrationCard {
  slug: string;
  name: string;
  category: string;
  summary: string;
}

/**
 * Short label for an integration avatar (MKTP-016).
 *
 * Multi-word names use the initials of the first two words, both uppercase
 * ("Microsoft Teams" → "MT", "Microsoft Dynamics 365" → "MD"), which resolved
 * an earlier first-two-letters collision ("MI" for both).
 *
 * Single-word names use the first two letters with the second lowercased
 * ("Salesforce" → "Sa"). That casing is what separates them from the two-word
 * form: "Snapchat Ads" is also S then A, and while both read "SA" they
 * collided in the catalog. A pure per-name function cannot guarantee global
 * uniqueness, so __tests__/avatar-labels.test.ts asserts the shipped catalog
 * stays collision-free as integrations are added.
 */
export function avatarLabel(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
  }
  const first = name.slice(0, 1).toUpperCase();
  const second = name.slice(1, 2).toLowerCase();
  return `${first}${second}`;
}

/**
 * Interactive integrations directory (MKTP-011): search by name/summary plus
 * category filter chips. The full grouped list renders server-side (empty
 * query, "All" category), so no-JS visitors still get every integration.
 */
export function IntegrationsDirectory({
  items,
  categories,
}: {
  items: IntegrationCard[];
  categories: string[];
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");
  const q = query.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (activeCat !== "all" && i.category !== activeCat) return false;
        if (!q) return true;
        return (
          i.name.toLowerCase().includes(q) ||
          i.summary.toLowerCase().includes(q)
        );
      }),
    [items, activeCat, q],
  );

  const grouped = useMemo(
    () =>
      categories
        .map((cat) => ({
          cat,
          list: filtered.filter((i) => i.category === cat),
        }))
        .filter((g) => g.list.length > 0),
    [categories, filtered],
  );

  return (
    <div>
      <div className="flex flex-col gap-4">
        <label className="relative block max-w-md">
          <span className="sr-only">Search integrations</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pw-muted-on-paper"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            className="min-h-11 w-full rounded-md border border-pw-line bg-pw-paper py-2.5 pl-9 pr-3 text-base text-pw-ink2 placeholder:text-pw-muted-on-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={activeCat === "all"}
            onClick={() => setActiveCat("all")}
            className={`inline-flex min-h-11 items-center rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-0 [@media(pointer:coarse)]:min-h-11 ${
              activeCat === "all"
                ? "border-pw-ember-500 bg-pw-ember-500/10 font-medium text-pw-ember-700"
                : "border-pw-surface text-pw-muted-on-paper hover:text-pw-ink2"
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              aria-pressed={activeCat === cat}
              onClick={() => setActiveCat(cat)}
              className={`inline-flex min-h-11 items-center rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-0 [@media(pointer:coarse)]:min-h-11 ${
                activeCat === cat
                  ? "border-pw-ember-500 bg-pw-ember-500/10 font-medium text-pw-ember-700"
                  : "border-pw-surface text-pw-muted-on-paper hover:text-pw-ink2"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
        <p className="text-xs text-pw-muted-on-paper">
          {filtered.length} of {items.length} integrations
        </p>
      </div>

      <div className="mt-10 space-y-16">
        {grouped.length === 0 ? (
          <p className="text-sm text-pw-muted-on-paper">
            No integrations match “{query}”.
          </p>
        ) : (
          grouped.map(({ cat, list }) => (
            <section key={cat} aria-labelledby={`cat-${cat.toLowerCase()}-heading`}>
              <div className="flex items-baseline justify-between">
                <h2
                  id={`cat-${cat.toLowerCase()}-heading`}
                  className="text-2xl font-semibold tracking-tight text-pw-ink2 md:text-3xl"
                >
                  {cat}
                </h2>
                <span className="font-mono text-xs text-pw-muted-on-paper">
                  {list.length} {list.length === 1 ? "integration" : "integrations"}
                </span>
              </div>
              <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((i) => (
                  <li key={i.slug}>
                    <Link
                      href={`/integrations/${i.slug}`}
                      className="block h-full rounded-lg border border-pw-ink2/10 bg-pw-paper p-5 transition-all hover:border-pw-ember-500 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden
                          className="flex h-9 w-9 items-center justify-center rounded-md border border-pw-line bg-pw-surface text-xs font-mono text-pw-ink2/70"
                        >
                          {avatarLabel(i.name)}
                        </span>
                        <span className="font-semibold text-pw-ink2">
                          {i.name}
                        </span>
                      </div>
                      <p className="mt-3 text-sm leading-relaxed text-pw-muted-on-paper">
                        {i.summary}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
