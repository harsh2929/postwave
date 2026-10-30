// SPDX-License-Identifier: AGPL-3.0-only
//
// Web presence indicator (dim 5 — presence beyond desktop). A small avatar
// stack of the other people currently in the workspace, mirroring desktop's
// PresenceIndicator. Renders nothing when you're alone, so it's invisible until
// it matters. Clicking it opens a popover listing who's online (SHELL-036).
"use client";

import { useRef, useState } from "react";

import { usePresence, summarizePresence } from "@/lib/realtime/use-presence";
import { useDisclosure } from "@/lib/use-disclosure";
import { cn } from "@/lib/utils";

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function PresenceIndicator({ className }: { className?: string } = {}) {
  const presence = usePresence();
  const { viewers, others } = summarizePresence(presence);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useDisclosure({
    open,
    setOpen,
    triggerRef,
    panelRef,
    focusPanelOnOpen: true,
  });

  // Only me (or unknown) — show nothing.
  if (others <= 0) return null;

  const extra = others - viewers.length;
  const summary = `${others} other ${others === 1 ? "person" : "people"} online`;

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="presence-indicator"
        aria-label={summary}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center -space-x-1.5 rounded-full p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {viewers.map((v, i) => (
          <span
            key={v.id ?? `${v.label}-${i}`}
            aria-hidden
            className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground"
          >
            {initials(v.label ?? "?")}
          </span>
        ))}
        {extra > 0 || viewers.length === 0 ? (
          <span
            aria-hidden
            className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-primary/15 text-[10px] font-medium text-primary"
          >
            +{viewers.length === 0 ? others : extra}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Who’s online"
          className="absolute right-0 top-full z-50 mt-2 max-h-[calc(100dvh-4.5rem)] w-[min(15rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-md border bg-popover p-2 text-popover-foreground shadow-lg"
          tabIndex={-1}
        >
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            {summary}
          </p>
          {viewers.length > 0 ? (
            <ul className="max-h-[min(16rem,calc(100dvh-9rem))] overflow-auto">
              {viewers.map((v, i) => (
                <li
                  key={v.id ?? `${v.label}-${i}`}
                  className="flex items-center gap-2 rounded px-2 py-1.5"
                >
                  <span
                    aria-hidden
                    className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
                  >
                    {initials(v.label ?? "?")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {v.label ?? "Teammate"}
                  </span>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-success"
                    aria-label="online"
                  />
                </li>
              ))}
              {extra > 0 ? (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">
                  +{extra} more online
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {others} online
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
