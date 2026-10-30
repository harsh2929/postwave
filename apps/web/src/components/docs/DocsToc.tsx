// Moosewave docs - right-rail "On this page" table of contents (MKTN-010).
//
// The docs layout is a server component that renders arbitrary page children,
// so it has no direct access to each page's section ids. This client island
// derives the TOC from the rendered DOM instead: after mount it scans the
// `#docs-main` region for section/heading anchors and feeds them to the shared
// SectionNav scroll-spy primitive (variant="rail"), which mirrors the blog
// TOC pattern and marks the in-view section active as the reader scrolls.
//
// Hydration-safe: the list starts empty on the server and first client render
// and is only populated in an effect after mount.
"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  SectionNav,
  type SectionNavItem,
} from "@/components/marketing/section-nav";

export function DocsToc(): JSX.Element | null {
  const pathname = usePathname();
  const [items, setItems] = useState<SectionNavItem[]>([]);

  useEffect(() => {
    const main = document.getElementById("docs-main");
    if (!main) {
      setItems([]);
      return;
    }
    // Document order: sections that carry an id (getting-started) and any
    // headings that were assigned an id (e.g. rehype-slug on MDX pages).
    const nodes = Array.from(
      main.querySelectorAll<HTMLElement>("section[id], h2[id]"),
    );
    const seen = new Set<string>();
    const next: SectionNavItem[] = [];
    for (const node of nodes) {
      const id = node.id;
      if (!id || seen.has(id)) continue;
      const label =
        node.tagName === "SECTION"
          ? (node.querySelector("h2, h3")?.textContent?.trim() ?? "")
          : (node.textContent?.trim() ?? "");
      if (!label) continue;
      seen.add(id);
      next.push({ id, label });
    }
    setItems(next);
  }, [pathname]);

  if (items.length === 0) return null;

  return (
    <div className="text-sm">
      <div className="mb-3 pl-3 text-xs font-semibold uppercase tracking-wider text-pw-muted-on-paper">
        On this page
      </div>
      <SectionNav items={items} variant="rail" ariaLabel="On this page" />
    </div>
  );
}
