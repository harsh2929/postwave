// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

export interface FaqAccordionItem {
  question: string;
  answer: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Deep-linkable FAQ accordion (MKTC-014). Each question carries a stable id,
 * auto-opens when its hash is targeted, and the group has an "Expand all"
 * control. Answers stay in the DOM (hidden when collapsed) so crawlers and the
 * FAQ JSON-LD stay consistent, and a shared-link scrolls to the exact answer.
 */
export function FaqAccordion({
  items,
  idPrefix = "faq",
}: {
  items: FaqAccordionItem[];
  idPrefix?: string;
}): JSX.Element {
  const ids = items.map((item) => `${idPrefix}-${slugify(item.question)}`);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash && ids.includes(hash)) {
      setOpen((prev) => ({ ...prev, [hash]: true }));
      // Defer so the panel is expanded before scrolling to it.
      window.requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ block: "start" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allOpen = ids.length > 0 && ids.every((id) => open[id]);

  const toggleAll = (): void => {
    const next = !allOpen;
    setOpen(Object.fromEntries(ids.map((id) => [id, next])));
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={toggleAll}
          aria-expanded={allOpen}
          className="inline-flex min-h-11 items-center rounded px-1 text-xs font-medium text-pw-ember-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <div className="space-y-3">
        {items.map((item, i) => {
          const id = ids[i] as string;
          const panelId = `${id}-panel`;
          const buttonId = `${id}-trigger`;
          const isOpen = Boolean(open[id]);
          return (
            <div
              key={item.question}
              id={id}
              className="scroll-mt-24 rounded-lg border border-pw-ink2/10 bg-pw-paper px-5 py-4"
            >
              <h3 className="m-0">
                <button
                  type="button"
                  id={buttonId}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() =>
                    setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
                  }
                  className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                >
                  <span className="text-sm font-medium text-pw-ink2">
                    {item.question}
                  </span>
                  <span
                    aria-hidden
                    className={`shrink-0 font-mono text-sm text-pw-muted-on-paper/70 transition-transform motion-reduce:transition-none ${
                      isOpen ? "rotate-45" : ""
                    }`}
                  >
                    +
                  </span>
                </button>
              </h3>
              {/* aria-labelledby is what the ARIA accordion pattern requires
                  of a panel, and it was missing: role="region" with no name
                  puts an anonymous landmark in the rotor for every question.
                  Naming it by its own trigger is the pattern's answer. (The
                  authoring practices also suggest dropping the role entirely
                  past ~6 panels to avoid landmark proliferation; both callers
                  are at or below that, so the role stays and is now named.) */}
              <div
                id={panelId}
                role="region"
                aria-labelledby={buttonId}
                hidden={!isOpen}
                className="mt-3 text-sm leading-relaxed text-pw-muted-on-paper"
              >
                {item.answer}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
