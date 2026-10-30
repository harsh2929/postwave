// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Search box for the /mcp tool catalogue (MKTP-010, RSC-04).
 *
 * The catalogue is server-rendered — grouped by category — in the
 * document already. The earlier version handed the same catalogue objects to a
 * client component as props so it could re-render a filtered copy, which meant the
 * /mcp document carried the whole catalogue twice: once as HTML and once as
 * ~57 KB of flight data, paid for by every visitor including the ones who never
 * type anything.
 *
 * So this island holds no catalogue at all. It filters the rows the server
 * already rendered, reading each row's own text as the haystack and toggling
 * `hidden` — the same substring match on name and description, over the same
 * data, without a second copy of it. No-JS visitors keep the full list, exactly
 * as before.
 */

const ROW = "[data-mcp-tool]";
const SECTION = "[data-mcp-category]";
const CHIP = "[data-mcp-chip]";

export function McpToolFilter({ total }: { total: number }): JSX.Element {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(total);
  const [ready, setReady] = useState(false);
  // Row text is stable for the life of the page; read it once.
  const haystacks = useRef<Map<Element, string> | null>(null);

  const apply = useCallback((raw: string) => {
    const root = document.getElementById("mcp-tool-catalogue");
    if (!root) return;
    if (!haystacks.current) {
      haystacks.current = new Map(
        [...root.querySelectorAll(ROW)].map((el) => [
          el,
          (el.textContent ?? "").toLowerCase(),
        ]),
      );
    }
    const q = raw.trim().toLowerCase();
    let shown = 0;
    for (const [el, hay] of haystacks.current) {
      const match = !q || hay.includes(q);
      (el as HTMLElement).hidden = !match;
      if (match) shown += 1;
    }
    // A category with nothing left in it, and its jump-chip, go away too.
    const counts = new Map<string, number>();
    for (const section of root.querySelectorAll(SECTION)) {
      const key = section.getAttribute("data-mcp-category") ?? "";
      const n = [...section.querySelectorAll(ROW)].filter(
        (el) => !(el as HTMLElement).hidden,
      ).length;
      counts.set(key, n);
      (section as HTMLElement).hidden = n === 0;
    }
    for (const chip of document.querySelectorAll(CHIP)) {
      const key = chip.getAttribute("data-mcp-chip") ?? "";
      const n = counts.get(key) ?? 0;
      (chip as HTMLElement).hidden = n === 0;
      const badge = chip.querySelector("[data-mcp-chip-count]");
      if (badge) badge.textContent = String(n);
    }
    setVisible(shown);
  }, []);

  // Nothing is filtered until the script runs, so the empty-state message must
  // not exist before then either.
  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <>
      <label className="relative block">
        <span className="sr-only">Search tools</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pw-muted-on-paper"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            apply(e.target.value);
          }}
          placeholder="Search tools by name or description…"
          className="min-h-11 w-full rounded-md border border-pw-line bg-pw-paper py-2.5 pl-9 pr-3 text-base text-pw-ink2 placeholder:text-pw-muted-on-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:text-sm"
        />
      </label>
      <p
        aria-live="polite"
        className="mt-3 shrink-0 text-right text-xs text-pw-muted-on-paper"
      >
        {visible} of {total}
        {ready && visible === 0 ? (
          <span className="ml-2 text-pw-ink2">No tools match “{query}”.</span>
        ) : null}
      </p>
    </>
  );
}
