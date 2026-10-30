// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";
import { nextRovingIndex } from "@/lib/roving-index";
import { CopyButton } from "@/components/marketing/copy-button";

export interface InstallTab {
  id: string;
  label: string;
  snippet: string;
  language?: string;
}

interface InstallTabsProps {
  tabs: readonly InstallTab[];
}

export function InstallTabs({ tabs }: InstallTabsProps): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const instanceId = useId().replaceAll(":", "");
  const currentIndex = Math.min(activeIndex, Math.max(0, tabs.length - 1));
  const current = tabs[currentIndex];

  // The tab buttons are present in the server HTML before React owns their
  // click handlers. Keep that brief pre-hydration island inert so a fast tap
  // is held by the browser instead of being accepted and silently discarded.
  useEffect(() => setHydrated(true), []);

  // role="tablist" is a promise about the keyboard: arrows move between tabs,
  // Home/End jump to the ends, and only the selected tab sits in the page tab
  // order. This declared the roles and implemented none of it, so a screen
  // reader announced "tab, 1 of 4" while the arrow keys did nothing and Tab
  // walked through every tab button instead of moving on to the panel. The
  // two dashboard tablists (template browser, design review) already do this.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextRovingIndex(event.key, currentIndex, tabs.length);
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  };

  if (!current) {
    return (
      <div
        role="status"
        className="rounded-xl border border-pw-line bg-pw-paper p-5 text-sm text-pw-muted-on-paper"
      >
        No install snippets are available.
      </div>
    );
  }

  return (
    <div
      data-install-tabs-hydrated={hydrated ? "true" : "false"}
      aria-busy={!hydrated || undefined}
      inert={hydrated ? undefined : true}
      className="min-w-0 overflow-hidden rounded-xl border border-pw-line bg-pw-paper"
    >
      <div
        role="tablist"
        aria-label="Install snippets"
        aria-orientation="horizontal"
        onKeyDown={onTabKeyDown}
        className="flex flex-wrap gap-1 border-b border-pw-line bg-pw-surface px-2 pt-2"
      >
        {tabs.map((t, i) => {
          const selected = i === currentIndex;
          const tabId = `install-tabs-${instanceId}-tab-${i}`;
          const panelId = `install-tabs-${instanceId}-panel-${i}`;
          return (
            <button
              key={`${t.id}-${i}`}
              ref={(node) => {
                tabRefs.current[i] = node;
              }}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={panelId}
              id={tabId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveIndex(i)}
              className={cn(
                "min-h-11 rounded-t-md border-b-2 px-3 py-2 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 motion-reduce:transition-none",
                selected
                  ? "bg-pw-paper border-pw-ember-500 text-pw-ink2"
                  : "border-transparent text-pw-muted-on-paper hover:text-pw-ink2",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`install-tabs-${instanceId}-panel-${currentIndex}`}
        aria-labelledby={`install-tabs-${instanceId}-tab-${currentIndex}`}
        className="relative min-w-0"
      >
        {/* Focusable for the same reason as CopyablePre: install snippets
            overflow horizontally and a scroll region that cannot take focus
            cannot be scrolled from the keyboard (WCAG 2.1.1). */}
        <pre
          tabIndex={0}
          role="group"
          aria-label={`${current.label} snippet`}
          className="m-0 overflow-x-auto bg-pw-paper py-5 pl-5 pr-28 font-mono text-xs text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:text-sm"
        >
          <code data-language={current.language}>{current.snippet}</code>
        </pre>
        <div className="absolute right-3 top-3">
          <CopyButton
            value={current.snippet}
            label="Copy"
            className="min-h-11"
          />
        </div>
      </div>
    </div>
  );
}
