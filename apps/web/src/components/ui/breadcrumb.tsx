// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { Route } from "next";
import { cn } from "@/lib/utils";

/**
 * Shared breadcrumb primitive: a semantic `<nav aria-label="Breadcrumb">` with
 * an ordered list and `aria-current="page"` on the trailing crumb. Replaces the
 * hand-rolled `<Link/> + "/" + <span/>` markup so trails are consistent and
 * screen-reader-navigable across pages.
 */
export interface Crumb {
  label: string;
  href?: Route;
}

export function Breadcrumb({
  items,
  className,
}: {
  items: Crumb[];
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      data-slot="breadcrumb"
      className={cn("min-w-0 overflow-hidden", className)}
    >
      <ol className="flex w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li
              key={`${item.label}-${i}`}
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                isLast ? "flex-1" : "shrink",
              )}
            >
              {i > 0 ? (
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 opacity-60"
                  aria-hidden
                />
              ) : null}
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center overflow-hidden rounded-md outline-none hover:text-mw-blue focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0 sm:min-w-0"
                >
                  <span className="truncate">{item.label}</span>
                </Link>
              ) : (
                <span
                  className={cn(
                    "block min-w-0 truncate",
                    isLast && "text-foreground",
                  )}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
