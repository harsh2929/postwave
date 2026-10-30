// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export interface SectionNavItem {
  id: string;
  label: string;
}

/**
 * Shared in-page section navigation with scroll-spy (MKTN-013 / MKTN-017).
 * Renders anchor links to on-page section ids and marks the in-view section
 * active via IntersectionObserver, so long marketing pages (security,
 * podcasts, blog) get consistent wayfinding instead of hand-rolled or missing
 * navs.
 *
 * Hydration-safe: the server and the client's first render both start with no
 * active item; the active state is only computed in an effect after mount.
 */
export function SectionNav({
  items,
  variant = "horizontal",
  ariaLabel = "On this page",
  className,
}: {
  items: SectionNavItem[];
  variant?: "horizontal" | "rail";
  ariaLabel?: string;
  className?: string;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const sections = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Pick the first section (in document order) currently in view.
        const firstVisible = items.find((i) => visible.has(i.id));
        if (firstVisible) setActiveId(firstVisible.id);
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [items]);

  if (variant === "rail") {
    return (
      <nav aria-label={ariaLabel} className={className}>
        <ul className="space-y-1 text-sm">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex min-h-9 items-center rounded-md border-l-2 py-1 pl-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 [@media(pointer:coarse)]:min-h-11",
                    active
                      ? "border-pw-ember-500 font-medium text-pw-ink2"
                      : "border-transparent text-pw-muted-on-paper hover:text-pw-ink2",
                  )}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label={ariaLabel} className={className}>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-0 [@media(pointer:coarse)]:min-h-11",
                  active
                    ? "border-pw-ember-500 bg-pw-ember-500/10 font-medium text-pw-ember-700"
                    : "border-pw-surface text-pw-muted-on-paper hover:border-pw-ember-500 hover:text-pw-ink2",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
