// SPDX-License-Identifier: AGPL-3.0-only
//
// Mobile/tablet docs navigation. The desktop sidebar is `hidden lg:block`, so
// below the lg breakpoint the entire docs nav (API tags, skills, migrations,
// integrations) was otherwise unreachable. This hamburger opens a slide-over
// drawer that reuses the same Sidebar.
//
// Built on Radix Dialog (the Sidebar's own header comment names this as the
// intended approach): it gives the focus trap, initial focus, focus restore
// to the trigger, Escape, body scroll-lock, and background inert/aria-hidden
// for free — and it portals to <body>, so the header's `backdrop-blur`
// (a backdrop-filter containing block) can't trap the fixed positioning.
"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";

import { Sidebar } from "./Sidebar";

export function DocsMobileNav(): JSX.Element {
  const [open, setOpen] = useState(false);

  // If the viewport grows to lg while the drawer is open, close it: the
  // hamburger is `lg:hidden`, so otherwise there'd be no control to dismiss it
  // and the body scroll-lock would persist.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (): void => {
      if (mq.matches) setOpen(false);
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open documentation navigation"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-pw-ink2 hover:bg-pw-line/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="mw-docs-drawer-overlay fixed inset-0 z-50 bg-pw-ink/40 backdrop-blur-sm motion-reduce:animate-none lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="mw-docs-drawer-panel fixed left-0 top-0 z-50 flex h-dvh max-h-dvh w-[min(20rem,calc(100vw-3rem))] overscroll-contain flex-col overflow-y-auto border-r border-pw-line bg-pw-paper p-4 shadow-xl motion-reduce:animate-none focus:outline-none lg:hidden"
        >
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="font-semibold tracking-tight text-pw-ink2">
              Documentation
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close navigation"
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-pw-muted-on-paper hover:bg-pw-line/50 hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          {/* Close once a nav link is followed — but ignore collapsible
              group-toggle buttons so expanding a group doesn't dismiss. */}
          <div
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) setOpen(false);
            }}
          >
            <Sidebar />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
