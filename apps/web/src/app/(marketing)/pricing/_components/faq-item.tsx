// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

export function FaqItem({ q, a }: { q: string; a: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-pw-ink2/10 py-4">
      <button
        type="button"
        className="w-full text-left flex items-start justify-between gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 rounded"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
      >
        <span className="font-medium text-sm text-pw-ink2">{q}</span>
        <span
          className="text-pw-muted-on-paper/70 text-sm shrink-0 font-mono"
          aria-hidden
        >
          {open ? "-" : "+"}
        </span>
      </button>
      {open ? (
        <p className="mt-3 text-sm text-pw-muted-on-paper leading-relaxed">
          {a}
        </p>
      ) : null}
    </div>
  );
}
