// Moosewave docs - simple breadcrumb trail.

import Link from "next/link";
import type { JSX } from "react";
import { asRoute } from "@/lib/typed-routes";

export interface BreadcrumbsProps {
  items: { label: string; href?: string }[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps): JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-pw-muted-on-paper">
      {/* An ordered list, because a breadcrumb IS a sequence and that sequence
          is the only information it carries. As a row of bare spans with
          aria-hidden separators, a screen reader read "Docs Migrations
          Mailchimp" as one undifferentiated run — no positions, no count, and
          nothing marking which entry is the page you are on. */}
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li
              key={`${item.label}-${i}`}
              className="min-w-0 max-w-full items-center gap-1.5 flex"
            >
              {item.href && !isLast ? (
                <Link
                  href={asRoute(item.href)}
                  className="inline-flex min-h-8 min-w-6 max-w-full items-center justify-center rounded-sm px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={`min-w-0 max-w-full break-all ${isLast ? "text-pw-ink2" : ""}`}
                >
                  {item.label}
                </span>
              )}
              {!isLast ? (
                <span aria-hidden className="text-pw-line">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
