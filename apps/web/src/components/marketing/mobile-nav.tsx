// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { asRoute } from "@/lib/typed-routes";

export type MarketingNavLink = {
  href: string;
  label: string;
};

export function MarketingMobileNav({
  primaryLinks,
  productLinks,
}: {
  primaryLinks: MarketingNavLink[];
  productLinks: MarketingNavLink[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // Move focus into the panel on open so keyboard/AT users land inside it.
    const focusables = (): HTMLElement[] =>
      panelRef.current
        ? Array.from(
            panelRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    focusables()[0]?.focus();

    // Lock body scroll while the panel is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      // Trap Tab within the panel.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Captured now rather than read in the cleanup: by cleanup time the ref may
    // point at a different (or detached) node.
    const trigger = triggerRef.current;

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      // The panel is conditionally rendered, so unmounting it drops focus to
      // <body>. That is the only case where pulling focus back to the trigger
      // is correct — if the user (or a navigation) already moved focus
      // somewhere real, stealing it back would be a WCAG 2.4.3 violation.
      const active = document.activeElement;
      if (active == null || active === document.body) trigger?.focus();
    };
  }, [open]);

  const close = (): void => setOpen(false);

  return (
    <div className="md:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-pw-surface text-pw-ink2 transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        {open ? (
          <X aria-hidden className="h-4 w-4" />
        ) : (
          <Menu aria-hidden className="h-4 w-4" />
        )}
      </button>
      {open ? (
        <>
          {/* Scrim: tapping outside the panel closes it. */}
          <div
            className="fixed inset-0 top-20 z-40 bg-pw-ink/20 md:hidden"
            aria-hidden
            onClick={close}
          />
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Site navigation"
            // The open panel sets body { overflow: hidden }, so it has to own
            // its own scrolling: seventeen links do not fit under a 56px header
            // on a phone in landscape (~334px of usable height), and without a
            // cap the overflow was simply unreachable — "Sign in", the last
            // item, first. dvh rather than vh because mobile Safari's vh is the
            // *largest* viewport, which is the height this needs to not assume.
            className="fixed inset-x-0 top-20 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain border-b border-pw-surface bg-pw-paper shadow-lg md:hidden"
          >
            <nav
              aria-label="Mobile primary"
              className="mx-auto grid max-w-6xl gap-5 px-4 py-5 text-sm sm:px-6"
            >
              <div className="grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-pw-muted-on-paper">
                  Product
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {productLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={asRoute(item.href)}
                      onClick={close}
                      className="inline-flex min-h-11 items-center rounded-md px-2 py-2 text-pw-ink2 transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="grid gap-1">
                {primaryLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={asRoute(item.href)}
                    onClick={close}
                    className="inline-flex min-h-11 items-center rounded-md px-2 py-2 font-medium text-pw-ink2 transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                  >
                    {item.label}
                  </Link>
                ))}
                <Link
                  href="/login"
                  onClick={close}
                  className="inline-flex min-h-11 items-center rounded-md px-2 py-2 font-medium text-pw-ink2 transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                >
                  Sign in
                </Link>
              </div>
            </nav>
          </div>
        </>
      ) : null}
    </div>
  );
}
