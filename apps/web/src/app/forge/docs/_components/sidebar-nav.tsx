// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

export function SidebarNav({
  sections,
}: {
  sections: { id: string; label: string }[];
}) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Documentation sidebar"
      className="-mx-4 mt-3 flex touch-pan-x gap-1 overflow-x-auto overscroll-x-contain px-4 md:mx-0 md:mt-4 md:flex-col md:overflow-visible md:px-0"
    >
      {sections.map((s) => {
        const isActive = active === s.id;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={isActive ? "true" : undefined}
            className="relative flex min-h-11 shrink-0 items-center rounded-sm bg-pw-ink px-2 font-mono text-xs text-white/60 transition-colors hover:text-pw-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-300 md:min-h-9 md:px-0"
          >
            {isActive && (
              <motion.div
                layoutId="forge-docs-active"
                className="absolute inset-x-2 bottom-0 h-[2px] bg-pw-ember-500 md:-left-3 md:inset-y-0 md:right-auto md:h-full md:w-[2px]"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
            <span className={isActive ? "text-pw-paper" : ""}>{s.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
